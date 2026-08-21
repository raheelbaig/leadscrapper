import { afterEach, describe, expect, it, vi } from "vitest";

import { PAGE_TOKEN_DELAY_MS, PLACES_TEXT_SEARCH_URL } from "@/lib/constants";
import type { QuotaClient } from "@/server/quota/quota-service";
import { paginateTile } from "@/server/search/tile-runner";

import { observeGoogleRequests, type GoogleObserver } from "./google-observer";

/**
 * The observer is the instrument that will be pointed at a real, billable run,
 * so it is tested like production code rather than trusted like a helper.
 *
 * The defect it exists to fix: the first version counted every `fetch`,
 * including supabase-js's, and reported 29 requests for a tick that made one.
 * The first case below is that defect, pinned.
 *
 * Nothing here reaches the network. The base `fetch` is a stub installed inside
 * each test, and the observer wraps whatever is current -- which is exactly how
 * it behaves in a live run, where the thing underneath is the real `fetch`.
 */

/**
 * Stand-ins for the traffic that must NOT be counted. The project ref is
 * deliberately generic: what matters is that the host is not Google's, not
 * which Supabase project it belongs to.
 */
const SUPABASE_URL = "https://example-project.supabase.co/rest/v1/search_tiles";
const REALTIME_URL = "https://example-project.supabase.co/realtime/v1/websocket";

/** A virtual clock, so delay assertions are exact and instant. */
function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

function googleBody(pageToken?: string) {
  return JSON.stringify({
    textQuery: "Embroidery Shops",
    locationRestriction: {
      rectangle: {
        low: { latitude: 29.69, longitude: -95.3933 },
        high: { latitude: 29.76, longitude: -95.3367 },
      },
    },
    pageSize: 20,
    ...(pageToken ? { pageToken } : {}),
  });
}

let live: GoogleObserver | null = null;

afterEach(() => {
  // A failing assertion must never leave a wrapped fetch behind.
  live?.restore();
  live = null;
});

describe("it watches only Google", () => {
  it("ignores Supabase REST and Realtime traffic", async () => {
    // THE regression. supabase-js uses fetch too, and counting its round trips
    // made a one-request tick look like twenty-nine.
    const base = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = base as unknown as typeof fetch;

    live = observeGoogleRequests();

    await fetch(SUPABASE_URL, { method: "POST", body: '{"rpc":"reserve_api_calls"}' });
    await fetch(REALTIME_URL);
    await fetch(PLACES_TEXT_SEARCH_URL, { method: "POST", body: googleBody() });
    await fetch(SUPABASE_URL, { method: "POST", body: '{"rpc":"record_api_call"}' });

    expect(live.count()).toBe(1);
    // Everything still reached the underlying fetch: it observes, never blocks.
    expect(base).toHaveBeenCalledTimes(4);
  });

  it("passes the real response through untouched", async () => {
    const base = vi.fn(async () => new Response('{"places":[{"id":"x"}]}', { status: 201 }));
    globalThis.fetch = base as unknown as typeof fetch;

    live = observeGoogleRequests();

    const response = await fetch(PLACES_TEXT_SEARCH_URL, { method: "POST", body: googleBody() });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ places: [{ id: "x" }] });
  });

  it("forwards the arguments it was given, unmodified", async () => {
    const base = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = base as unknown as typeof fetch;

    live = observeGoogleRequests();
    const init = { method: "POST", body: googleBody(), cache: "no-store" as const };
    await fetch(PLACES_TEXT_SEARCH_URL, init);

    expect(base).toHaveBeenCalledWith(PLACES_TEXT_SEARCH_URL, init);
  });

  it("accepts a Request object or a URL, not just a string", async () => {
    const base = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = base as unknown as typeof fetch;

    live = observeGoogleRequests();

    await fetch(new URL(PLACES_TEXT_SEARCH_URL), { method: "POST", body: googleBody() });
    await fetch(new Request(PLACES_TEXT_SEARCH_URL, { method: "POST", body: googleBody() }));

    expect(live.count()).toBe(2);
  });

  it("restores the previous fetch, and is safe to restore twice", async () => {
    const base = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = base as unknown as typeof fetch;

    const observer = observeGoogleRequests();
    expect(globalThis.fetch).not.toBe(base);

    observer.restore();
    observer.restore();
    expect(globalThis.fetch).toBe(base);
  });
});

