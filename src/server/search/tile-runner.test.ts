import { beforeEach, describe, expect, it, vi } from "vitest";

import { PAGE_TOKEN_DELAY_MS } from "@/lib/constants";
import type { BoundingBox } from "@/lib/geo/bbox";
import { QuotaBlockedError, type QuotaClient } from "@/server/quota/quota-service";

import { SEARCH_LIMITS } from "./limits";
import { fetchTilePage, paginateTile, type TilePageEvent } from "./tile-runner";

/**
 * The catalog really is unverified, and the reserve guard really does refuse
 * while it is -- which is one of the cases under test. A hoisted flag lets the
 * granted and denied paths be exercised too, without editing catalog.json.
 */
const state = vi.hoisted(() => ({ verified: true }));

vi.mock("@/server/pricing/pricing-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/pricing/pricing-service")>();
  return { ...actual, isVerified: () => state.verified };
});

const SKU = "places-text-search-enterprise";
const BBOX: BoundingBox = { minLat: 29.74, minLng: -95.38, maxLat: 29.77, maxLng: -95.35 };

const ARGS = {
  sku: SKU,
  searchId: "11111111-1111-4111-8111-111111111111",
  tileId: "22222222-2222-4222-8222-222222222222",
  textQuery: "Embroidery Shops",
  bbox: BBOX,
  pageIndex: 0,
};

type RpcCall = { name: string; args: Record<string, unknown> };

/**
 * A Supabase stand-in that records the exact sequence of RPCs. The ORDER is the
 * property under test: nothing may reach Google before reserve_api_calls has
 * granted.
 */
function fakeDb(options: { grants?: boolean[] } = {}) {
  const calls: RpcCall[] = [];
  let reserveIndex = 0;

  const db = {
    rpc: (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });

      if (name === "reserve_api_calls") {
        const granted = options.grants?.[reserveIndex] ?? true;
        reserveIndex += 1;
        return Promise.resolve({
          data: [
            {
              granted,
              used: granted ? 1 : 950,
              remaining: granted ? 949 : 0,
              period: "2026-08",
              effective_limit: 950,
            },
          ],
          error: null,
        });
      }

      if (name === "release_api_calls") return Promise.resolve({ data: 0, error: null });
      if (name === "record_api_call") return Promise.resolve({ data: 1, error: null });
      return Promise.resolve({ data: null, error: null });
    },
  };

  return { db: db as unknown as QuotaClient, calls };
}

const OK_BODY = {
  places: [{ id: "ChIJ1", displayName: { text: "Shop One" } }],
};

function stubFetch(responses: Array<{ status: number; body: unknown } | "network-error">) {
  let index = 0;
  const impl = vi.fn(async () => {
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next === "network-error") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  });
  return { impl: impl as unknown as typeof fetch, calledTimes: () => index };
}

const noSleep = async () => {};

beforeEach(() => {
  state.verified = true;
});

