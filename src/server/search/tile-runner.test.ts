import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BoundingBox } from "@/lib/geo/bbox";
import { QuotaBlockedError, type QuotaClient } from "@/server/quota/quota-service";

import { fetchTilePage } from "./tile-runner";

/**
 * The catalog really is unverified, and the reserve guard really does refuse
 * while it is -- which is one of the cases under test. A hoisted flag lets the
 * granted and denied paths be exercised too, without editing catalog.json.
 */
const state = vi.hoisted(() => ({ verified: true }));

vi.mock("@/server/pricing/pricing-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/pricing/pricing-service")>();
  return { ...actual, isVerified: () => state.verified };
});

const SKU = "places-text-search-enterprise";
const BBOX: BoundingBox = { minLat: 29.74, minLng: -95.38, maxLat: 29.77, maxLng: -95.35 };

const ARGS = {
  sku: SKU,
  searchId: "11111111-1111-4111-8111-111111111111",
  tileId: "22222222-2222-4222-8222-222222222222",
  textQuery: "Embroidery Shops",
  bbox: BBOX,
  pageIndex: 0,
};

type RpcCall = { name: string; args: Record<string, unknown> };

/**
 * A Supabase stand-in that records the exact sequence of RPCs. The ORDER is the
 * property under test: nothing may reach Google before reserve_api_calls has
 * granted.
 */
function fakeDb(options: { grants?: boolean[] } = {}) {
  const calls: RpcCall[] = [];
  let reserveIndex = 0;

  const db = {
    rpc: (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });

      if (name === "reserve_api_calls") {
        const granted = options.grants?.[reserveIndex] ?? true;
        reserveIndex += 1;
        return Promise.resolve({
          data: [
            {
              granted,
              used: granted ? 1 : 950,
              remaining: granted ? 949 : 0,
              period: "2026-08",
              effective_limit: 950,
            },
          ],
          error: null,
        });
      }

      if (name === "release_api_calls") return Promise.resolve({ data: 0, error: null });
      if (name === "record_api_call") return Promise.resolve({ data: 1, error: null });
      return Promise.resolve({ data: null, error: null });
    },
  };

  return { db: db as unknown as QuotaClient, calls };
}

const OK_BODY = {
  places: [{ id: "ChIJ1", displayName: { text: "Shop One" } }],
};

function stubFetch(responses: Array<{ status: number; body: unknown } | "network-error">) {
  let index = 0;
  const impl = vi.fn(async () => {
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next === "network-error") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  });
  return { impl: impl as unknown as typeof fetch, calledTimes: () => index };
}

const noSleep = async () => {};

beforeEach(() => {
  state.verified = true;
});

