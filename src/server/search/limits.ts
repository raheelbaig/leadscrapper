import "server-only";

/**
 * Phase 3A guard rails.
 *
 * This phase exists to prove that the real pipeline works end to end, not to
 * scrape a city. Every limit here is deliberately small so that a bug, a stuck
 * loop or a double-clicked button cannot spend a meaningful part of the free
 * allowance before anyone notices.
 *
 * These are enforced on the SERVER, in `createSearch` and in the tick runner.
 * A value typed into the browser cannot widen them.
 *
 * Phase 3B replaces this module with the real grid engine: full tiling,
 * pagination to three pages, and R1-R5 subdivision.
 */
export const PHASE_3A_LIMITS = {
  /** One tile. The grid engine and subdivision land in Phase 3B. */
  maxSeedTiles: 1,
  /**
   * One page. Pages 2 and 3 need a `nextPageToken` and a ~2s delay, and each is
   * a separate billable call -- so pagination is proven separately, after the
   * first request/response path is known to work.
   */
  maxPagesPerTile: 1,
  /**
   * ~25 km2 is a neighbourhood, not a city. Houston's full bounding box is
   * roughly 3,700 km2; refusing anything near that is what stops a "quick test"
   * from turning into a 90-tile crawl.
   */
  maxAreaKm2: 25,
  /** A controlled proof needs a handful of leads, not a lead list. */
  maxTargetLeads: 20,
  /** Total billable calls a single controlled tick may make, retries included. */
  maxCallsPerTick: 1,
  /**
   * Attempts for one page. ONE -- no retries.
   *
   * A retry is a second billable request, and this phase is specified as
   * "exactly one Google request". Capping it here rather than at the call site
   * makes that structural: the API route, the Run button and any script all
   * inherit it, so no code path can spend a second call by forgetting to pass
   * an option. A transient 429 or 5xx is therefore reported rather than
   * retried, which is the correct trade for a smoke test.
   *
   * Phase 3B raises this deliberately, alongside pagination.
   */
  maxAttemptsPerPage: 1,
} as const;

export class Phase3aLimitError extends Error {
  readonly limit: keyof typeof PHASE_3A_LIMITS;
  readonly status = 422;

  constructor(limit: keyof typeof PHASE_3A_LIMITS, message: string) {
    super(message);
    this.name = "Phase3aLimitError";
    this.limit = limit;
  }
}