describe("reservation comes first", () => {
  it("reserves before it calls Google, every time", async () => {
    const { db, calls } = fakeDb();
    const { impl } = stubFetch([{ status: 200, body: OK_BODY }]);

    const result = await fetchTilePage(ARGS, { db, fetchImpl: impl, sleep: noSleep });

    expect(result.kind).toBe("ok");
    // The very first thing that happened was the budget guard.
    expect(calls[0].name).toBe("reserve_api_calls");
    expect(calls[0].args).toMatchObject({ p_sku: SKU, p_n: 1 });
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it("reserves ONE call per page, because Google bills per page", async () => {
    const { db, calls } = fakeDb();
    const { impl } = stubFetch([{ status: 200, body: OK_BODY }]);

    await fetchTilePage(ARGS, { db, fetchImpl: impl, sleep: noSleep });

    const reserves = calls.filter((c) => c.name === "reserve_api_calls");
    expect(reserves).toHaveLength(1);
    expect(reserves[0].args.p_n).toBe(1);
  });

  it("makes NO Google request when the reservation is denied", async () => {
    const { db, calls } = fakeDb({ grants: [false] });
    const { impl } = stubFetch([{ status: 200, body: OK_BODY }]);

    const result = await fetchTilePage(ARGS, { db, fetchImpl: impl, sleep: noSleep });

    expect(result.kind).toBe("quota-denied");
    expect(impl).not.toHaveBeenCalled();
    expect(result.callsMade).toBe(0);
    // A denial is a normal outcome, not an error, and nothing was recorded.
    expect(calls.filter((c) => c.name === "record_api_call")).toHaveLength(0);
  });

  it("reports what remains, so the tile can say why it was skipped", async () => {
    const { db } = fakeDb({ grants: [false] });
    const { impl } = stubFetch([{ status: 200, body: OK_BODY }]);

    const result = await fetchTilePage(ARGS, { db, fetchImpl: impl, sleep: noSleep });

    expect(result).toMatchObject({ kind: "quota-denied", remaining: 0, period: "2026-08" });
  });

  it("refuses outright while the pricing catalog is unverified", async () => {
    state.verified = false;
    const { db, calls } = fakeDb();
    const { impl } = stubFetch([{ status: 200, body: OK_BODY }]);

    await expect(fetchTilePage(ARGS, { db, fetchImpl: impl, sleep: noSleep })).rejects.toThrow(
      QuotaBlockedError,
    );

    // Stopped before Postgres and before Google.
    expect(impl).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});

describe("recording and refunds", () => {
  it("records a successful call as billable", async () => {
    const { db, calls } = fakeDb();
    const { impl } = stubFetch([{ status: 200, body: OK_BODY }]);

    await fetchTilePage(ARGS, { db, fetchImpl: impl, sleep: noSleep });

    const record = calls.find((c) => c.name === "record_api_call");
    expect(record?.args).toMatchObject({
      p_sku: SKU,
      p_billable: true,
      p_http_status: 200,
      p_result_count: 1,
      p_search_id: ARGS.searchId,
      p_tile_id: ARGS.tileId,
      p_page_index: 0,
    });
    expect(calls.filter((c) => c.name === "release_api_calls")).toHaveLength(0);
  });

  it("refunds a network failure, which Google never metered", async () => {
    const { db, calls } = fakeDb();
    const { impl } = stubFetch(["network-error"]);

    const result = await fetchTilePage(ARGS, {
      db,
      fetchImpl: impl,
      sleep: noSleep,
      maxAttempts: 1,
    });

    expect(result.kind).toBe("error");
    expect(calls.filter((c) => c.name === "release_api_calls")).toHaveLength(1);
    expect(result.callsMade).toBe(0);

    const record = calls.find((c) => c.name === "record_api_call");
    expect(record?.args.p_billable).toBe(false);
  });

  it("does NOT refund an HTTP error, which may have been metered", async () => {
    // The local counter is an estimate; over-counting against ourselves is the
    // safe direction, and the reserve exists to absorb exactly this drift.
    const { db, calls } = fakeDb();
    const { impl } = stubFetch([{ status: 400, body: { error: { message: "bad mask" } } }]);

    const result = await fetchTilePage(ARGS, { db, fetchImpl: impl, sleep: noSleep });

    expect(result.kind).toBe("error");
    expect(calls.filter((c) => c.name === "release_api_calls")).toHaveLength(0);
    expect(result.callsMade).toBe(1);
  });
});

describe("bounded retries", () => {
  it("retries a transient failure up to the phase cap by default", async () => {
    // The cap lives in SEARCH_LIMITS, so every caller inherits it -- the API
    // route, the Run button and any script alike. Phase 3A pinned this at one
    // attempt; Phase 3B raised it deliberately, alongside pagination.
    const { db, calls } = fakeDb();
    const { impl } = stubFetch([{ status: 500, body: { error: { message: "boom" } } }]);

    const result = await fetchTilePage(ARGS, { db, fetchImpl: impl, sleep: noSleep });

    expect(result.kind).toBe("error");
    expect(impl).toHaveBeenCalledTimes(SEARCH_LIMITS.maxAttemptsPerPage);
    // Every attempt is a separate billable request, so every attempt reserved.
    expect(calls.filter((c) => c.name === "reserve_api_calls")).toHaveLength(
      SEARCH_LIMITS.maxAttemptsPerPage,
    );
  });

  it("cannot be widened past the phase cap by an option", async () => {
    const { db } = fakeDb();
    const { impl } = stubFetch([{ status: 500, body: { error: { message: "boom" } } }]);

    await fetchTilePage(ARGS, { db, fetchImpl: impl, sleep: noSleep, maxAttempts: 99 });

    expect(impl).toHaveBeenCalledTimes(SEARCH_LIMITS.maxAttemptsPerPage);
  });

  it("does not retry a 400", async () => {
    const { db, calls } = fakeDb();
    const { impl } = stubFetch([{ status: 400, body: { error: { message: "bad request" } } }]);

    const result = await fetchTilePage(ARGS, { db, fetchImpl: impl, sleep: noSleep });

    expect(result.kind).toBe("error");
    expect(impl).toHaveBeenCalledTimes(1);
    // One attempt means one reservation. Retrying would spend the allowance to
    // receive the identical rejection.
    expect(calls.filter((c) => c.name === "reserve_api_calls")).toHaveLength(1);
  });

  for (const status of [401, 403, 404]) {
    it(`does not retry a ${status}`, async () => {
      const { db } = fakeDb();
      const { impl } = stubFetch([{ status, body: { error: { message: "nope" } } }]);

      const result = await fetchTilePage(ARGS, { db, fetchImpl: impl, sleep: noSleep });

      expect(result.kind).toBe("error");
      expect(impl).toHaveBeenCalledTimes(1);
    });
  }

  it("retries a 429 and succeeds on the second attempt", async () => {
    const { db, calls } = fakeDb();
    const { impl } = stubFetch([
      { status: 429, body: { error: { message: "slow down" } } },
      { status: 200, body: OK_BODY },
    ]);

    const result = await fetchTilePage(ARGS, {
      db,
      fetchImpl: impl,
      sleep: noSleep,
      maxAttempts: 3,
    });

    expect(result.kind).toBe("ok");
    expect(impl).toHaveBeenCalledTimes(2);
    // Two attempts, two reservations: a retry is a second billable request and
    // must pass through the guard again.
    expect(calls.filter((c) => c.name === "reserve_api_calls")).toHaveLength(2);
    if (result.kind === "ok") {
      expect(result.callsMade).toBe(2);
      expect(result.attempts).toBe(2);
    }
  });

  it("retries a 500 up to the attempt ceiling and then gives up", async () => {
    const { db, calls } = fakeDb();
    const { impl } = stubFetch([{ status: 500, body: { error: { message: "boom" } } }]);

    const result = await fetchTilePage(ARGS, {
      db,
      fetchImpl: impl,
      sleep: noSleep,
      maxAttempts: 3,
    });

    expect(result.kind).toBe("error");
    expect(impl).toHaveBeenCalledTimes(3);
    expect(calls.filter((c) => c.name === "reserve_api_calls")).toHaveLength(3);
    if (result.kind === "error") expect(result.attempts).toBe(3);
  });

  it("stops retrying the moment a reservation is denied", async () => {
    // Never retry a request whose reservation did not succeed.
    const { db } = fakeDb({ grants: [true, false] });
    const { impl } = stubFetch([{ status: 500, body: { error: { message: "boom" } } }]);

    const result = await fetchTilePage(ARGS, {
      db,
      fetchImpl: impl,
      sleep: noSleep,
      maxAttempts: 3,
    });

    expect(result.kind).toBe("quota-denied");
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it("never exceeds the Phase 3A attempt ceiling", async () => {
    const { db, calls } = fakeDb();
    const { impl } = stubFetch(["network-error"]);

    await fetchTilePage(ARGS, { db, fetchImpl: impl, sleep: noSleep, maxAttempts: 3 });

    expect(impl).toHaveBeenCalledTimes(3);
    expect(calls.filter((c) => c.name === "reserve_api_calls").length).toBeLessThanOrEqual(3);
  });
});

describe("the request itself", () => {
  it("sends the tile rectangle and the niche alone", async () => {
    const { db } = fakeDb();
    let sentBody: Record<string, unknown> = {};

    const impl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(OK_BODY), { status: 200 });
    }) as unknown as typeof fetch;

    await fetchTilePage(ARGS, { db, fetchImpl: impl, sleep: noSleep });

    expect(sentBody.textQuery).toBe("Embroidery Shops");
    expect(sentBody.locationRestriction).toEqual({
      rectangle: {
        low: { latitude: BBOX.minLat, longitude: BBOX.minLng },
        high: { latitude: BBOX.maxLat, longitude: BBOX.maxLng },
      },
    });
  });

  it("keeps every parameter identical across a retry", async () => {
    // Google rejects a page token presented with any other parameter changed.
    const { db } = fakeDb();
    const bodies: string[] = [];

    const impl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify({ error: { message: "rate" } }), { status: 429 });
    }) as unknown as typeof fetch;

    await fetchTilePage(
      { ...ARGS, pageToken: "tok-1" },
      { db, fetchImpl: impl, sleep: noSleep, maxAttempts: 3 },
    );

    expect(bodies.length).toBeGreaterThan(1);
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]).pageToken).toBe("tok-1");
  });
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

