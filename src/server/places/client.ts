import "server-only";

import {
  PAGE_SIZE,
  PLACES_FIELD_MASK_HEADER,
  PLACES_TEXT_SEARCH_URL,
} from "@/lib/constants";
import type { BoundingBox } from "@/lib/geo/bbox";
import { getServerEnv } from "@/server/config/env";

import { PlacesApiError, describeStatus, isRetryableStatus } from "./errors";
import {
  googleErrorResponseSchema,
  textSearchResponseSchema,
  type PlacesRectangle,
  type TextSearchResponse,
} from "./schema";

/**
 * The Google Places API (New) Text Search client.
 *
 * ONE attempt per call. No retry, no backoff, and above all no quota logic:
 * every attempt is a separate billable request, so the decision to make another
 * one belongs to the caller that holds the budget reservation, not here. Mixing
 * them would let a retry loop spend the free allowance without ever passing
 * through `reserve_api_calls()`.
 *
 * `server-only`, and the API key is read from the server env at call time. The
 * ESLint boundary in eslint.config.mjs makes importing this from the browser a
 * build error.
 */

export const DEFAULT_TIMEOUT_MS = 15_000;

export type TextSearchRequestInput = {
  /**
   * The niche ALONE -- "Embroidery Shops", never "Embroidery Shops in Houston".
   * Naming the city pulls Google's ranking back toward the city centroid and
   * defeats the whole point of tiling: every tile would return the same
   * downtown businesses instead of the ones actually inside its rectangle.
   */
  textQuery: string;
  /** The tile. `locationRestriction` on Text Search accepts a rectangle only. */
  bbox: BoundingBox;
  /**
   * Continues a previous query. Google requires every OTHER parameter to be
   * identical when a page token is presented, so the caller must pass the same
   * query and rectangle it used for page 1.
   */
  pageToken?: string | null;
};

export type BuiltRequest = {
  url: string;
  headers: Record<string, string>;
  body: {
    textQuery: string;
    locationRestriction: { rectangle: PlacesRectangle };
    pageSize: number;
    pageToken?: string;
  };
};

export function toRectangle(bbox: BoundingBox): PlacesRectangle {
  return {
    low: { latitude: bbox.minLat, longitude: bbox.minLng },
    high: { latitude: bbox.maxLat, longitude: bbox.maxLng },
  };
}

/**
 * Builds the exact request that will be sent.
 *
 * Separated from sending so the endpoint, headers, field mask and body can be
 * asserted in tests without a network stub -- and so the field mask has exactly
 * one definition. The mask decides the billing SKU; a second copy of it
 * somewhere else is a second chance to change what a search costs by accident.
 */
export function buildTextSearchRequest(input: TextSearchRequestInput): BuiltRequest {
  const env = getServerEnv();
  const textQuery = input.textQuery.trim();

  if (!textQuery) {
    throw new PlacesApiError({
      message: "textQuery is empty. Refusing to send a query with no terms.",
      kind: "malformed",
      retryable: false,
    });
  }

  const body: BuiltRequest["body"] = {
    textQuery,
    locationRestriction: { rectangle: toRectangle(input.bbox) },
    pageSize: PAGE_SIZE,
  };

  if (input.pageToken) {
    body.pageToken = input.pageToken;
  }

  return {
    url: PLACES_TEXT_SEARCH_URL,
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": env.GOOGLE_MAPS_API_KEY,
      "X-Goog-FieldMask": PLACES_FIELD_MASK_HEADER,
    },
    body,
  };
}

/** Headers with the key removed, safe to write to a log or an event row. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) =>
      key.toLowerCase() === "x-goog-api-key" ? [key, "[redacted]"] : [key, value],
    ),
  );
}

export type TextSearchAttempt = {
  response: TextSearchResponse;
  httpStatus: number;
  durationMs: number;
};

export type ExecuteOptions = {
  /** Injected in tests. Defaults to the platform fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/**
 * Sends ONE Text Search request and validates the answer.
 *
 * Throws `PlacesApiError` for every failure, tagged with whether the request
 * reached Google -- which is what decides whether the caller refunds its budget
 * reservation or keeps it.
 */
export async function executeTextSearch(
  request: BuiltRequest,
  options: ExecuteOptions = {},
): Promise<TextSearchAttempt> {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  let httpResponse: Response;

  try {
    httpResponse = await doFetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (cause) {
    // No HTTP status ever arrived, so Google never metered this. Retryable, and
    // the caller must refund the reservation.
    throw new PlacesApiError({
      message: cause instanceof Error ? cause.message : String(cause),
      kind: "network",
      retryable: true,
      cause,
    });
  }

  const durationMs = Date.now() - startedAt;
  const rawText = await httpResponse.text();

  if (!httpResponse.ok) {
    let googleMessage = rawText.slice(0, 400);
    let googleStatus: string | null = null;

    try {
      const parsed = googleErrorResponseSchema.safeParse(JSON.parse(rawText));
      if (parsed.success) {
        googleMessage = parsed.data.error.message ?? googleMessage;
        googleStatus = parsed.data.error.status ?? null;
      }
    } catch {
      // A non-JSON error body is still an error; keep the raw prefix.
    }

    throw new PlacesApiError({
      message: describeStatus(httpResponse.status, googleMessage),
      kind: "http",
      status: httpResponse.status,
      googleStatus,
      retryable: isRetryableStatus(httpResponse.status),
    });
  }

  let json: unknown;
  try {
    // An empty body is legal and means "no results", not a broken response.
    json = rawText.trim() === "" ? {} : JSON.parse(rawText);
  } catch (cause) {
    throw new PlacesApiError({
      message: "Google returned a 200 whose body is not JSON.",
      kind: "malformed",
      status: httpResponse.status,
      // A malformed 2xx is not transient, and retrying costs another call.
      retryable: false,
      cause,
    });
  }

  const parsed = textSearchResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new PlacesApiError({
      message:
        "Google returned a 200 that does not match the documented Text Search shape: " +
        parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
      kind: "malformed",
      status: httpResponse.status,
      retryable: false,
    });
  }

  return { response: parsed.data, httpStatus: httpResponse.status, durationMs };
}
