import "server-only";

import { PAGE_TOKEN_DELAY_MS, PLACES_TEXT_SEARCH_URL } from "@/lib/constants";
import type { BoundingBox } from "@/lib/geo/bbox";
import {
  buildTextSearchRequest,
  executeTextSearch,
  type ExecuteOptions,
} from "@/server/places/client";
import { PlacesApiError } from "@/server/places/errors";
import type { TextSearchResponse } from "@/server/places/schema";
import {
  recordCall,
  releaseCalls,
  reserveCalls,
  type QuotaClient,
} from "@/server/quota/quota-service";

import { PHASE_3B_LIMITS } from "./limits";

/**
 * Fetches ONE page of Text Search results for one tile, under budget.
 *
 * The loop is written out rather than delegated to a retry helper for one
 * reason: **every attempt is a separate billable request**, so every attempt
 * needs its own reservation from `reserve_api_calls()` before it is made. A
 * generic retry wrapper would re-run the request without re-entering the guard,
 * which is precisely the hole the guard exists to close.
 *
 * The order is fixed and is never rearranged:
 *
 *     reserve  ->  request  ->  record (or refund)
 *
 * Nothing calls Google before the reservation is granted. A denial is a normal
 * outcome that ends the tile as `skipped_quota`, not an error.
 *
 * On the refund rule: the reservation is returned ONLY when no HTTP status ever
 * arrived, because that is the only case where Google demonstrably did not meter
 * the request. A 400 or a 500 keeps its reservation. That deliberately
 * over-counts against ourselves -- the local counter is an estimate, and the
 * safety reserve exists to absorb exactly this kind of drift in the direction
 * that costs nothing.
 */

const ENDPOINT_LABEL = PLACES_TEXT_SEARCH_URL;

export type TilePageResult =
  | {
      kind: "ok";
      response: TextSearchResponse;
      httpStatus: number;
      durationMs: number;
      /** Billable calls actually reserved during this page, retries included. */
      callsMade: number;
      attempts: number;
    }
  | {
      kind: "quota-denied";
      remaining: number;
      period: string;
      callsMade: number;
      attempts: number;
    }
  | {
      kind: "error";
      error: PlacesApiError;
      callsMade: number;
      attempts: number;
    };

export type FetchTilePageArgs = {
  sku: string;
  searchId: string;
  tileId: string;
  /** The niche alone. Never "niche in city". */
  textQuery: string;
  bbox: BoundingBox;
  /** 0-based. Phase 3A only ever fetches page 0. */
  pageIndex: number;
  pageToken?: string | null;
};

