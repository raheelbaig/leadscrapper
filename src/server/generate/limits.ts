import "server-only";

import { MAX_ENRICHMENT_BATCH } from "@/server/enrichment/run-enrichment";
import { SEARCH_LIMITS } from "@/server/search/limits";

/**
 * The spending envelope of ONE approval in the guided flow.
 *
 * ONE PRESS APPROVES THE WHOLE LIFECYCLE.
 *
 * 0014 put a 30-call gate in front of the run, so a press authorised 30 calls
 * and then stopped to ask again. A real city needs roughly ninety, so getting
 * one lead list meant pressing "Continue generation" three times. That is a
 * console, not a product, and the gate was removed by product decision on
 * 2026-08-23.
 *
 * THE HIERARCHY IS NOW TWO DEEP, and every level is a HARD limit enforced by
 * the code that spends:
 *
 *   per search   150 Google calls   <- SEARCH_LIMITS.maxCallsPerSearch,
 *                                     checked by the tick runner between areas
 *   per month    the protected free allowance minus its reserve,
 *                                     checked by reserve_api_calls() per page
 *
 * NOTHING WAS WEAKENED. What was removed is a gate the user pressed through;
 * what remains is every gate that protects the money. Reaching one of them ends
 * the run with an honest "paused for safety" state.
 *
 * Nothing here may be raised by the browser. `call_ceiling` is written to
 * `generation_runs` from this constant at approval time and read back from the
 * row on every advance; the request body is never consulted.
 */
export const GENERATION_LIMITS = {
  /**
   * Billable Google calls ONE approval permits.
   *
   * DELIBERATELY THE SAME NUMBER as the per-search budget. The run ceiling is
   * no longer an independent gate -- it is the hard limit, restated on the run
   * row so that "Google calls used" on the results page and the limit that
   * actually stops the work are guaranteed to be the same figure.
   *
   * Derived rather than written as 150, so that changing the approved
   * per-search spending ceiling can never leave a stale copy here disagreeing
   * with it.
   */
  maxGoogleCallsPerRun: SEARCH_LIMITS.maxCallsPerSearch,

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

  /**
   * Consecutive advances that may change nothing before the run gives up.
   *
   * THE LIVENESS BOUND FOR A SELF-ADVANCING RUN. While a press approved only
   * one slice, the human was the loop condition and a stuck run simply sat
   * there. Now the orchestrator advances itself, so a tick that can do nothing
   * and spend nothing -- a lease it cannot claim, a tile that errors before any
   * request is authorised -- would otherwise be retried forever.
   *
   * Five is enough to ride out a lease held by a slice that is still finishing,
   * and small enough that a genuinely stuck run surfaces in seconds rather than
   * grinding. Any advance that completes an area or spends a call resets it, so
   * a merely slow run is never mistaken for a stuck one.
   */
  maxNoProgressAdvances: 5,
} as const;

if (GENERATION_LIMITS.maxGoogleCallsPerRun > SEARCH_LIMITS.maxCallsPerSearch) {
  // A generation ceiling ABOVE the per-search budget would be the one thing
  // this file must never express: a run permitted to spend more than the hard
  // limit allows. Fail at import rather than at runtime.
  throw new Error(
    "GENERATION_LIMITS.maxGoogleCallsPerRun must never exceed SEARCH_LIMITS.maxCallsPerSearch",
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
