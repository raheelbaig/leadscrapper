import { describe, expect, it, vi } from "vitest";

import { PAGE_SIZE, PLACES_FIELD_MASK, PLACES_TEXT_SEARCH_URL } from "@/lib/constants";
import type { BoundingBox } from "@/lib/geo/bbox";

import {
  buildTextSearchRequest,
  executeTextSearch,
  redactHeaders,
  toRectangle,
  type BuiltRequest,
} from "./client";
import { PlacesApiError, isRetryableStatus } from "./errors";

const TEST_BBOX: BoundingBox = {
  minLat: 29.74,
  minLng: -95.38,
  maxLat: 29.77,
  maxLng: -95.35,
};

/** A stub `fetch` that answers with a canned status and body. */
function stubFetch(status: number, body: unknown, options: { raw?: string } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(options.raw ?? JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const OK_RESPONSE = {
  places: [
    {
      id: "ChIJtest1",
      displayName: { text: "Bayou City Embroidery", languageCode: "en" },
      formattedAddress: "1200 Main St, Houston, TX 77002, USA",
      nationalPhoneNumber: "(713) 555-0142",
      internationalPhoneNumber: "+1 713-555-0142",
      websiteUri: "https://bayoucityembroidery.example",
      location: { latitude: 29.7551, longitude: -95.3662 },
      googleMapsUri: "https://maps.google.com/?cid=1",
    },
  ],
};

describe("request construction", () => {
  const built = buildTextSearchRequest({ textQuery: "Embroidery Shops", bbox: TEST_BBOX });

  it("targets the Places API (New) Text Search endpoint", () => {
    expect(built.url).toBe(PLACES_TEXT_SEARCH_URL);
    expect(built.url).toBe("https://places.googleapis.com/v1/places:searchText");
  });

  it("sends the API key in the X-Goog-Api-Key header", () => {
    expect(built.headers["X-Goog-Api-Key"]).toBe(process.env.GOOGLE_MAPS_API_KEY);
    expect(built.headers["X-Goog-Api-Key"]).toBeTruthy();
    // Never as a query parameter, where it would land in server access logs.
    expect(built.url).not.toContain("key=");
  });

  it("sends exactly the approved field mask, plus the pagination envelope", () => {
    const mask = built.headers["X-Goog-FieldMask"].split(",");

    expect(mask).toEqual([...PLACES_FIELD_MASK, "nextPageToken"]);
    // The Enterprise fields the product requires...
    expect(mask).toContain("places.nationalPhoneNumber");
    expect(mask).toContain("places.internationalPhoneNumber");
    expect(mask).toContain("places.websiteUri");
    // ...and nothing beyond the approved list, because the mask decides the SKU.
    expect(mask).not.toContain("places.reviews");
    expect(mask).not.toContain("places.addressComponents");
    expect(mask).not.toContain("*");
  });

  it("queries the niche ALONE, never the niche plus a city", () => {
    // Naming the city pulls Google's ranking back to the centroid and makes
    // every tile return the same downtown businesses.
    expect(built.body.textQuery).toBe("Embroidery Shops");
    expect(built.body.textQuery).not.toMatch(/\bin\s/i);
  });

  it("restricts by rectangle, which is the only shape Text Search accepts", () => {
    expect(built.body.locationRestriction).toEqual({
      rectangle: {
        low: { latitude: 29.74, longitude: -95.38 },
        high: { latitude: 29.77, longitude: -95.35 },
      },
    });
  });

  it("maps low/high to the south-west and north-east corners", () => {
    const rect = toRectangle(TEST_BBOX);
    expect(rect.low.latitude).toBeLessThan(rect.high.latitude);
    expect(rect.low.longitude).toBeLessThan(rect.high.longitude);
  });

  it("asks for a full page of 20, the documented maximum", () => {
    expect(built.body.pageSize).toBe(PAGE_SIZE);
    expect(built.body.pageSize).toBe(20);
  });

  it("omits pageToken on the first page and includes it on later ones", () => {
    expect(built.body.pageToken).toBeUndefined();

    const paged = buildTextSearchRequest({
      textQuery: "Embroidery Shops",
      bbox: TEST_BBOX,
      pageToken: "token-abc",
    });
    expect(paged.body.pageToken).toBe("token-abc");
    // Google requires every OTHER parameter to be identical alongside a token.
    expect(paged.body.textQuery).toBe(built.body.textQuery);
    expect(paged.body.locationRestriction).toEqual(built.body.locationRestriction);
    expect(paged.body.pageSize).toBe(built.body.pageSize);
  });

  it("refuses an empty query rather than asking Google for everything", () => {
    expect(() => buildTextSearchRequest({ textQuery: "   ", bbox: TEST_BBOX })).toThrow(
      PlacesApiError,
    );
  });

  it("redacts the key for logging", () => {
    const safe = redactHeaders(built.headers);
    expect(safe["X-Goog-Api-Key"]).toBe("[redacted]");
    expect(JSON.stringify(safe)).not.toContain(process.env.GOOGLE_MAPS_API_KEY!);
    // The mask is not a secret and stays legible in the log.
    expect(safe["X-Goog-FieldMask"]).toBe(built.headers["X-Goog-FieldMask"]);
  });
});

describe("sending", () => {
  const request: BuiltRequest = buildTextSearchRequest({
    textQuery: "Embroidery Shops",
    bbox: TEST_BBOX,
  });

  it("POSTs JSON to the endpoint with the built headers", async () => {
    const { impl, calls } = stubFetch(200, OK_RESPONSE);
    await executeTextSearch(request, { fetchImpl: impl });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(PLACES_TEXT_SEARCH_URL);
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual(request.body);

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["X-Goog-Api-Key"]).toBe(process.env.GOOGLE_MAPS_API_KEY);
    expect(headers["X-Goog-FieldMask"]).toBe(request.headers["X-Goog-FieldMask"]);
  });

  it("makes exactly ONE request per call", async () => {
    // Retry lives in the caller that holds the budget reservation, because
    // every attempt is a separate billable request.
    const { impl } = stubFetch(200, OK_RESPONSE);
    await executeTextSearch(request, { fetchImpl: impl });
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it("parses a complete result", async () => {
    const { impl } = stubFetch(200, OK_RESPONSE);
    const result = await executeTextSearch(request, { fetchImpl: impl });

    expect(result.httpStatus).toBe(200);
    expect(result.response.places).toHaveLength(1);
    expect(result.response.places[0].id).toBe("ChIJtest1");
    expect(result.response.nextPageToken).toBeUndefined();
  });

  it("treats an absent places key as zero results, not as a failure", async () => {
    // Google returns `{}` for an empty area, never `{"places": []}`. Reading
    // that as an error would turn verified-empty coverage into a failed tile.
    const { impl } = stubFetch(200, {});
    const result = await executeTextSearch(request, { fetchImpl: impl });
    expect(result.response.places).toEqual([]);
  });

  it("treats an empty body as zero results", async () => {
    const { impl } = stubFetch(200, null, { raw: "" });
    const result = await executeTextSearch(request, { fetchImpl: impl });
    expect(result.response.places).toEqual([]);
  });

  it("surfaces a page token when Google offers one", async () => {
    const { impl } = stubFetch(200, { ...OK_RESPONSE, nextPageToken: "tok-2" });
    const result = await executeTextSearch(request, { fetchImpl: impl });
    expect(result.response.nextPageToken).toBe("tok-2");
  });

  it("keeps places whose optional fields are missing", async () => {
    const { impl } = stubFetch(200, {
      places: [{ id: "ChIJbare", displayName: { text: "No Frills Stitching" } }],
    });
    const result = await executeTextSearch(request, { fetchImpl: impl });

    const place = result.response.places[0];
    expect(place.id).toBe("ChIJbare");
    expect(place.nationalPhoneNumber).toBeUndefined();
    expect(place.websiteUri).toBeUndefined();
    expect(place.location).toBeUndefined();
    expect(place.googleMapsUri).toBeUndefined();
  });
});

describe("errors", () => {
  const request = buildTextSearchRequest({ textQuery: "Embroidery Shops", bbox: TEST_BBOX });

  const cases: Array<{ status: number; retryable: boolean; matches: RegExp }> = [
    { status: 400, retryable: false, matches: /bug in the request body or field mask/i },
    { status: 401, retryable: false, matches: /rejected the API key/i },
    { status: 403, retryable: false, matches: /refused the request/i },
    { status: 404, retryable: false, matches: /404/ },
    { status: 429, retryable: true, matches: /rate-limited/i },
    { status: 500, retryable: true, matches: /server error/i },
    { status: 503, retryable: true, matches: /server error/i },
  ];

  for (const testCase of cases) {
    it(`classifies HTTP ${testCase.status} as ${testCase.retryable ? "retryable" : "permanent"}`, async () => {
      const { impl } = stubFetch(testCase.status, {
        error: { code: testCase.status, message: "upstream said so", status: "SOME_STATUS" },
      });

      await expect(executeTextSearch(request, { fetchImpl: impl })).rejects.toMatchObject({
        name: "PlacesApiError",
        kind: "http",
        status: testCase.status,
        retryable: testCase.retryable,
        // Any HTTP status means Google saw the request and may have metered it.
        reachedGoogle: true,
      });

      await expect(executeTextSearch(request, { fetchImpl: impl })).rejects.toThrow(
        testCase.matches,
      );
    });
  }

  it("agrees with the shared status classifier", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(403)).toBe(false);
  });

  it("keeps Google's own status code for the activity log", async () => {
    const { impl } = stubFetch(400, {
      error: { code: 400, message: "Invalid field mask", status: "INVALID_ARGUMENT" },
    });

    try {
      await executeTextSearch(request, { fetchImpl: impl });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PlacesApiError);
      expect((error as PlacesApiError).googleStatus).toBe("INVALID_ARGUMENT");
      expect((error as PlacesApiError).logMessage).toContain("INVALID_ARGUMENT");
    }
  });

  it("handles a non-JSON error body", async () => {
    const { impl } = stubFetch(502, null, { raw: "<html>Bad Gateway</html>" });
    await expect(executeTextSearch(request, { fetchImpl: impl })).rejects.toMatchObject({
      kind: "http",
      status: 502,
      retryable: true,
    });
  });

  it("rejects a 200 whose body is not JSON", async () => {
    const { impl } = stubFetch(200, null, { raw: "not json at all" });
    await expect(executeTextSearch(request, { fetchImpl: impl })).rejects.toMatchObject({
      kind: "malformed",
      // Retrying a malformed 200 costs another call and returns the same thing.
      retryable: false,
    });
  });

  it("rejects a 200 whose shape is wrong", async () => {
    // A place with no id cannot be deduplicated, counted, or stored.
    const { impl } = stubFetch(200, { places: [{ displayName: { text: "Nameless" } }] });
    await expect(executeTextSearch(request, { fetchImpl: impl })).rejects.toMatchObject({
      kind: "malformed",
      retryable: false,
    });
  });

  it("marks a network failure as refundable and retryable", async () => {
    const impl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    try {
      await executeTextSearch(request, { fetchImpl: impl });
      expect.unreachable("should have thrown");
    } catch (error) {
      const placesError = error as PlacesApiError;
      expect(placesError.kind).toBe("network");
      expect(placesError.retryable).toBe(true);
      // No HTTP status ever arrived, so Google demonstrably did not meter it
      // and the caller must refund its reservation.
      expect(placesError.reachedGoogle).toBe(false);
    }
  });

  it("aborts rather than hanging when Google does not answer", async () => {
    const impl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "TimeoutError")),
        );
      });
    }) as unknown as typeof fetch;

    await expect(
      executeTextSearch(request, { fetchImpl: impl, timeoutMs: 20 }),
    ).rejects.toMatchObject({ kind: "network", reachedGoogle: false });
  });
});
