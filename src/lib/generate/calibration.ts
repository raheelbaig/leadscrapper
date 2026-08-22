/**
 * Measured timing priors for the guided flow's ETA.
 *
 * These are OBSERVATIONS, not budgets. Nothing here bounds, schedules, delays
 * or retries anything -- they exist so the first few seconds of a run can say
 * something more useful than "unknown" before the run has produced samples of
 * its own. The moment a run has its own measurements, `estimateRemaining`
 * switches to them and stops consulting these entirely (`basis: "run"`).
 *
 * Read from the live database on 2026-08-23 from the four real searches and the
 * 23 real enrichment attempts recorded to date:
 *
 *   search_tiles (n=13 completed, all single-page):
 *     min 2.1s   median 3.1s   max 4.2s
 *   lead_enrichment_attempts (n=23):
 *     found      n=10  median 0.7s   (stops early once the homepage yields one)
 *     not_found  n=10  median 5.5s   (walks all four pages before concluding)
 *     failed     n=3   median 3.6s
 *     overall          median 4.0s   max 7.8s
 *
 * The medians are deliberately taken over ALL outcomes rather than the happy
 * path: a run's leads are a mixture, and quoting the 0.7s "found" figure would
 * flatter every estimate by a factor of five.
 */

/** Median observed wall-clock for one tile, end to end. */
export const PRIOR_TILE_MS = 3_100;

/** Median observed wall-clock for one lead's email lookup, all outcomes. */
export const PRIOR_LEAD_MS = 4_000;

/**
 * Worst case for ONE tile, derived from the limits rather than observed.
 *
 * `maxPagesPerTile` (3) x `maxAttemptsPerPage` (3) = 9 requests, plus the two
 * mandated ~2s `nextPageToken` delays between the three pages. Nothing has ever
 * actually cost this -- every tile so far returned a single page with no token
 * -- which is exactly why it is shown as a separate worst case rather than
 * folded into the estimate.
 */
export const WORST_CASE_TILE_MS = 9 * 2_000 + 2 * 2_000;

/**
 * Worst case for ONE lead, derived from the enrichment provider's own limits:
 * robots.txt plus four pages (homepage + /contact + /contact-us + /about), each
 * able to burn the full 10s `FETCH_TIMEOUT_MS`, plus three 1s per-host delays
 * and the 500ms between-leads delay.
 *
 * 10 + 40 + 3 + 0.5 = 53.5s. A site that simply hangs really does cost this,
 * which is why a 43-lead run has an honest spread of roughly 3 minutes to 39.
 */
export const WORST_CASE_LEAD_MS = 54_000;
