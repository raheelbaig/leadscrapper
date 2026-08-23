import { describe, expect, it } from "vitest";

import { MAX_ENRICHMENT_BATCH } from "@/server/enrichment/run-enrichment";
import { SEARCH_LIMITS } from "@/server/search/limits";

import { areasAllowedThisAdvance, callsUsedByRun, GENERATION_LIMITS } from "./limits";

/**
 * The spending envelope of one approval.
 *
 * These are the numbers a person agreed to when they pressed Generate Leads, so
 * they are pinned the same way `safety-envelope.test.ts` pins the phase limits:
 * changing one should require changing a test that says out loud that it was
 * approved.
 */

describe("GENERATION_LIMITS", () => {
  it("lets one press approve the whole lifecycle, bounded by the hard limit", () => {
    // PRODUCT DECISION 2026-08-23: a press approves the whole job, so the run
    // ceiling IS the per-search spending limit rather than a second, narrower
    // gate in front of it. Derived, never a literal, so the two can never drift.
    expect(GENERATION_LIMITS.maxGoogleCallsPerRun).toBe(SEARCH_LIMITS.maxCallsPerSearch);
    expect(GENERATION_LIMITS.maxGoogleCallsPerRun).toBe(150);
  });

  it("derives the per-area worst case from the page and attempt caps", () => {
    // Not a chosen number: three pages, each retried up to three times, every
    // attempt a separate billable call.
    expect(GENERATION_LIMITS.worstCaseCallsPerArea).toBe(
      SEARCH_LIMITS.maxPagesPerTile * SEARCH_LIMITS.maxAttemptsPerPage,
    );
    expect(GENERATION_LIMITS.worstCaseCallsPerArea).toBe(9);
  });

  it("never permits a run to spend more than the per-search budget allows", () => {
    // THE INVARIANT THAT SURVIVED THE POLICY CHANGE. Removing the 30-call gate
    // must never have raised what a run can spend above the hard limit.
    expect(GENERATION_LIMITS.maxGoogleCallsPerRun).toBeLessThanOrEqual(
      SEARCH_LIMITS.maxCallsPerSearch,
    );
  });

  it("bounds the self-advancing loop with a liveness limit", () => {
    // A run that asks for its own next slice can spin. This is what stops it.
    expect(GENERATION_LIMITS.maxNoProgressAdvances).toBeGreaterThan(0);
    expect(GENERATION_LIMITS.maxNoProgressAdvances).toBeLessThanOrEqual(10);
  });

  it("keeps the per-advance email batch inside the enrichment subsystem's own cap", () => {
    expect(GENERATION_LIMITS.enrichmentLeadsPerAdvance).toBeLessThanOrEqual(MAX_ENRICHMENT_BATCH);
  });

  it("does not change the limits it sits inside", () => {
    // The guided flow adds a ceiling. It must not have moved the ones that were
    // already approved.
    expect(SEARCH_LIMITS.maxCallsPerSearch).toBe(150);
    expect(SEARCH_LIMITS.maxPagesPerTile).toBe(3);
    expect(SEARCH_LIMITS.maxAttemptsPerPage).toBe(3);
    expect(SEARCH_LIMITS.maxTilesPerTick).toBe(12);
  });
});

describe("areasAllowedThisAdvance", () => {
  /**
   * THE GUARANTEE.
   *
   * The tick runner checks its budgets BETWEEN areas, not between pages, so an
   * area started with the limit one call away could still spend nine. The
   * orchestrator therefore never starts an area it could not afford in full.
   * This is the property that makes the ceiling exact rather than approximate.
   */
  it("never permits a worst case above what is left", () => {
    for (let remaining = 0; remaining <= 200; remaining += 1) {
      const areas = areasAllowedThisAdvance(remaining);
      expect(areas * GENERATION_LIMITS.worstCaseCallsPerArea).toBeLessThanOrEqual(remaining);
    }
  });

  it("stops the run while fewer calls remain than one area could cost", () => {
    // Eight calls left is not enough to start an area that could cost nine, so
    // the run stops with them unspent rather than risking one call too many.
    // The UI states that plainly rather than rounding it away.
    expect(areasAllowedThisAdvance(8)).toBe(0);
    expect(areasAllowedThisAdvance(9)).toBe(1);
  });

  it("uses full slices on a fresh approval now that one press approves the job", () => {
    // floor(150 / 9) = 16, clamped to the tick runner's own cap of 12. Under the
    // old 30-call gate this was 3, which is what made a real city take several
    // presses to search.
    expect(areasAllowedThisAdvance(GENERATION_LIMITS.maxGoogleCallsPerRun)).toBe(
      SEARCH_LIMITS.maxTilesPerTick,
    );
  });

  it("is clamped by the tick runner's own area cap", () => {
    // Even given an enormous allowance, one advance may not ask for more than
    // the tick runner already permits: an option can only ever LOWER a limit.
    expect(areasAllowedThisAdvance(100_000)).toBe(SEARCH_LIMITS.maxTilesPerTick);
  });

  it.each([0, -1, -100, Number.NaN, Number.POSITIVE_INFINITY])(
    "returns a sane count for the degenerate input %p",
    (remaining) => {
      const areas = areasAllowedThisAdvance(remaining as number);
      expect(areas).toBeGreaterThanOrEqual(0);
      expect(areas).toBeLessThanOrEqual(SEARCH_LIMITS.maxTilesPerTick);
    },
  );
});

describe("callsUsedByRun", () => {
  it("derives usage from the authoritative counter and the approval watermark", () => {
    // A continuation over a search that had already spent 14 calls: the new
    // approval owns only what it spends itself.
    expect(callsUsedByRun({ searchApiCallsRun: 20, apiCallsAtStart: 14 })).toBe(6);
  });

  it("counts from zero for a brand-new search", () => {
    expect(callsUsedByRun({ searchApiCallsRun: 5, apiCallsAtStart: 0 })).toBe(5);
  });

  it("never reports negative usage", () => {
    // Cannot happen while the counter only increases, but a negative figure
    // would silently WIDEN the remaining allowance, so it is floored.
    expect(callsUsedByRun({ searchApiCallsRun: 3, apiCallsAtStart: 10 })).toBe(0);
  });
});