describe("reservation comes first", () => {
  it("reserves before it calls Google, every time", async () => {
    const { db, calls } = fakeDb();
    const { impl } = stubFetch([{ status: 200, body: OK_BODY }]);

    const result = await fetchTilePage(ARGS, { db, fetchImpl: impl, sleep: noSleep });

    expect(result.kind).toBe("ok");
    // The very first thing that happened was the budget guard.
    expect(calls[0].name).toBe("reserve_api_calls");
    expect(calls[0].args).toMatchObject({ p_sku: SKU, p_n: 1 });
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it("reserves ONE call per page, because Google bills per page", async () => {
    const { db, calls } = fakeDb();
    const { impl } = stubFetch([{ status: 200, body: OK_BODY }]);

    await fetchTilePage(ARGS, { db, fetchImpl: impl, sleep: noSleep });

    const reserves = calls.filter((c) => c.name === "reserve_api_calls");
    expect(reserves).toHaveLength(1);
    expect(reserves[0].args.p_n).toBe(1);
  });

  it("makes NO Google request when the reservation is denied", async () => {
    const { db, calls } = fakeDb({ grants: [false] });
    const { impl } = stubFetch([{ status: 200, body: OK_BODY }]);

    const result = await fetchTilePage(ARGS, { db, fetchImpl: impl, sleep: noSleep });

    expect(result.kind).toBe("quota-denied");
    expect(impl).not.toHaveBeenCalled();
    expect(result.callsMade).toBe(0);
    // A denial is a normal outcome, not an error, and nothing was recorded.
    expect(calls.filter((c) => c.name === "record_api_call")).toHaveLength(0);
  });

  it("reports what remains, so the tile can say why it was skipped", async () => {
    const { db } = fakeDb({ grants: [false] });
    const { impl } = stubFetch([{ status: 200, body: OK_BODY }]);

    const result = await fetchTilePage(ARGS, { db, fetchImpl: impl, sleep: noSleep });

    expect(result).toMatchObject({ kind: "quota-denied", remaining: 0, period: "2026-08" });
  });

  it("refuses outright while the pricing catalog is unverified", async () => {
    state.verified = false;
    const { db, calls } = fakeDb();
    const { impl } = stubFetch([{ status: 200, body: OK_BODY }]);

    await expect(fetchTilePage(ARGS, { db, fetchImpl: impl, sleep: noSleep })).rejects.toThrow(
      QuotaBlockedError,
    );

    // Stopped before Postgres and before Google.
    expect(impl).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});

describe("recording and refunds", () => {
  it("records a successful call as billable", async () => {
    const { db, calls } = fakeDb();
    const { impl } = stubFetch([{ status: 200, body: OK_BODY }]);

    await fetchTilePage(ARGS, { db, fetchImpl: impl, sleep: noSleep });

    const record = calls.find((c) => c.name === "record_api_call");
    expect(record?.args).toMatchObject({
      p_sku: SKU,
      p_billable: true,
      p_http_status: 200,
      p_result_count: 1,
      p_search_id: ARGS.searchId,
      p_tile_id: ARGS.tileId,
      p_page_index: 0,
    });
    expect(calls.filter((c) => c.name === "release_api_calls")).toHaveLength(0);
  });

  it("refunds a network failure, which Google never metered", async () => {
    const { db, calls } = fakeDb();
    const { impl } = stubFetch(["network-error"]);

    const result = await fetchTilePage(ARGS, {
      db,
      fetchImpl: impl,
      sleep: noSleep,
      maxAttempts: 1,
    });

    expect(result.kind).toBe("error");
    expect(calls.filter((c) => c.name === "release_api_calls")).toHaveLength(1);
    expect(result.callsMade).toBe(0);

    const record = calls.find((c) => c.name === "record_api_call");
    expect(record?.args.p_billable).toBe(false);
  });

  it("does NOT refund an HTTP error, which may have been metered", async () => {
    // The local counter is an estimate; over-counting against ourselves is the
    // safe direction, and the reserve exists to absorb exactly this drift.
    const { db, calls } = fakeDb();
    const { impl } = stubFetch([{ status: 400, body: { error: { message: "bad mask" } } }]);

    const result = await fetchTilePage(ARGS, { db, fetchImpl: impl, sleep: noSleep });

    expect(result.kind).toBe("error");
    expect(calls.filter((c) => c.name === "release_api_calls")).toHaveLength(0);
    expect(result.callsMade).toBe(1);
  });
});

describe("bounded retries", () => {
  it("makes NO retry by default, because Phase 3A allows exactly one call", async () => {
    // The cap lives in PHASE_3A_LIMITS, so every caller inherits it -- the API
    // route, the Run button and any script alike. The cases below pass
    // maxAttempts explicitly to exercise mechanics Phase 3B will rely on.
    const { db, calls } = fakeDb();
    const { impl } = stubFetch([{ status: 500, body: { error: { message: "boom" } } }]);

    const result = await fetchTilePage(ARGS, { db, fetchImpl: impl, sleep: noSleep });

    expect(result.kind).toBe("error");
    expect(impl).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.name === "reserve_api_calls")).toHaveLength(1);
  });

  it("does not retry a 400", async () => {
    const { db, calls } = fakeDb();
    const { impl } = stubFetch([{ status: 400, body: { error: { message: "bad request" } } }]);

    const result = await fetchTilePage(ARGS, { db, fetchImpl: impl, sleep: noSleep });

    expect(result.kind).toBe("error");
    expect(impl).toHaveBeenCalledTimes(1);
    // One attempt means one reservation. Retrying would spend the allowance to
    // receive the identical rejection.
    expect(calls.filter((c) => c.name === "reserve_api_calls")).toHaveLength(1);
  });

  for (const status of [401, 403, 404]) {
    it(`does not retry a ${status}`, async () => {
      const { db } = fakeDb();
      const { impl } = stubFetch([{ status, body: { error: { message: "nope" } } }]);

      const result = await fetchTilePage(ARGS, { db, fetchImpl: impl, sleep: noSleep });

      expect(result.kind).toBe("error");
      expect(impl).toHaveBeenCalledTimes(1);
    });
  }

  it("retries a 429 and succeeds on the second attempt", async () => {
    const { db, calls } = fakeDb();
    const { impl } = stubFetch([
      { status: 429, body: { error: { message: "slow down" } } },
      { status: 200, body: OK_BODY },
    ]);

    const result = await fetchTilePage(ARGS, { db, fetchImpl: impl, sleep: noSleep, maxAttempts: 3 });

    expect(result.kind).toBe("ok");
    expect(impl).toHaveBeenCalledTimes(2);
    // Two attempts, two reservations: a retry is a second billable request and
    // must pass through the guard again.
    expect(calls.filter((c) => c.name === "reserve_api_calls")).toHaveLength(2);
    if (result.kind === "ok") {
      expect(result.callsMade).toBe(2);
      expect(result.attempts).toBe(2);
    }
  });

  it("retries a 500 up to the attempt ceiling and then gives up", async () => {
    const { db, calls } = fakeDb();
    const { impl } = stubFetch([{ status: 500, body: { error: { message: "boom" } } }]);

    const result = await fetchTilePage(ARGS, { db, fetchImpl: impl, sleep: noSleep, maxAttempts: 3 });

    expect(result.kind).toBe("error");
    expect(impl).toHaveBeenCalledTimes(3);
    expect(calls.filter((c) => c.name === "reserve_api_calls")).toHaveLength(3);
    if (result.kind === "error") expect(result.attempts).toBe(3);
  });

  it("stops retrying the moment a reservation is denied", async () => {
    // Never retry a request whose reservation did not succeed.
    const { db } = fakeDb({ grants: [true, false] });
    const { impl } = stubFetch([{ status: 500, body: { error: { message: "boom" } } }]);

    const result = await fetchTilePage(ARGS, { db, fetchImpl: impl, sleep: noSleep, maxAttempts: 3 });

    expect(result.kind).toBe("quota-denied");
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it("never exceeds the Phase 3A attempt ceiling", async () => {
    const { db, calls } = fakeDb();
    const { impl } = stubFetch(["network-error"]);

    await fetchTilePage(ARGS, { db, fetchImpl: impl, sleep: noSleep, maxAttempts: 3 });

    expect(impl).toHaveBeenCalledTimes(3);
    expect(calls.filter((c) => c.name === "reserve_api_calls").length).toBeLessThanOrEqual(3);
  });
});

describe("the request itself", () => {
  it("sends the tile rectangle and the niche alone", async () => {
    const { db } = fakeDb();
    let sentBody: Record<string, unknown> = {};

    const impl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(OK_BODY), { status: 200 });
    }) as unknown as typeof fetch;

    await fetchTilePage(ARGS, { db, fetchImpl: impl, sleep: noSleep });

    expect(sentBody.textQuery).toBe("Embroidery Shops");
    expect(sentBody.locationRestriction).toEqual({
      rectangle: {
        low: { latitude: BBOX.minLat, longitude: BBOX.minLng },
        high: { latitude: BBOX.maxLat, longitude: BBOX.maxLng },
      },
    });
  });

  it("keeps every parameter identical across a retry", async () => {
    // Google rejects a page token presented with any other parameter changed.
    const { db } = fakeDb();
    const bodies: string[] = [];

    const impl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify({ error: { message: "rate" } }), { status: 429 });
    }) as unknown as typeof fetch;

    await fetchTilePage(
      { ...ARGS, pageToken: "tok-1" },
      { db, fetchImpl: impl, sleep: noSleep, maxAttempts: 3 },
    );

    expect(bodies.length).toBeGreaterThan(1);
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]).pageToken).toBe("tok-1");
  });
});