describe("it numbers pages by token, not by ordinal", () => {
  it("calls the tokenless request page 0 and each new token the next page", async () => {
    const base = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = base as unknown as typeof fetch;
    live = observeGoogleRequests();

    await fetch(PLACES_TEXT_SEARCH_URL, { method: "POST", body: googleBody() });
    await fetch(PLACES_TEXT_SEARCH_URL, { method: "POST", body: googleBody("tok-1") });
    await fetch(PLACES_TEXT_SEARCH_URL, { method: "POST", body: googleBody("tok-2") });

    expect(live.pageIndexes()).toEqual([0, 1, 2]);
    expect(live.maxPageIndex()).toBe(2);
  });

  it("gives a RETRY the same page index, not the next one", async () => {
    // The distinction that matters: three requests can be one page retried
    // twice, or three real pages. Counting ordinals cannot tell them apart.
    const base = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = base as unknown as typeof fetch;
    live = observeGoogleRequests();

    await fetch(PLACES_TEXT_SEARCH_URL, { method: "POST", body: googleBody() });
    await fetch(PLACES_TEXT_SEARCH_URL, { method: "POST", body: googleBody() });
    await fetch(PLACES_TEXT_SEARCH_URL, { method: "POST", body: googleBody("tok-1") });
    await fetch(PLACES_TEXT_SEARCH_URL, { method: "POST", body: googleBody("tok-1") });

    expect(live.pageIndexes()).toEqual([0, 0, 1, 1]);
    expect(live.attemptsPerPage()).toEqual({ 0: 2, 1: 2 });
    expect(live.maxPageIndex()).toBe(1);
    expect(live.count()).toBe(4);
  });
});

describe("it measures the delay between pages", () => {
  it("reports the gap from the last request of a page to the first of the next", async () => {
    const base = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = base as unknown as typeof fetch;
    const time = clock();
    live = observeGoogleRequests({ now: time.now });

    await fetch(PLACES_TEXT_SEARCH_URL, { method: "POST", body: googleBody() });
    time.advance(2_000);
    await fetch(PLACES_TEXT_SEARCH_URL, { method: "POST", body: googleBody("tok-1") });
    time.advance(2_100);
    await fetch(PLACES_TEXT_SEARCH_URL, { method: "POST", body: googleBody("tok-2") });

    expect(live.interPageDelaysMs()).toEqual([2_000, 2_100]);
    expect(live.interPageDelaysMs().every((ms) => ms >= PAGE_TOKEN_DELAY_MS)).toBe(true);
  });

  it("does NOT mistake retry backoff for the token delay", async () => {
    // A 1.5s backoff between two attempts at page 0 must not be averaged in
    // with the mandated 2s wait, or a missing wait could hide behind it.
    const base = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = base as unknown as typeof fetch;
    const time = clock();
    live = observeGoogleRequests({ now: time.now });

    await fetch(PLACES_TEXT_SEARCH_URL, { method: "POST", body: googleBody() });
    time.advance(1_500);
    await fetch(PLACES_TEXT_SEARCH_URL, { method: "POST", body: googleBody() });
    time.advance(2_000);
    await fetch(PLACES_TEXT_SEARCH_URL, { method: "POST", body: googleBody("tok-1") });

    expect(live.interPageDelaysMs()).toEqual([2_000]);
  });

  it("reports no delays at all for a single-page tile", async () => {
    const base = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = base as unknown as typeof fetch;
    live = observeGoogleRequests({ now: clock().now });

    await fetch(PLACES_TEXT_SEARCH_URL, { method: "POST", body: googleBody() });

    expect(live.interPageDelaysMs()).toEqual([]);
    expect(live.maxPageIndex()).toBe(0);
  });
});

describe("it checks the pagination contract on the wire", () => {
  it("confirms every page differed only by its token", async () => {
    const base = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = base as unknown as typeof fetch;
    live = observeGoogleRequests();

    await fetch(PLACES_TEXT_SEARCH_URL, { method: "POST", body: googleBody() });
    await fetch(PLACES_TEXT_SEARCH_URL, { method: "POST", body: googleBody("tok-1") });

    expect(live.identicalExceptPageToken()).toBe(true);
    expect(new Set(live.normalizedBodies()).size).toBe(1);
  });

  it("catches a rectangle that changed between pages", async () => {
    // Google answers INVALID_ARGUMENT for this, and the wasted call is billed.
    const base = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = base as unknown as typeof fetch;
    live = observeGoogleRequests();

    await fetch(PLACES_TEXT_SEARCH_URL, { method: "POST", body: googleBody() });
    await fetch(PLACES_TEXT_SEARCH_URL, {
      method: "POST",
      body: JSON.stringify({
        textQuery: "Embroidery Shops",
        locationRestriction: { rectangle: { low: {}, high: {} } },
        pageSize: 20,
        pageToken: "tok-1",
      }),
    });

    expect(live.identicalExceptPageToken()).toBe(false);
  });

  it("catches a changed textQuery between pages", async () => {
    const base = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = base as unknown as typeof fetch;
    live = observeGoogleRequests();

    await fetch(PLACES_TEXT_SEARCH_URL, { method: "POST", body: googleBody() });
    await fetch(PLACES_TEXT_SEARCH_URL, {
      method: "POST",
      body: googleBody("tok-1").replace("Embroidery Shops", "Embroidery Shops in Houston"),
    });

    expect(live.identicalExceptPageToken()).toBe(false);
  });
});

