import "server-only";

/**
 * The Phase 4 spending envelope.
 *
 * Phase 3B could lean on geometry and a tiny budget: one tile per press, forty
 * calls per search, and a lead target that stopped the run early. Phase 4
 * removes the last of those on purpose -- the target is a benchmark now, not a
 * termination condition (see `stopOnTargetReached`), so a search runs until the
 * GEOGRAPHY is accounted for.
 *
 * That makes `maxCallsPerSearch` the only thing standing between a single press
 * and the month's free allowance. It is therefore the one number here that was
 * approved explicitly rather than derived:
 *
 *   APPROVED 2026-08-22: 150 calls per search.
 *
 * 150 of the ~943 protected Enterprise calls remaining is roughly a sixth of
 * the month. A full city at an 8 km seed edge is about 90 seed tiles, which at
 * the learned ~1.2 pages per tile costs roughly 110 calls -- so 150 covers one
 * real city with subdivision headroom, and still leaves the month able to
 * absorb several more searches. A higher ceiling was proposed and deliberately
 * rejected. Raising it is a spending decision, not a tuning decision.
 *
 * Everything here is enforced on the SERVER, in `createSearch` and in the tick
 * runner, and every option is clamped with `Math.min(option ?? CAP, CAP)` so an
 * option can only ever LOWER a limit. The run route passes no options at all.
 */
export const SEARCH_LIMITS = {
  // --- geometry ----------------------------------------------------------
  /**
   * Seed tiles one search may lay down.
   *
   * The production figure, matching `DEFAULT_GRID_CONFIG`. A full city at an
   * 8 km seed edge is roughly 90 tiles, so this is headroom rather than a
   * target -- and it costs nothing, because laying down a grid is free. Only
   * searching bills, and `maxCallsPerSearch` is what bounds that.
   */
  maxSeedTiles: 400,
  /**
   * Recursive subdivision depth.
   *
   * THREE, the production depth. A saturated seed tile splits into four, and
   * each child may split again twice more, which is what lets a dense city
   * block be resolved below the 60-result ceiling instead of being written off
   * as a permanent gap.
   */
  maxSubdivisionDepth: 3,
  /**
   * ~5,000 km2 admits a whole metropolitan bounding box -- Houston's is roughly
   * 3,700 km2 -- while still refusing a region or a country by accident.
   */
  maxAreaKm2: 5_000,
  /**
   * The lead target is a MINIMUM DESIRED BENCHMARK and does not stop a search,
   * so this cap only stops a nonsensical figure being recorded against a run.
   */
  maxTargetLeads: 10_000,

  // --- per page ----------------------------------------------------------
  /**
   * Google's hard ceiling: 20 results per page, three pages, 60 per query. No
   * parameter raises it, and each page is a separate billable call.
   */
  maxPagesPerTile: 3,
  /**
   * Attempts for ONE page.
   *
   * Every attempt re-enters `reserve_api_calls()`. A retry is a second billable
   * request, so it must pass the budget guard again -- which is why the retry
   * loop is written out in the tile runner rather than delegated to p-retry.
   */
  maxAttemptsPerPage: 3,

  // --- per run -----------------------------------------------------------
  /**
   * Tiles one tick may process.
   *
   * TWELVE. At roughly 1.2s per request plus the mandated 2s token delay before
   * any second or third page, the wall-clock budget below binds long before
   * this does -- which is the intent. This is the structural ceiling; time is
   * the practical one.
   */
  maxTilesPerTick: 12,
  /**
   * Billable calls one tick may make.
   *
   * Exactly what the other limits already permit: 12 tiles x 3 pages x 3
   * attempts. Pinned to the DERIVED ceiling rather than a round number above
   * it, so the limit states the real bound instead of leaving headroom that a
   * later change to the tile cap would silently convert into spending.
   */
  maxCallsPerTick: 108,
  /**
   * THE spending ceiling for one search, cumulative across every resume.
   *
   * Checked against `searches.api_calls_run`, which `record_api_call` maintains
   * -- so it counts calls that were actually made, including the ones kept
   * rather than refunded after an HTTP error. This is the number the pre-flight
   * reports as the guaranteed maximum, and since Phase 4 removed the target as
   * a stop condition it is the ONLY ceiling that bounds a search's cost.
   *
   * Approved value. See the module comment before changing it.
   */
  maxCallsPerSearch: 150,
  /**
   * Wall-clock budget for one tick.
   *
   * The manual run route declares `maxDuration = 60`, so 50s leaves the runner
   * room to write its final state rather than being cut off mid-report.
   * Expiring is not a failure: the run pauses with the geography still owed and
   * the next tick continues from there.
   *
   * The background worker passes a SHORTER slice through the clamped option, so
   * it can lower this but never raise it.
   */
  maxTickMs: 50_000,
} as const;

export type SearchLimit = keyof typeof SEARCH_LIMITS;

export class SearchLimitError extends Error {
  readonly limit: SearchLimit;
  readonly status = 422;

  constructor(limit: SearchLimit, message: string) {
    super(message);
    this.name = "SearchLimitError";
    this.limit = limit;
  }
}

/**
 * Tiles a grid could grow to if EVERY tile saturated and subdivided all the way
 * down: `tiles x sum(4^d)` for d in 0..depth.
 *
 * Used by the pre-flight to state the geometric worst case honestly, next to
 * the budget that actually caps it. Quoting only the capped number would hide
 * how far the geometry alone could run.
 */
export function maxTilesAfterSubdivision(seedTiles: number, maxDepth: number): number {
  let total = 0;
  for (let depth = 0; depth <= Math.max(maxDepth, 0); depth += 1) {
    total += 4 ** depth;
  }
  return seedTiles * total;
}
