import { beforeEach, describe, expect, it, vi } from "vitest";

import * as catalogPricing from "@/server/pricing/pricing-service";

import {
  QuotaBlockedError,
  QuotaError,
  getAllQuotaSnapshots,
  getPeriodKey,
  getQuotaSnapshot,
  recordCall,
  releaseCalls,
  reserveCalls,
  type QuotaClient,
} from "./quota-service";

/**
 * The pricing catalog really is unverified, and the reserve guard really does
 * block on that -- which is most of what these tests check. One hoisted flag
 * lets the granted/denied paths be exercised too, without touching the catalog
 * file or pretending Phase 2 is verified.
 */
const state = vi.hoisted(() => ({ verified: false }));

vi.mock("@/server/pricing/pricing-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/pricing/pricing-service")>();
  return { ...actual, isVerified: () => state.verified };
});

type RpcCall = { name: string; args: Record<string, unknown> };

/** A Supabase stand-in that records what the service asked Postgres to do. */
function fakeDb(responses: Record<string, { data?: unknown; error?: { message: string } }>) {
  const calls: RpcCall[] = [];
  const db = {
    rpc: (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      const response = responses[name] ?? { data: null };
      return Promise.resolve({ data: response.data ?? null, error: response.error ?? null });
    },
  };
  return { db: db as unknown as QuotaClient, calls };
}

const ENTERPRISE = "places-text-search-enterprise";

beforeEach(() => {
  state.verified = false;
});

describe("getQuotaSnapshot", () => {
  it("hands SQL the limit, the reserve and the billing timezone from the catalog", () => {
    const { db, calls } = fakeDb({
      quota_snapshot: {
        data: [
          {
            period: "2026-08",
            sku: ENTERPRISE,
            used: 412,
            free_limit: 1000,
            reserve: 50,
            effective_limit: 950,
            remaining: 538,
          },
        ],
      },
    });

    return getQuotaSnapshot(ENTERPRISE, { db }).then((snapshot) => {
      const config = catalogPricing.getSkuConfig(ENTERPRISE);

      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("quota_snapshot");
      expect(calls[0].args).toEqual({
        p_sku: ENTERPRISE,
        p_free_limit: config.freeCallsPerMonth,
        p_reserve: config.reserve,
        p_tz: catalogPricing.getBillingTimezone(),
      });
      // The database holds no Google number of its own: everything travels in
      // as an argument, so the two can never drift apart.
      expect(calls[0].args.p_tz).not.toBe("UTC");

      expect(snapshot.used).toBe(412);
      expect(snapshot.remaining).toBe(538);
      expect(snapshot.effectiveLimit).toBe(950);
      expect(snapshot.health).toBe("healthy");
      // Pricing is unverified, so the displayable state says so.
      expect(snapshot.state).toBe("unverified");
    });
  });

  it("treats a missing counter row as zero calls made", async () => {
    const { db } = fakeDb({ quota_snapshot: { data: [] } });
    const snapshot = await getQuotaSnapshot(ENTERPRISE, { db });

    expect(snapshot.used).toBe(0);
    expect(snapshot.remaining).toBe(snapshot.effectiveLimit);
    expect(snapshot.period).toBe(getPeriodKey());
  });

  it("raises rather than reporting a comfortable zero when the read fails", async () => {
    const { db } = fakeDb({ quota_snapshot: { error: { message: "connection reset" } } });
    await expect(getQuotaSnapshot(ENTERPRISE, { db })).rejects.toThrow(QuotaError);
  });

  it("reports exhaustion when the counter has passed the ceiling", async () => {
    const { db } = fakeDb({
      quota_snapshot: {
        data: [{ period: "2026-08", sku: ENTERPRISE, used: 1200, remaining: 0 }],
      },
    });
    const snapshot = await getQuotaSnapshot(ENTERPRISE, { db });

    expect(snapshot.health).toBe("exhausted");
    expect(snapshot.remaining).toBe(0);
    expect(snapshot.protectedRemaining).toBeLessThan(0);
  });
});

describe("getAllQuotaSnapshots", () => {
  it("covers every catalog SKU and leads with the search SKU", async () => {
    const { db } = fakeDb({ quota_snapshot: { data: [] } });
    const snapshots = await getAllQuotaSnapshots({ db });

    expect(snapshots.map((s) => s.sku).sort()).toEqual(catalogPricing.listSkuIds().sort());
    expect(snapshots[0].sku).toBe(catalogPricing.getPrimarySku());
  });
});