describe("against the real pagination path", () => {
  /** Records the RPC sequence and always grants. */
  function fakeDb() {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const db = {
      rpc: (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        if (name === "reserve_api_calls") {
          return Promise.resolve({
            data: [
              { granted: true, used: 1, remaining: 949, period: "2026-08", effective_limit: 950 },
            ],
            error: null,
          });
        }
        return Promise.resolve({ data: name === "record_api_call" ? 1 : null, error: null });
      },
    };
    return { db: db as unknown as QuotaClient, calls };
  }

  it("observes a real three-page tile without being passed a fetchImpl", async () => {
    // paginateTile is given NO fetchImpl here, exactly as the production tick
    // leaves it -- so what the observer wraps is the same global the live run
    // uses. This is the end-to-end proof that the instrument works in place.
    const time = clock();
    let served = 0;

    globalThis.fetch = (async () => {
      served += 1;
      const body =
        served === 1
          ? { places: [{ id: "a" }], nextPageToken: "tok-1" }
          : served === 2
            ? { places: [{ id: "b" }], nextPageToken: "tok-2" }
            : { places: [{ id: "c" }] };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;

    live = observeGoogleRequests({ now: time.now });
    const { db, calls } = fakeDb();

    const result = await paginateTile(
      {
        sku: "places-text-search-enterprise",
        searchId: "11111111-1111-4111-8111-111111111111",
        tileId: "22222222-2222-4222-8222-222222222222",
        textQuery: "Embroidery Shops",
        bbox: { minLat: 29.69, minLng: -95.3933, maxLat: 29.76, maxLng: -95.3367 },
      },
      // The injected sleep advances the virtual clock instead of waiting, so
      // the delay the runner actually performs is what gets measured.
      { db, sleep: async (ms) => time.advance(ms) },
    );

    expect(result.pagesFetched).toBe(3);
    expect(result.outcome).toBe("exhausted");

    expect(live.count()).toBe(3);
    expect(live.pageIndexes()).toEqual([0, 1, 2]);
    expect(live.attemptsPerPage()).toEqual({ 0: 1, 1: 1, 2: 1 });
    expect(live.interPageDelaysMs()).toEqual([PAGE_TOKEN_DELAY_MS, PAGE_TOKEN_DELAY_MS]);
    expect(live.identicalExceptPageToken()).toBe(true);

    // And the Supabase RPCs it saw alongside were not counted as Google calls.
    expect(calls.filter((c) => c.name === "reserve_api_calls")).toHaveLength(3);
    expect(live.count()).toBe(3);
  });

  it("counts a retried page as one page and two requests", async () => {
    const time = clock();
    let served = 0;

    globalThis.fetch = (async () => {
      served += 1;
      if (served === 1) {
        return new Response(JSON.stringify({ error: { message: "slow down" } }), { status: 429 });
      }
      return new Response(JSON.stringify({ places: [{ id: "a" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    live = observeGoogleRequests({ now: time.now });
    const { db } = fakeDb();

    const result = await paginateTile(
      {
        sku: "places-text-search-enterprise",
        searchId: "11111111-1111-4111-8111-111111111111",
        tileId: "22222222-2222-4222-8222-222222222222",
        textQuery: "Embroidery Shops",
        bbox: { minLat: 29.69, minLng: -95.3933, maxLat: 29.76, maxLng: -95.3367 },
      },
      { db, sleep: async (ms) => time.advance(ms), maxAttempts: 3 },
    );

    expect(result.pagesFetched).toBe(1);
    expect(live.count()).toBe(2);
    expect(live.pageIndexes()).toEqual([0, 0]);
    expect(live.attemptsPerPage()).toEqual({ 0: 2 });
    // Two requests, but only one page -- so no inter-page delay exists.
    expect(live.interPageDelaysMs()).toEqual([]);
  });
});