const PAGINATE_ARGS = {
  sku: SKU,
  searchId: ARGS.searchId,
  tileId: ARGS.tileId,
  textQuery: ARGS.textQuery,
  bbox: BBOX,
};

/** A page of `count` places with distinct ids, optionally offering a token. */
function page(count: number, nextPageToken?: string, idPrefix = "p") {
  return {
    status: 200,
    body: {
      places: Array.from({ length: count }, (_, i) => ({
        id: `${idPrefix}-${i}`,
        displayName: { text: `Shop ${idPrefix}-${i}` },
      })),
      ...(nextPageToken ? { nextPageToken } : {}),
    },
  };
}

/** Records every request body and answers with the given pages in order. */
function stubPages(pages: Array<{ status: number; body: unknown }>) {
  const bodies: Record<string, unknown>[] = [];
  let index = 0;

  const impl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const next = pages[Math.min(index, pages.length - 1)];
    index += 1;
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  return { impl, bodies, calls: () => index };
}

/** Records what was slept for, so the token delay can be asserted separately. */
function recordingSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

describe("pagination: how many pages", () => {
  it("stops after one page when Google offers no token", async () => {
    const { db } = fakeDb();
    const { impl, calls } = stubPages([page(7)]);

    const result = await paginateTile(PAGINATE_ARGS, { db, fetchImpl: impl, sleep: noSleep });

    expect(calls()).toBe(1);
    expect(result.pagesFetched).toBe(1);
    expect(result.outcome).toBe("exhausted");
    expect(result.tokenRemaining).toBe(false);
    expect(result.resultsCount).toBe(7);
  });

  it("fetches a second page when a token comes back", async () => {
    const { db } = fakeDb();
    const { impl, bodies } = stubPages([page(20, "tok-1", "a"), page(11, undefined, "b")]);

    const result = await paginateTile(PAGINATE_ARGS, { db, fetchImpl: impl, sleep: noSleep });

    expect(bodies).toHaveLength(2);
    expect(bodies[0].pageToken).toBeUndefined();
    expect(bodies[1].pageToken).toBe("tok-1");
    expect(result.pagesFetched).toBe(2);
    expect(result.resultsCount).toBe(31);
    expect(result.outcome).toBe("exhausted");
  });

  it("fetches a third page when page 2 also returns a token", async () => {
    const { db } = fakeDb();
    const { impl, bodies } = stubPages([
      page(20, "tok-1", "a"),
      page(20, "tok-2", "b"),
      page(20, undefined, "c"),
    ]);

    const result = await paginateTile(PAGINATE_ARGS, { db, fetchImpl: impl, sleep: noSleep });

    expect(bodies).toHaveLength(3);
    expect(bodies[1].pageToken).toBe("tok-1");
    expect(bodies[2].pageToken).toBe("tok-2");
    expect(result.pagesFetched).toBe(3);
    expect(result.resultsCount).toBe(60);
  });

  it("NEVER fetches a fourth page, however many tokens Google offers", async () => {
    // 20 x 3 = 60 per query is Google's hard ceiling. A fourth request is not a
    // bigger result set, it is a wasted billable call.
    const { db, calls } = fakeDb();
    const { impl, calls: fetches } = stubPages([
      page(20, "tok-1", "a"),
      page(20, "tok-2", "b"),
      page(20, "tok-3", "c"),
      page(20, "tok-4", "d"),
    ]);

    const result = await paginateTile(PAGINATE_ARGS, { db, fetchImpl: impl, sleep: noSleep });

    expect(fetches()).toBe(3);
    expect(calls.filter((c) => c.name === "reserve_api_calls")).toHaveLength(3);
    expect(result.pagesFetched).toBe(3);
    // A token still outstanding is what R4 reads as truncation.
    expect(result.outcome).toBe("page-limit");
    expect(result.tokenRemaining).toBe(true);
  });

  it("honours a lower page cap than the phase ceiling", async () => {
    const { db } = fakeDb();
    const { impl, calls: fetches } = stubPages([page(20, "tok-1", "a"), page(20, "tok-2", "b")]);

    const result = await paginateTile(PAGINATE_ARGS, {
      db,
      fetchImpl: impl,
      sleep: noSleep,
      maxPages: 1,
    });

    expect(fetches()).toBe(1);
    expect(result.outcome).toBe("page-limit");
    expect(result.tokenRemaining).toBe(true);
  });

  it("cannot be widened past the phase ceiling by an option", async () => {
    const { db } = fakeDb();
    const { impl, calls: fetches } = stubPages([page(20, "tok", "a")]);

    await paginateTile(PAGINATE_ARGS, {
      db,
      fetchImpl: impl,
      sleep: noSleep,
      maxPages: 10,
    });

    expect(fetches()).toBe(3);
  });
});