export type FetchTilePageOptions = ExecuteOptions & {
  db?: QuotaClient;
  maxAttempts?: number;
  /** Injected in tests so a retry does not really wait. */
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 0.5s then 1.5s. Short, because the tick itself is bounded. */
function backoffMs(attempt: number): number {
  return attempt === 1 ? 500 : 1500;
}

export async function fetchTilePage(
  args: FetchTilePageArgs,
  options: FetchTilePageOptions = {},
): Promise<TilePageResult> {
  // Clamped, not merely defaulted. A limit that depends on every call site
  // remembering to pass the right option is the exact class of mistake that
  // spent this project's first real Google call, so the floor is enforced at
  // the lowest level that can spend one.
  const maxAttempts = Math.min(
    options.maxAttempts ?? PHASE_3B_LIMITS.maxAttemptsPerPage,
    PHASE_3B_LIMITS.maxAttemptsPerPage,
  );
  const sleep = options.sleep ?? defaultSleep;
  const db = options.db;

  // Built ONCE and reused for every attempt. Google requires every parameter to
  // be identical when a page token is presented, and rebuilding per attempt
  // would be a chance for them to drift apart.
  const request = buildTextSearchRequest({
    textQuery: args.textQuery,
    bbox: args.bbox,
    pageToken: args.pageToken,
  });

  let callsMade = 0;
  let lastError: PlacesApiError | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // ---- reserve --------------------------------------------------------
    // Throws QuotaBlockedError if the pricing catalog is unverified. That is
    // deliberate: the pre-flight already checked, and a second, closer guard
    // means no code path can reach Google around it.
    const reservation = await reserveCalls({ sku: args.sku, calls: 1 }, { db });

    if (!reservation.granted) {
      return {
        kind: "quota-denied",
        remaining: reservation.remaining,
        period: reservation.period,
        callsMade,
        attempts: attempt - 1,
      };
    }

    callsMade += 1;

    // ---- request --------------------------------------------------------
    try {
      const attemptResult = await executeTextSearch(request, {
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
      });

      await recordCall(
        {
          sku: args.sku,
          endpoint: ENDPOINT_LABEL,
          searchId: args.searchId,
          tileId: args.tileId,
          pageIndex: args.pageIndex,
          httpStatus: attemptResult.httpStatus,
          billable: true,
          resultCount: attemptResult.response.places.length,
          durationMs: attemptResult.durationMs,
        },
        { db },
      );

      return {
        kind: "ok",
        response: attemptResult.response,
        httpStatus: attemptResult.httpStatus,
        durationMs: attemptResult.durationMs,
        callsMade,
        attempts: attempt,
      };
    } catch (thrown) {
      const error =
        thrown instanceof PlacesApiError
          ? thrown
          : new PlacesApiError({
              message: thrown instanceof Error ? thrown.message : String(thrown),
              kind: "network",
              retryable: false,
              cause: thrown,
            });

      lastError = error;

      if (error.reachedGoogle) {
        // It got a status, so assume it was metered and keep the reservation.
        await recordCall(
          {
            sku: args.sku,
            endpoint: ENDPOINT_LABEL,
            searchId: args.searchId,
            tileId: args.tileId,
            pageIndex: args.pageIndex,
            httpStatus: error.status,
            billable: true,
            error: error.logMessage,
          },
          { db },
        );
      } else {
        // No status ever arrived: Google never saw it, so refund.
        await releaseCalls({ sku: args.sku, calls: 1 }, { db });
        callsMade -= 1;
        await recordCall(
          {
            sku: args.sku,
            endpoint: ENDPOINT_LABEL,
            searchId: args.searchId,
            tileId: args.tileId,
            pageIndex: args.pageIndex,
            httpStatus: null,
            billable: false,
            error: error.logMessage,
          },
          { db },
        );
      }

      const isLastAttempt = attempt >= maxAttempts;

      if (!error.retryable || isLastAttempt) {
        return { kind: "error", error, callsMade, attempts: attempt };
      }

      await sleep(backoffMs(attempt));
    }
  }

  // Unreachable in practice: the loop always returns. Kept so the function is
  // total rather than relying on the compiler's flow analysis holding forever.
  return {
    kind: "error",
    error:
      lastError ??
      new PlacesApiError({
        message: "Exhausted every attempt without a result.",
        kind: "network",
        retryable: false,
      }),
    callsMade,
    attempts: maxAttempts,
  };
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/**
 * Walks one tile through its pages: 1, then 2, then 3, and never a 4th.
 *
 * Three constraints from Google's contract shape this loop, and every one of
 * them is a correctness issue rather than a preference:
 *
 *   1. A `nextPageToken` needs roughly two seconds before it is usable. Asking
 *      sooner returns an error, and the error costs a call.
 *   2. EVERY other request parameter must be identical when a token is
 *      presented, or Google answers INVALID_ARGUMENT. That is guaranteed here
 *      structurally: the same `textQuery` and the same `bbox` object are passed
 *      to every page, and `fetchTilePage` builds its request once and reuses it
 *      across retries. The page token is the only thing that ever differs.
 *   3. Each page is a SEPARATE billable call. So each page reserves its own
 *      budget, through `fetchTilePage` -- there is no such thing as reserving
 *      once for a tile.
 *
 * `onPage` is invoked after every page, before the next one is requested. That
 * is what makes a tick that dies mid-tile lose at most the single in-flight
 * page: the pages already fetched are in Postgres, and their leads are already
 * behind the unique constraint.
 *
 * Contains no database calls of its own, which is what lets the whole
 * pagination path be tested with a fetch stub and nothing else.
 */

export type TilePageEvent = {
  /** 0-based. */
  pageIndex: number;
  response: TextSearchResponse;
  httpStatus: number;
  durationMs: number;
  /** Billable calls this page spent, retries included. */
  callsMade: number;
  attempts: number;
  /** Did Google offer another page after this one? */
  tokenPresent: boolean;
  /** Distinct place ids seen so far in THIS pass over the tile. */
  cumulativeResults: number;
  /** Billable calls so far in THIS pass over the tile. */
  cumulativeCalls: number;
  cumulativePages: number;
};

export type PaginateTileArgs = Omit<FetchTilePageArgs, "pageIndex" | "pageToken">;

export type PaginateTileOptions = FetchTilePageOptions & {
  maxPages?: number;
  /** Persists a page before the next one is requested. */
  onPage?: (event: TilePageEvent) => Promise<void>;
  /** The mandated token delay. Overridable only so tests need not really wait. */
  pageDelayMs?: number;
};

export type PaginateTileOutcome =
  /** Google offered no further token: everything it has was collected. */
  | "exhausted"
  /** A token remained when the page ceiling was hit: results are truncated. */
  | "page-limit"
  | "quota-denied"
  | "error";

export type PaginateTileResult = {
  outcome: PaginateTileOutcome;
  pagesFetched: number;
  /** R: DISTINCT place ids across the pages of this pass. */
  resultsCount: number;
  /** Billable calls this pass spent, retries included. */
  callsMade: number;
  /** True when the tile stopped with results still waiting behind a token. */
  tokenRemaining: boolean;
  error: PlacesApiError | null;
  quota: { remaining: number; period: string } | null;
  lastHttpStatus: number | null;
};

export async function paginateTile(
  args: PaginateTileArgs,
  options: PaginateTileOptions = {},
): Promise<PaginateTileResult> {
  const maxPages = Math.min(
    options.maxPages ?? PHASE_3B_LIMITS.maxPagesPerTile,
    PHASE_3B_LIMITS.maxPagesPerTile,
  );
  const sleep = options.sleep ?? defaultSleep;
  const pageDelayMs = options.pageDelayMs ?? PAGE_TOKEN_DELAY_MS;

  /**
   * A COUNTER, not the deduplication mechanism. The authoritative dedupe is the
   * unique index on (search_id, place_id), which survives a crash, a resume and
   * two ticks running back to back; this set exists only so that a place Google
   * repeats across pages does not inflate R and push an unsaturated tile into
   * subdivision.
   */
  const seen = new Set<string>();

  let pagesFetched = 0;
  let callsMade = 0;
  let pageToken: string | null = null;
  let lastHttpStatus: number | null = null;

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    if (pageIndex > 0) {
      // The token is not usable immediately. This wait is Google's, not ours.
      await sleep(pageDelayMs);
    }

    const page = await fetchTilePage({ ...args, pageIndex, pageToken }, options);
    callsMade += page.callsMade;

    if (page.kind === "quota-denied") {
      return {
        outcome: "quota-denied",
        pagesFetched,
        resultsCount: seen.size,
        callsMade,
        // The page that was refused is still owed, so the tile is not finished.
        tokenRemaining: pageIndex > 0,
        error: null,
        quota: { remaining: page.remaining, period: page.period },
        lastHttpStatus,
      };
    }

    if (page.kind === "error") {
      return {
        outcome: "error",
        pagesFetched,
        resultsCount: seen.size,
        callsMade,
        tokenRemaining: pageIndex > 0,
        error: page.error,
        quota: null,
        lastHttpStatus: page.error.status,
      };
    }

    pagesFetched += 1;
    lastHttpStatus = page.httpStatus;

    for (const place of page.response.places) {
      seen.add(place.id);
    }

    const nextToken = page.response.nextPageToken ?? null;

    await options.onPage?.({
      pageIndex,
      response: page.response,
      httpStatus: page.httpStatus,
      durationMs: page.durationMs,
      callsMade: page.callsMade,
      attempts: page.attempts,
      tokenPresent: Boolean(nextToken),
      cumulativeResults: seen.size,
      cumulativeCalls: callsMade,
      cumulativePages: pagesFetched,
    });

    if (!nextToken) {
      return {
        outcome: "exhausted",
        pagesFetched,
        resultsCount: seen.size,
        callsMade,
        tokenRemaining: false,
        error: null,
        quota: null,
        lastHttpStatus,
      };
    }

    pageToken = nextToken;
  }

  // The page ceiling stopped us while Google still had more. The tile is
  // truncated, which is what R4 exists to detect.
  return {
    outcome: "page-limit",
    pagesFetched,
    resultsCount: seen.size,
    callsMade,
    tokenRemaining: true,
    error: null,
    quota: null,
    lastHttpStatus,
  };
}
