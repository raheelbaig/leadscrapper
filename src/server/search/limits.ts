import "server-only";

/**
 * Phase 3B guard rails.
 *
 * Phase 3A could bound its cost with geometry alone: one tile, one page, one
 * attempt is one call, and there is nothing to argue about. Pagination,
 * multi-tile grids and recursive subdivision destroy that property. Six seed
 * tiles subdivided to depth 3 is 6 x (1+4+16+64) = 510 tiles, and at three
 * pages and three attempts each that is 4,590 billable calls -- from a
 * rectangle small enough to look harmless.
 *
 * So this phase adds a limit that geometry cannot supply: a HARD CALL BUDGET,
 * enforced inside the tick loop against `searches.api_calls_run`. It is the
 * number the pre-flight reports as the guaranteed maximum, because it is the
 * one that actually binds.
 *
 * Everything here is enforced on the SERVER, in `createSearch` and in the tick
 * runner. A value typed into the browser cannot widen any of it, and the API
 * route passes no options at all.
 */
export const PHASE_3B_LIMITS = {
  // --- geometry ----------------------------------------------------------
  /** The controlled band is 4-9 seed tiles, derived from the bbox. */
  maxSeedTiles: 9,
  /**
   * Subdivision depth for a Phase 3B search.
   *
   * ONE, not the production 3. Depth 1 exercises both subdivision rules in
   * full -- R4a splits a saturated parent into four children, and a child that
   * saturates at depth 1 hits the floor as R4b -- while keeping the worst case
   * two orders of magnitude below what depth 3 allows. The engine and its tests
   * support the production depth; only the controlled run is capped.
   */
  maxSubdivisionDepth: 1,
  /**
   * ~300 km2 is a district, not a city: Houston's full bounding box is roughly
   * 3,700 km2, so this still refuses anything close to a full-city crawl.
   */
  maxAreaKm2: 300,
  /** The controlled band is 30-50 leads. */
  maxTargetLeads: 50,

  // --- per page ----------------------------------------------------------
  /**
   * Google's hard ceiling: 20 results per page, three pages, 60 per query. No
   * parameter raises it, and each page is a separate billable call.
   */
  maxPagesPerTile: 3,
  /**
   * Attempts for ONE page. Raised from the Phase 3A cap of 1, deliberately and
   * alongside pagination, because a bounded retry is how a transient 429 or 5xx
   * stops costing a whole tile.
   *
   * Every attempt re-enters `reserve_api_calls()`. A retry is a second billable
   * request, so it must pass the budget guard again -- which is why the retry
   * loop is written out in the tile runner rather than delegated to p-retry.
   */
  maxAttemptsPerPage: 3,

  // --- per run -----------------------------------------------------------
  /**
   * Tiles one press of Run may process.
   *
   * ONE for the first controlled run: one tile per press makes resume trivially
   * auditable -- press, read the tile row, press again -- and makes the resume
   * path a real observed behaviour rather than a staged one. Raise it once the
   * first run has succeeded.
   */
  maxTilesPerTick: 1,
  /**
   * Billable calls one press may make.
   *
   * NINE, which is exactly what the other limits already permit:
   * 1 tile x 3 pages x 3 attempts. Set to the true ceiling rather than to a
   * comfortable round number above it, so the limit states the real bound
   * instead of leaving eleven calls of unexplained headroom -- headroom that a
   * later change to the tile cap would silently convert into spending.
   *
   * It is therefore exactly binding today and restricts nothing: the tile
   * budget stops the loop first. Raising maxTilesPerTick means revisiting this
   * deliberately, which is the point.
   */
  maxCallsPerTick: 9,
  /**
   * THE spending ceiling for one search, cumulative across every resume.
   *
   * Checked against `searches.api_calls_run`, which `record_api_call` maintains
   * -- so it counts calls that were actually made, including the ones kept
   * rather than refunded after an HTTP error. This is the number the pre-flight
   * reports as the guaranteed maximum.
   */
  maxCallsPerSearch: 40,
  /**
   * Wall-clock budget for one tick.
   *
   * A three-page tile costs roughly 2s of mandated token delay plus ~1.2s of
   * request per page. Expiring is not a failure: the run pauses with the
   * geography still owed and the next press continues from there.
   */
  maxTickMs: 50_000,
} as const;

export type SearchLimit = keyof typeof PHASE_3B_LIMITS;

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