describe("pagination: the token delay", () => {
  it("waits ~2s before using a page token", async () => {
    const { db } = fakeDb();
    const { impl } = stubPages([page(20, "tok-1", "a"), page(5, undefined, "b")]);
    const { waits, sleep } = recordingSleep();

    await paginateTile(PAGINATE_ARGS, { db, fetchImpl: impl, sleep });

    expect(waits).toContain(PAGE_TOKEN_DELAY_MS);
    expect(PAGE_TOKEN_DELAY_MS).toBe(2_000);
  });

  it("does NOT wait before page 1", async () => {
    // Nothing to wait for: there is no token yet, and a needless 2s on every
    // single-page tile would be pure latency.
    const { db } = fakeDb();
    const { impl } = stubPages([page(7)]);
    const { waits, sleep } = recordingSleep();

    await paginateTile(PAGINATE_ARGS, { db, fetchImpl: impl, sleep });

    expect(waits).toEqual([]);
  });

  it("waits once per extra page, not once per tile", async () => {
    const { db } = fakeDb();
    const { impl } = stubPages([
      page(20, "tok-1", "a"),
      page(20, "tok-2", "b"),
      page(20, undefined, "c"),
    ]);
    const { waits, sleep } = recordingSleep();

    await paginateTile(PAGINATE_ARGS, { db, fetchImpl: impl, sleep });

    expect(waits.filter((ms) => ms === PAGE_TOKEN_DELAY_MS)).toHaveLength(2);
  });
});

