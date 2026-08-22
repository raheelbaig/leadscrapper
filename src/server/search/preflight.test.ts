import { beforeEach, describe, expect, it, vi } from "vitest";

import { INITIAL_AVG_PAGES_PER_TILE } from "@/lib/constants";
import type { QuotaClient } from "@/server/quota/quota-service";

import { SEARCH_LIMITS, maxTilesAfterSubdivision } from "./limits";
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

  it("outranks a spent call budget too", async () => {
    const result = await runPreflight({ db: fakeDb(0), callsAlreadySpent: 999 });
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

describe("the per-search call budget", () => {
  it("is what the guaranteed maximum reports once geometry exceeds it", async () => {
    // Subdivision makes the geometric worst case unbounded in practice. The
    // budget is the number that actually binds, so it is the number quoted.
    state.verified = true;
    const result = await runPreflight({ db: fakeDb(0), tiles: 6 });

    expect(result.estimate.geometricMaxCalls).toBeGreaterThan(SEARCH_LIMITS.maxCallsPerSearch);
    expect(result.estimate.guaranteedMaxCalls).toBe(SEARCH_LIMITS.maxCallsPerSearch);
    expect(result.estimate.budgetBinds).toBe(true);
  });

  it("still reports the geometric worst case, rather than hiding it", async () => {
    state.verified = true;
    const result = await runPreflight({ db: fakeDb(0), tiles: 6 });

    expect(result.estimate.geometricMaxCalls).toBe(
      maxTilesAfterSubdivision(6, SEARCH_LIMITS.maxSubdivisionDepth) *
        SEARCH_LIMITS.maxPagesPerTile *
        SEARCH_LIMITS.maxAttemptsPerPage,
    );
  });

  it("shrinks as a search resumes, because the budget is cumulative", async () => {
    state.verified = true;
    const fresh = await runPreflight({ db: fakeDb(0), tiles: 6, callsAlreadySpent: 0 });
    const resumed = await runPreflight({ db: fakeDb(0), tiles: 6, callsAlreadySpent: 30 });

    expect(fresh.estimate.callBudgetRemaining).toBe(SEARCH_LIMITS.maxCallsPerSearch);
    expect(resumed.estimate.callBudgetRemaining).toBe(SEARCH_LIMITS.maxCallsPerSearch - 30);
    expect(resumed.estimate.guaranteedMaxCalls).toBe(SEARCH_LIMITS.maxCallsPerSearch - 30);
  });

  it("blocks the run outright once the budget is spent", async () => {
    state.verified = true;
    const result = await runPreflight({
      db: fakeDb(0),
      callsAlreadySpent: SEARCH_LIMITS.maxCallsPerSearch,
    });

    expect(result.allowed).toBe(false);
    expect(result.blocked?.code).toBe("call-budget-spent");
    expect(result.estimate.callBudgetRemaining).toBe(0);
    expect(result.estimate.guaranteedMaxCalls).toBe(0);
  });

  it("blocks on the budget before it looks at the free allowance", async () => {
    // They are different guarantees. Plenty of free quota is not permission to
    // exceed the controlled run's own ceiling.
    state.verified = true;
    const result = await runPreflight({
      db: fakeDb(0),
      callsAlreadySpent: SEARCH_LIMITS.maxCallsPerSearch,
    });

    expect(result.quota.remaining).toBeGreaterThan(100);
    expect(result.blocked?.code).toBe("call-budget-spent");
  });

  it("lets geometry win when geometry is the smaller number", async () => {
    state.verified = true;
    const result = await runPreflight({
      db: fakeDb(0),
      tiles: 1,
      pagesPerTile: 1,
      attemptsPerPage: 1,
      maxSubdivisionDepth: 0,
    });

    expect(result.estimate.geometricMaxCalls).toBe(1);
    expect(result.estimate.guaranteedMaxCalls).toBe(1);
    expect(result.estimate.budgetBinds).toBe(false);
  });
});

describe("the free-quota gate", () => {
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
    const result = await runPreflight({ db: fakeDb(945), tiles: 9 });

    expect(result.allowed).toBe(false);
    expect(result.blocked?.code).toBe("quota-insufficient");
  });

  it("flags a worst case that does not fit even when the estimate does", async () => {
    // The situation that quietly overspends: an estimate inside the allowance
    // whose ceiling is not.
    state.verified = true;
    const result = await runPreflight({ db: fakeDb(948), tiles: 1 });

    expect(result.quota.remaining).toBe(2);
    expect(result.estimate.estimatedCalls).toBeLessThanOrEqual(2);
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

  it("expects tiles x the average pages per tile, not the page ceiling", async () => {
    const result = await runPreflight({ db: fakeDb(0), tiles: 6 });
    expect(result.estimate.estimatedCalls).toBe(Math.ceil(6 * INITIAL_AVG_PAGES_PER_TILE));
  });

  it("reports the estimate and the worst case as two separate numbers", async () => {
    const result = await runPreflight({ db: fakeDb(0), tiles: 6 });

    expect(result.estimate.estimatedCalls).toBeLessThan(result.estimate.guaranteedMaxCalls);
    // The worst case can never be LOWER than the estimate.
    expect(result.estimate.guaranteedMaxCalls).toBeGreaterThanOrEqual(
      result.estimate.estimatedCalls,
    );
  });

  it("grows the geometric worst case with the retry budget, not the estimate", async () => {
    // Tests the formula rather than today's constant.
    const noRetries = await runPreflight({ db: fakeDb(0), attemptsPerPage: 1 });
    const withRetries = await runPreflight({ db: fakeDb(0), attemptsPerPage: 3 });

    expect(withRetries.estimate.estimatedCalls).toBe(noRetries.estimate.estimatedCalls);
    expect(withRetries.estimate.geometricMaxCalls).toBe(noRetries.estimate.geometricMaxCalls * 3);
  });

  it("grows the geometric worst case with subdivision depth", async () => {
    // The reason a budget exists at all: depth 3 is two orders of magnitude
    // more expensive than depth 0 from the same rectangle.
    const flat = await runPreflight({ db: fakeDb(0), tiles: 6, maxSubdivisionDepth: 0 });
    const deep = await runPreflight({ db: fakeDb(0), tiles: 6, maxSubdivisionDepth: 3 });

    expect(flat.estimate.geometricMaxCalls).toBe(6 * 3 * 3);
    expect(deep.estimate.geometricMaxCalls).toBe(6 * (1 + 4 + 16 + 64) * 3 * 3);
    expect(deep.estimate.guaranteedMaxCalls).toBe(SEARCH_LIMITS.maxCallsPerSearch);
  });

  it("describes the run it is told about, without clamping it", async () => {
    // Describing is this function's job; enforcing is the runner's, and the
    // runner passes its own already-capped numbers in.
    const result = await runPreflight({ db: fakeDb(0), tiles: 40, attemptsPerPage: 9 });
    expect(result.estimate.tiles).toBe(40);
    expect(result.estimate.attemptsPerPage).toBe(9);
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
