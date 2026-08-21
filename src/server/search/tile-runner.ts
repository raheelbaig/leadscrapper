import "server-only";

import { PLACES_TEXT_SEARCH_URL } from "@/lib/constants";
import type { BoundingBox } from "@/lib/geo/bbox";
import { buildTextSearchRequest, executeTextSearch, type ExecuteOptions } from "@/server/places/client";
import { PlacesApiError } from "@/server/places/errors";
import type { TextSearchResponse } from "@/server/places/schema";
import {
  recordCall,
  releaseCalls,
  reserveCalls,
  type QuotaClient,
} from "@/server/quota/quota-service";

import { PHASE_3A_LIMITS } from "./limits";

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
  const maxAttempts = options.maxAttempts ?? PHASE_3A_LIMITS.maxAttemptsPerPage;
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