describe("pagination: identical request parameters", () => {
  it("changes ONLY the page token between pages", async () => {
    // Google answers INVALID_ARGUMENT if any other parameter differs when a
    // token is presented.
    const { db } = fakeDb();
    const { impl, bodies } = stubPages([
      page(20, "tok-1", "a"),
      page(20, "tok-2", "b"),
      page(20, undefined, "c"),
    ]);

    await paginateTile(PAGINATE_ARGS, { db, fetchImpl: impl, sleep: noSleep });

    const withoutToken = bodies.map((body) => {
      const copy = { ...body };
      delete copy.pageToken;
      return JSON.stringify(copy);
    });
    expect(new Set(withoutToken).size).toBe(1);
  });

  it("keeps the same rectangle and the same niche on every page", async () => {
    const { db } = fakeDb();
    const { impl, bodies } = stubPages([page(20, "tok-1", "a"), page(3, undefined, "b")]);

    await paginateTile(PAGINATE_ARGS, { db, fetchImpl: impl, sleep: noSleep });

    for (const body of bodies) {
      expect(body.textQuery).toBe("Embroidery Shops");
      expect(body.locationRestriction).toEqual({
        rectangle: {
          low: { latitude: BBOX.minLat, longitude: BBOX.minLng },
          high: { latitude: BBOX.maxLat, longitude: BBOX.maxLng },
        },
      });
    }
  });

  it("keeps them identical across a retry inside a page, too", async () => {
    const { db } = fakeDb();
    const bodies: string[] = [];

    const impl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const raw = String(init?.body);
      const isPageTwo = JSON.parse(raw).pageToken === "tok-1";
      const priorPageTwoAttempts = bodies.filter((b) => b.includes("tok-1")).length;
      bodies.push(raw);

      if (isPageTwo && priorPageTwoAttempts === 0) {
        return new Response(JSON.stringify({ error: { message: "slow down" } }), { status: 429 });
      }
      return new Response(
        JSON.stringify(isPageTwo ? page(5, undefined, "b").body : page(20, "tok-1", "a").body),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await paginateTile(PAGINATE_ARGS, { db, fetchImpl: impl, sleep: noSleep, maxAttempts: 3 });

    const pageTwoBodies = bodies.filter((b) => b.includes("tok-1"));
    expect(pageTwoBodies).toHaveLength(2);
    expect(new Set(pageTwoBodies).size).toBe(1);
  });
});

describe("pagination: one reservation per page", () => {
  it("reserves separately for every page, because Google bills per page", async () => {
    const { db, calls } = fakeDb();
    const { impl } = stubPages([
      page(20, "tok-1", "a"),
      page(20, "tok-2", "b"),
      page(20, undefined, "c"),
    ]);

    const result = await paginateTile(PAGINATE_ARGS, { db, fetchImpl: impl, sleep: noSleep });

    const reserves = calls.filter((c) => c.name === "reserve_api_calls");
    expect(reserves).toHaveLength(3);
    // Never one reservation of 3 for the whole tile.
    expect(reserves.every((r) => r.args.p_n === 1)).toBe(true);
    expect(result.callsMade).toBe(3);
  });

  it("records every page against its own page index", async () => {
    const { db, calls } = fakeDb();
    const { impl } = stubPages([page(20, "tok-1", "a"), page(4, undefined, "b")]);

    await paginateTile(PAGINATE_ARGS, { db, fetchImpl: impl, sleep: noSleep });

    const records = calls.filter((c) => c.name === "record_api_call");
    expect(records.map((r) => r.args.p_page_index)).toEqual([0, 1]);
  });

  it("makes NO further Google request when page 2 is denied", async () => {
    const { db, calls } = fakeDb({ grants: [true, false] });
    const { impl, calls: fetches } = stubPages([page(20, "tok-1", "a"), page(20, undefined, "b")]);

    const result = await paginateTile(PAGINATE_ARGS, { db, fetchImpl: impl, sleep: noSleep });

    expect(fetches()).toBe(1);
    expect(result.outcome).toBe("quota-denied");
    expect(result.pagesFetched).toBe(1);
    // The refused page is still owed, so the tile is not finished.
    expect(result.tokenRemaining).toBe(true);
    expect(result.quota).toMatchObject({ remaining: 0, period: "2026-08" });
    expect(calls.filter((c) => c.name === "reserve_api_calls")).toHaveLength(2);
  });

  it("keeps the leads from the pages it did fetch", async () => {
    const { db } = fakeDb({ grants: [true, false] });
    const { impl } = stubPages([page(20, "tok-1", "a")]);
    const seen: number[] = [];

    const result = await paginateTile(PAGINATE_ARGS, {
      db,
      fetchImpl: impl,
      sleep: noSleep,
      onPage: async (event) => void seen.push(event.response.places.length),
    });

    expect(seen).toEqual([20]);
    expect(result.resultsCount).toBe(20);
  });

  it("re-reserves for a retry and then carries on paginating", async () => {
    const { db, calls } = fakeDb();
    let index = 0;
    const impl = vi.fn(async () => {
      index += 1;
      if (index === 1) {
        return new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 });
      }
      const body = index === 2 ? page(20, "tok-1", "a").body : page(6, undefined, "b").body;
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await paginateTile(PAGINATE_ARGS, {
      db,
      fetchImpl: impl,
      sleep: noSleep,
      maxAttempts: 3,
    });

    // 3 requests: a failed page 1, a successful page 1, a successful page 2.
    expect(index).toBe(3);
    expect(calls.filter((c) => c.name === "reserve_api_calls")).toHaveLength(3);
    expect(result.pagesFetched).toBe(2);
    expect(result.callsMade).toBe(3);
    expect(result.outcome).toBe("exhausted");
  });

  it("stops the tile when a page fails after every attempt", async () => {
    const { db } = fakeDb();
    let index = 0;
    const failing = vi.fn(async () => {
      index += 1;
      if (index === 1) {
        return new Response(JSON.stringify(page(20, "tok-1", "a").body), { status: 200 });
      }
      return new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 });
    }) as unknown as typeof fetch;

    const result = await paginateTile(PAGINATE_ARGS, {
      db,
      fetchImpl: failing,
      sleep: noSleep,
      maxAttempts: 2,
    });

    expect(result.outcome).toBe("error");
    expect(result.pagesFetched).toBe(1);
    expect(result.error?.status).toBe(500);
  });
});

