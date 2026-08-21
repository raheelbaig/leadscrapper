import { beforeEach, describe, expect, it, vi } from "vitest";

import type { QuotaClient } from "@/server/quota/quota-service";

import { PHASE_3A_LIMITS } from "./limits";
import { PRICING_BLOCK, SearchBlockedError, runPreflight } from "./preflight";

const state = vi.hoisted(() => ({ verified: false }));

vi.mock("@/server/pricing/pricing-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/pricing/pricing-service")>();
  return {
    ...actual,
    isVerified: () => state.verified,
    // Kept in step with isVerified so the reported status and the gate decision
    // never disagree, exactly as they cannot disagree in production.
    getStalenessInfo: () => ({
      ...actual.getStalenessInfo(),
      verified: state.verified,
      stale: !state.verified,
    }),
  };
});

/** Answers quota_snapshot with a chosen `used` figure. */
function fakeDb(used: number) {
  return {
    rpc: (name: string, args: Record<string, unknown>) => {
      if (name === "quota_snapshot") {
        const freeLimit = args.p_free_limit as number;
        const reserve = args.p_reserve as number;
        const effective = Math.max(freeLimit - reserve, 0);
        return Promise.resolve({
          data: [
            {
              period: "2026-08",
              sku: args.p_sku,
              used,
              free_limit: freeLimit,
              reserve,
              effective_limit: effective,
              remaining: Math.max(effective - used, 0),
            },
          ],
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    },
  } as unknown as QuotaClient;
}

beforeEach(() => {
  state.verified = false;
});

describe("the pricing gate", () => {
  it("blocks while the catalog is unverified, with the specified wording", async () => {
    const result = await runPreflight({ db: fakeDb(0) });

    expect(result.allowed).toBe(false);
    expect(result.blocked).toEqual(PRICING_BLOCK);
    expect(result.blocked?.title).toBe("GOOGLE SEARCH BLOCKED");
    expect(result.blocked?.message).toBe("Pricing configuration has not been verified.");
  });

  it("blocks even when there is plenty of quota", async () => {
    // A comfortable budget computed from unconfirmed numbers is the most
    // dangerous state, not a reason to proceed.
    const result = await runPreflight({ db: fakeDb(0) });

    expect(result.quota.remaining).toBeGreaterThan(100);
    expect(result.allowed).toBe(false);
    expect(result.blocked?.code).toBe("pricing-unverified");
  });

  it("outranks an exhausted budget, because it is the reason nothing may run", async () => {
    const result = await runPreflight({ db: fakeDb(100_000) });
    expect(result.blocked?.code).toBe("pricing-unverified");
  });

  it("tells the user exactly what to do about it", async () => {
    const result = await runPreflight({ db: fakeDb(0) });
    expect(result.blocked?.action).toMatch(/catalog\.json/);
    expect(result.blocked?.action).toMatch(/verified: true/);
  });

  it("still reports the estimate, so the cost of the blocked run is visible", async () => {
    const result = await runPreflight({ db: fakeDb(0) });
    expect(result.estimate.estimatedCalls).toBeGreaterThan(0);
    expect(result.quota.freeLimit).toBeGreaterThan(0);
  });
});

describe("the budget gate", () => {
  it("allows a run once pricing is verified and quota remains", async () => {
    state.verified = true;
    const result = await runPreflight({ db: fakeDb(10) });

    expect(result.allowed).toBe(true);
    expect(result.blocked).toBeNull();
  });

  it("blocks when the protected allowance is spent", async () => {
    state.verified = true;
    const result = await runPreflight({ db: fakeDb(950) });

    expect(result.allowed).toBe(false);
    expect(result.blocked?.code).toBe("quota-exhausted");
    expect(result.blocked?.title).toBe("FREE PLAN LIMIT REACHED");
  });

  it("blocks when the estimate does not fit in what is left", async () => {
    state.verified = true;
    const result = await runPreflight({ db: fakeDb(950), tiles: 100 });

    expect(result.allowed).toBe(false);
    expect(result.blocked?.code).toMatch(/quota-(exhausted|insufficient)/);
  });

  it("flags a worst case that does not fit even when the estimate does", async () => {
    // The situation that quietly overspends: an estimate inside the allowance
    // whose retry ceiling is not. `attemptsPerPage` is passed explicitly
    // because Phase 3A itself allows no retries, and the flag must still work
    // for the phase that does.
    state.verified = true;
    const result = await runPreflight({ db: fakeDb(949), attemptsPerPage: 3 });

    expect(result.allowed).toBe(true);
    expect(result.worstCaseExceedsQuota).toBe(true);
  });
});

describe("the estimate", () => {
  it("derives the SKU from the field mask rather than naming it", async () => {
    const result = await runPreflight({ db: fakeDb(0) });
    // Phone and website are Enterprise fields and both are required.
    expect(result.estimate.sku).toBe("places-text-search-enterprise");
  });

  it("reports the estimate and the worst case as two separate numbers", async () => {
    const result = await runPreflight({ db: fakeDb(0) });

    expect(result.estimate.estimatedCalls).toBe(
      PHASE_3A_LIMITS.maxSeedTiles * PHASE_3A_LIMITS.maxPagesPerTile,
    );
    expect(result.estimate.guaranteedMaxCalls).toBe(
      PHASE_3A_LIMITS.maxSeedTiles *
        PHASE_3A_LIMITS.maxPagesPerTile *
        PHASE_3A_LIMITS.maxAttemptsPerPage,
    );
    // Phase 3A allows no retries, so the two are equal here. The worst case can
    // never be LOWER than the estimate, whatever the retry budget.
    expect(result.estimate.guaranteedMaxCalls).toBeGreaterThanOrEqual(
      result.estimate.estimatedCalls,
    );
  });

  it("grows the worst case with the retry budget, not with the estimate", async () => {
    // Tests the formula rather than today's constant, so raising the cap in
    // Phase 3B cannot silently stop the worst case from being reported.
    const noRetries = await runPreflight({ db: fakeDb(0), attemptsPerPage: 1 });
    expect(noRetries.estimate.guaranteedMaxCalls).toBe(noRetries.estimate.estimatedCalls);

    const withRetries = await runPreflight({ db: fakeDb(0), attemptsPerPage: 3 });
    expect(withRetries.estimate.estimatedCalls).toBe(noRetries.estimate.estimatedCalls);
    expect(withRetries.estimate.guaranteedMaxCalls).toBeGreaterThan(
      withRetries.estimate.estimatedCalls,
    );
  });

  it("keeps Phase 3A to a single tile and a single page", async () => {
    const result = await runPreflight({ db: fakeDb(0) });
    expect(result.estimate.tiles).toBe(1);
    expect(result.estimate.estimatedCalls).toBe(1);
  });

  it("costs nothing while the run stays inside the free allowance", async () => {
    const result = await runPreflight({ db: fakeDb(0) });
    expect(result.estimate.worstCaseCostUsd).toBe(0);
  });

  it("prices the worst case once the free allowance is gone", async () => {
    const result = await runPreflight({ db: fakeDb(1000) });
    expect(result.estimate.worstCaseCostUsd).toBeGreaterThan(0);
  });
});

describe("SearchBlockedError", () => {
  it("carries the banner text and the whole pre-flight", async () => {
    const preflight = await runPreflight({ db: fakeDb(0) });
    const error = new SearchBlockedError(preflight);

    expect(error.status).toBe(409);
    expect(error.message).toContain("GOOGLE SEARCH BLOCKED");
    expect(error.message).toContain("Pricing configuration has not been verified.");
    expect(error.preflight.quota.freeLimit).toBe(preflight.quota.freeLimit);
  });

  it("cannot be constructed from an allowed pre-flight", async () => {
    state.verified = true;
    const preflight = await runPreflight({ db: fakeDb(0) });
    expect(() => new SearchBlockedError(preflight)).toThrow();
  });
});