describe("reserveCalls", () => {
  it("refuses outright while the pricing catalog is unverified", async () => {
    const { db, calls } = fakeDb({});

    await expect(reserveCalls({ sku: ENTERPRISE, calls: 1 }, { db })).rejects.toThrow(
      QuotaBlockedError,
    );
    // The guard must stop BEFORE Postgres, so an unverified catalog can never
    // authorise a Google request.
    expect(calls).toHaveLength(0);
  });

  it("passes the catalog numbers to the atomic SQL guard once verified", async () => {
    state.verified = true;
    const { db, calls } = fakeDb({
      reserve_api_calls: {
        data: [{ granted: true, used: 3, remaining: 947, period: "2026-08", effective_limit: 950 }],
      },
    });

    // Each PAGE of a Text Search response is a separate billable call, so a
    // fully paginated tile reserves three.
    const result = await reserveCalls({ sku: ENTERPRISE, calls: 3 }, { db });
    const config = catalogPricing.getSkuConfig(ENTERPRISE);

    expect(calls[0].name).toBe("reserve_api_calls");
    expect(calls[0].args).toEqual({
      p_sku: ENTERPRISE,
      p_n: 3,
      p_free_limit: config.freeCallsPerMonth,
      p_reserve: config.reserve,
      p_tz: catalogPricing.getBillingTimezone(),
    });
    expect(result.granted).toBe(true);
    expect(result.remaining).toBe(947);
  });

  it("reports a denial as a denial, not as an error", async () => {
    state.verified = true;
    const { db } = fakeDb({
      reserve_api_calls: {
        data: [
          { granted: false, used: 950, remaining: 0, period: "2026-08", effective_limit: 950 },
        ],
      },
    });

    const result = await reserveCalls({ sku: ENTERPRISE, calls: 3 }, { db });
    expect(result.granted).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("fails closed when the guard returns no row", async () => {
    state.verified = true;
    const { db } = fakeDb({ reserve_api_calls: { data: [] } });
    // No row must never be read as a grant.
    await expect(reserveCalls({ sku: ENTERPRISE, calls: 1 }, { db })).rejects.toThrow(QuotaError);
  });

  it("fails closed on a database error", async () => {
    state.verified = true;
    const { db } = fakeDb({ reserve_api_calls: { error: { message: "deadlock detected" } } });
    await expect(reserveCalls({ sku: ENTERPRISE, calls: 1 }, { db })).rejects.toThrow(QuotaError);
  });

  it("rejects a non-positive or fractional reservation", async () => {
    state.verified = true;
    const { db } = fakeDb({});
    for (const calls of [0, -1, 1.5]) {
      await expect(reserveCalls({ sku: ENTERPRISE, calls }, { db })).rejects.toThrow(QuotaError);
    }
  });
});

describe("releaseCalls and recordCall", () => {
  it("refunds a reservation that produced no billable response", async () => {
    const { db, calls } = fakeDb({ release_api_calls: { data: 7 } });
    const remaining = await releaseCalls({ sku: ENTERPRISE, calls: 1 }, { db });

    expect(calls[0].name).toBe("release_api_calls");
    expect(calls[0].args.p_tz).toBe(catalogPricing.getBillingTimezone());
    expect(remaining).toBe(7);
  });

  it("logs a call with its billing period derived in SQL from the same timezone", async () => {
    const { db, calls } = fakeDb({ record_api_call: { data: 42 } });
    const id = await recordCall(
      { sku: ENTERPRISE, endpoint: "places:searchText", pageIndex: 0, httpStatus: 200 },
      { db },
    );

    expect(id).toBe(42);
    expect(calls[0].args.p_sku).toBe(ENTERPRISE);
    expect(calls[0].args.p_tz).toBe(catalogPricing.getBillingTimezone());
    expect(calls[0].args.p_billable).toBe(true);
  });

  it("surfaces a logging failure instead of swallowing it", async () => {
    const { db } = fakeDb({ record_api_call: { error: { message: "no such function" } } });
    await expect(recordCall({ sku: ENTERPRISE, endpoint: "x" }, { db })).rejects.toThrow(
      QuotaError,
    );
  });
});
