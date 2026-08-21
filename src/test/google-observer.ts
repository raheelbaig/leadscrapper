import { PLACES_TEXT_SEARCH_URL } from "@/lib/constants";

/**
 * A TEST-ONLY wiretap on the Google Places Text Search endpoint.
 *
 * Not imported by any production module. It exists so a live run can be
 * described afterwards -- how many requests were really made, in what order,
 * how long apart, and whether the pagination contract was honoured -- without
 * the runner having to report on itself.
 *
 * WHY IT FILTERS. The first version of this wrapped `globalThis.fetch` and
 * counted everything it saw. supabase-js also uses `fetch`, so a run that made
 * ONE Google request registered 29, and the harness failed its own
 * "at most 9 calls" assertion after the tick had already finished cleanly. The
 * run was correct; the instrument was not. It now matches on the endpoint --
 * imported from `constants.ts` rather than written out again, so it cannot
 * drift from the URL the client actually posts to -- and every request to any
 * other host passes through unrecorded.
 *
 * WHAT IT DOES NOT DO. It never blocks, delays, rewrites, or retries anything.
 * `restore()` must be called in a `finally`, so a failing assertion cannot
 * leave a wrapped `fetch` behind for the next test.
 *
 * It records the URL, the request body and a timestamp. It never touches
 * headers, which is where the API key lives.
 */

export type GoogleRequest = {
  /** Order on the wire, 0-based. Includes retries. */
  ordinal: number;
  /** Milliseconds, from the injected clock. */
  at: number;
  /**
   * Which page this request was for, 0-based.
   *
   * Derived from the page token rather than from the ordinal, so a retried
   * page keeps ITS page number instead of being counted as the next one --
   * which is the distinction that separates a retry from a real page 2.
   */
  pageIndex: number;
  pageToken: string | null;
  body: Record<string, unknown>;
};

export type GoogleObserver = {
  /** Every Places request, in order. Retries included. */
  readonly requests: GoogleRequest[];
  /** How many Places requests were made. */
  count(): number;
  /** Page index per request, in order. */
  pageIndexes(): number[];
  /** Attempts made for each page index. */
  attemptsPerPage(): Record<number, number>;
  /** Highest page index actually requested, or -1 if nothing was. */
  maxPageIndex(): number;
  /**
   * Gap between the LAST request of one page and the FIRST of the next.
   *
   * Measured this way on purpose: a gap between two attempts at the SAME page
   * is retry backoff, not the mandated token delay, and averaging the two
   * together would let a missing 2s wait hide behind a 1.5s backoff.
   */
  interPageDelaysMs(): number[];
  /**
   * True when every request was identical apart from its page token.
   *
   * Google rejects a token presented with any other parameter changed, so this
   * is the pagination contract itself, checked on the wire rather than trusted.
   */
  identicalExceptPageToken(): boolean;
  /** Request bodies with `pageToken` stripped, for inspection on failure. */
  normalizedBodies(): string[];
  /** Puts the previous `fetch` back. Safe to call more than once. */
  restore(): void;
};

export type ObserveOptions = {
  /** Defaults to `Date.now`. Injected so delay assertions need not really wait. */
  now?: () => number;
  /** Defaults to the Places Text Search endpoint from `constants.ts`. */
  endpoint?: string;
};

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  if (!init?.body) return {};
  try {
    const parsed: unknown = JSON.parse(String(init.body));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function observeGoogleRequests(options: ObserveOptions = {}): GoogleObserver {
  const now = options.now ?? Date.now;
  const endpoint = options.endpoint ?? PLACES_TEXT_SEARCH_URL;

  const previousFetch = globalThis.fetch;
  const requests: GoogleRequest[] = [];
  /** Distinct page tokens in the order Google issued them. */
  const tokenOrder: string[] = [];
  let restored = false;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    // Anything that is not the Places endpoint -- Supabase PostgREST, the RPC
    // calls, Realtime -- passes through without being seen.
    if (urlOf(input) !== endpoint) {
      return previousFetch(input, init);
    }

    const body = bodyOf(init);
    const rawToken = body.pageToken;
    const pageToken = typeof rawToken === "string" && rawToken.length > 0 ? rawToken : null;

    let pageIndex = 0;
    if (pageToken !== null) {
      const known = tokenOrder.indexOf(pageToken);
      if (known === -1) {
        tokenOrder.push(pageToken);
        pageIndex = tokenOrder.length;
      } else {
        pageIndex = known + 1;
      }
    }

    requests.push({ ordinal: requests.length, at: now(), pageIndex, pageToken, body });

    return previousFetch(input, init);
  }) as typeof fetch;

  const normalizedBodies = () =>
    requests.map((request) => {
      const copy = { ...request.body };
      delete copy.pageToken;
      return JSON.stringify(copy);
    });

  return {
    requests,
    count: () => requests.length,
    pageIndexes: () => requests.map((r) => r.pageIndex),
    attemptsPerPage: () =>
      requests.reduce<Record<number, number>>((acc, r) => {
        acc[r.pageIndex] = (acc[r.pageIndex] ?? 0) + 1;
        return acc;
      }, {}),
    maxPageIndex: () => requests.reduce((max, r) => Math.max(max, r.pageIndex), -1),
    interPageDelaysMs: () => {
      const delays: number[] = [];
      for (let i = 1; i < requests.length; i += 1) {
        if (requests[i].pageIndex !== requests[i - 1].pageIndex) {
          delays.push(requests[i].at - requests[i - 1].at);
        }
      }
      return delays;
    },
    identicalExceptPageToken: () => new Set(normalizedBodies()).size <= 1,
    normalizedBodies,
    restore: () => {
      if (restored) return;
      globalThis.fetch = previousFetch;
      restored = true;
    },
  };
}
