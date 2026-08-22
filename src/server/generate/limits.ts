import "server-only";

import { MAX_ENRICHMENT_BATCH } from "@/server/enrichment/run-enrichment";
import { SEARCH_LIMITS } from "@/server/search/limits";

/**
 * The spending envelope of ONE approval in the guided flow.
 *
 * THE HIERARCHY, narrowest first. Each ceiling sits inside the next and none
 * may ever exceed it:
 *
 *   per generation run   30 Google calls   <- APPROVED 2026-08-23, here
 *   per search          150 Google calls   <- SEARCH_LIMITS.maxCallsPerSearch
 *   per month            protected free allowance, from the quota service
 *
 * Why a third ceiling at all. Before the guided flow, one press of Run was one
 * tick, and the person pressing it saw the pre-flight numbers each time -- the
 * approval and the spending were the same act. A single button that drives a
 * run to completion breaks that: it makes many ticks from one press. This
 * ceiling is what a person is agreeing to when they press Generate Leads, and
 * reaching it stops the run and asks again rather than continuing quietly.
 *
 * Nothing here may be raised by the browser. `call_ceiling` is written to
 * `generation_runs` from this constant at approval time and read back from the
 * row on every advance; the request body is never consulted.
 */
export const GENERATION_LIMITS = {
  /**
   * Billable Google calls ONE approval permits.
   *
   * APPROVED 2026-08-23: 30 calls.
   *
   * 30 of the 936 protected Enterprise calls currently remaining is about 3% of
   * the month. At the ~1.05 calls per tile actually observed across the four
   * real searches to date, it covers roughly 28 areas -- comfortably more than
   * the 6-area grids the flow produces for a city test box, and enough that a
   * typical guided run finishes inside a single approval.
   *
   * Raising this is a spending decision, not a tuning decision.
   */
  maxGoogleCallsPerRun: 30,

  /**
   * Worst case for ONE area, derived rather than chosen: three pages, each
   * retried up to three times, every attempt a separate billable call that
   * re-enters `reserve_api_calls()`.
   *
   * This is the number that makes the ceiling a GUARANTEE. The tick runner
   * checks its budgets between areas, not between pages, so an area that starts
   * with the ceiling one call away could still spend nine. The orchestrator
   * therefore never starts an area it could not afford in full -- see
   * `areasAllowedThisAdvance`.
   */
  worstCaseCallsPerArea: SEARCH_LIMITS.maxPagesPerTile * SEARCH_LIMITS.maxAttemptsPerPage,

  /**
   * Leads whose websites one advance may check.
   *
   * Small on purpose, and NOT the enrichment batch cap. Five keeps each advance
   * well inside the route's 300s ceiling even if every site hangs
   * (5 x ~54s = 270s), and it makes progress visible every few seconds instead
   * of once per twenty-five leads. The subsystem's own `MAX_ENRICHMENT_BATCH`
   * still applies underneath and is never widened.
   */
  enrichmentLeadsPerAdvance: 5,
} as const;

if (GENERATION_LIMITS.maxGoogleCallsPerRun > SEARCH_LIMITS.maxCallsPerSearch) {
  // A generation ceiling above the per-search budget would be a ceiling that
  // never binds -- the wider limit would stop the run first and the number the
  // user approved would be decorative. Fail at import rather than at runtime.
  throw new Error(
    "GENERATION_LIMITS.maxGoogleCallsPerRun must sit inside SEARCH_LIMITS.maxCallsPerSearch",
  );
}

if (GENERATION_LIMITS.enrichmentLeadsPerAdvance > MAX_ENRICHMENT_BATCH) {
  throw new Error(
    "GENERATION_LIMITS.enrichmentLeadsPerAdvance must sit inside MAX_ENRICHMENT_BATCH",
  );
}

/**
 * How many areas one advance may work through, given what is left of the
 * approval.
 *
 * THE GUARANTEE. Returns only whole areas the run could pay for at their worst
 * case, so the arithmetic is:
 *
 *   worst case spend = areas x worstCaseCallsPerArea <= remaining
 *
 * and the ceiling cannot be exceeded even if every page of every area retried
 * to its limit. The cost is that a run stops with up to
 * `worstCaseCallsPerArea - 1` calls unspent; the UI says exactly that rather
 * than rounding it away, because "stopped at 24 of 30" with an explanation is
 * honest and "spent 33 of 30" is not.
 *
 * Clamped by `maxTilesPerTick` on the way out, so an advance can only ever ask
 * the tick runner for LESS than the tick runner already permits.
 */
export function areasAllowedThisAdvance(remainingCalls: number): number {
  if (!Number.isFinite(remainingCalls) || remainingCalls <= 0) return 0;

  const affordable = Math.floor(remainingCalls / GENERATION_LIMITS.worstCaseCallsPerArea);
  return Math.max(Math.min(affordable, SEARCH_LIMITS.maxTilesPerTick), 0);
}

/**
 * Google calls this approval has spent, derived from the authoritative counter.
 *
 * `searches.api_calls_run` is maintained by `record_api_call` and counts calls
 * that were really made, including the ones kept rather than refunded after an
 * HTTP error. Subtracting the watermark taken at approval time gives this run's
 * share without a second counter that could drift from the first.
 */
export function callsUsedByRun(args: {
  searchApiCallsRun: number;
  apiCallsAtStart: number;
}): number {
  return Math.max(args.searchApiCallsRun - args.apiCallsAtStart, 0);
}