describe("pagination: persistence and counting", () => {
  it("hands every page to onPage BEFORE requesting the next one", async () => {
    // This is what makes a tick that dies mid-tile lose at most one page.
    const { db } = fakeDb();
    const order: string[] = [];
    let requests = 0;

    const impl = vi.fn(async () => {
      requests += 1;
      order.push(`request-${requests}`);
      const body = requests === 1 ? page(20, "tok-1", "a").body : page(4, undefined, "b").body;
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;

    await paginateTile(PAGINATE_ARGS, {
      db,
      fetchImpl: impl,
      sleep: noSleep,
      onPage: async (event) => void order.push(`persist-${event.pageIndex + 1}`),
    });

    expect(order).toEqual(["request-1", "persist-1", "request-2", "persist-2"]);
  });

  it("reports cumulative figures on every page event", async () => {
    const { db } = fakeDb();
    const { impl } = stubPages([page(20, "tok-1", "a"), page(15, undefined, "b")]);
    const events: TilePageEvent[] = [];

    await paginateTile(PAGINATE_ARGS, {
      db,
      fetchImpl: impl,
      sleep: noSleep,
      onPage: async (event) => void events.push(event),
    });

    expect(events.map((e) => e.cumulativeResults)).toEqual([20, 35]);
    expect(events.map((e) => e.cumulativePages)).toEqual([1, 2]);
    expect(events.map((e) => e.cumulativeCalls)).toEqual([1, 2]);
    expect(events.map((e) => e.tokenPresent)).toEqual([true, false]);
  });

  it("counts a place Google repeats across pages only once", async () => {
    // R decides whether a tile subdivides. A duplicate inflating it would split
    // an area that was never saturated -- and each split costs four more tiles.
    const { db } = fakeDb();
    const { impl } = stubPages([page(20, "tok-1", "a"), page(20, undefined, "a")]);

    const result = await paginateTile(PAGINATE_ARGS, { db, fetchImpl: impl, sleep: noSleep });

    expect(result.pagesFetched).toBe(2);
    expect(result.resultsCount).toBe(20);
  });
});
