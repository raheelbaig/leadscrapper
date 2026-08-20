import { describe, expect, it, vi } from "vitest";

import { bboxAreaKm2, normalizedLocationKey } from "@/lib/geo/bbox";

import { BboxResolutionError, defaultProviders, resolveBbox } from "./bbox-resolver";
import { CITY_FIXTURES, GREATER_HOUSTON_FIXTURE, findCityFixture } from "./fixtures/cities";
import { FixtureBboxProvider } from "./providers/fixture-provider";
import { GeocodingBboxProvider } from "./providers/geocoding-provider";
import { ManualBboxProvider } from "./providers/manual-provider";
import { PlacesViewportBboxProvider } from "./providers/places-viewport-provider";
import { buildResolvedLocation } from "./resolved-location";
import { ProviderNotEnabledError, type BboxProvider, type LocationQuery } from "./types";

const HOUSTON_QUERY: LocationQuery = {
  country: "United States",
  state: "Texas",
  city: "Houston",
};

/** A provider whose behaviour and invocation count the test controls. */
function stubProvider(
  name: string,
  behaviour: "hit" | "miss" | "throw",
  options: { requiresExternalCall?: boolean; bbox?: LocationQuery["manualBbox"] } = {},
): BboxProvider & { calls: number } {
  return {
    name,
    source: "manual",
    requiresExternalCall: options.requiresExternalCall ?? false,
    calls: 0,
    async resolve(query: LocationQuery) {
      this.calls += 1;
      if (behaviour === "throw") throw new Error(`${name} exploded`);
      if (behaviour === "miss") return null;
      return buildResolvedLocation({
        country: query.country,
        state: query.state,
        city: query.city,
        bbox: options.bbox ?? { minLat: 29, minLng: -96, maxLat: 30, maxLng: -95 },
        source: "manual",
        providerName: name,
      });
    },
  };
}

describe("resolver chain order", () => {
  it("stops at the first provider that answers", async () => {
    const first = stubProvider("first", "hit");
    const second = stubProvider("second", "hit");

    const result = await resolveBbox(HOUSTON_QUERY, { providers: [first, second] });

    expect(result.location.providerName).toBe("first");
    expect(second.calls).toBe(0);
  });

  it("falls through a miss to the next provider", async () => {
    const cache = stubProvider("cache", "miss");
    const fallback = stubProvider("fallback", "hit");

    const result = await resolveBbox(HOUSTON_QUERY, { providers: [cache, fallback] });

    expect(cache.calls).toBe(1);
    expect(result.location.providerName).toBe("fallback");
    expect(result.attempts.map((a) => a.outcome)).toEqual(["miss", "hit"]);
  });

  it("survives a provider that throws", async () => {
    // One broken step must not abandon the chain -- that is what the chain is
    // for -- but the failure has to stay visible.
    const broken = stubProvider("broken", "throw");
    const fallback = stubProvider("fallback", "hit");

    const result = await resolveBbox(HOUSTON_QUERY, { providers: [broken, fallback] });

    expect(result.location.providerName).toBe("fallback");
    expect(result.attempts[0]).toMatchObject({ provider: "broken", outcome: "error" });
    expect(result.attempts[0].reason).toContain("exploded");
  });

  it("reports every attempt when nothing resolves", async () => {
    const providers = [stubProvider("a", "miss"), stubProvider("b", "throw")];

    await expect(resolveBbox(HOUSTON_QUERY, { providers })).rejects.toThrow(BboxResolutionError);

    try {
      await resolveBbox(HOUSTON_QUERY, { providers });
    } catch (error) {
      expect(error).toBeInstanceOf(BboxResolutionError);
      const attempts = (error as BboxResolutionError).attempts;
      expect(attempts.map((a) => a.provider)).toEqual(["a", "b"]);
      expect((error as Error).message).toContain("Houston");
    }
  });
});

describe("external providers", () => {
  it("skips them without invoking them while external calls are disabled", async () => {
    const external = stubProvider("geocoding", "hit", { requiresExternalCall: true });
    const fixture = stubProvider("fixture", "hit");

    const result = await resolveBbox(HOUSTON_QUERY, {
      providers: [external, fixture],
      allowExternal: false,
    });

    // Not merely prevented from succeeding -- never called at all. No URL is
    // built, no key is read, no quota is reserved.
    expect(external.calls).toBe(0);
    expect(result.externalCallsMade).toBe(0);
    expect(result.attempts[0]).toMatchObject({ provider: "geocoding", outcome: "skipped" });
    expect(result.location.providerName).toBe("fixture");
  });

  it("uses them once Phase 3 enables them", async () => {
    const external = stubProvider("geocoding", "hit", { requiresExternalCall: true });

    const result = await resolveBbox(HOUSTON_QUERY, {
      providers: [external],
      allowExternal: true,
    });

    expect(external.calls).toBe(1);
    expect(result.externalCallsMade).toBe(1);
  });

  it("keeps the Phase 3 providers unimplemented rather than half-implemented", async () => {
    // A direct caller that bypassed the resolver must still be stopped.
    await expect(new GeocodingBboxProvider().resolve(HOUSTON_QUERY)).rejects.toThrow(
      ProviderNotEnabledError,
    );
    await expect(new PlacesViewportBboxProvider().resolve(HOUSTON_QUERY)).rejects.toThrow(
      ProviderNotEnabledError,
    );
  });
});

describe("the default chain", () => {
  it("resolves a known city from fixtures without any database or network", async () => {
    const result = await resolveBbox(HOUSTON_QUERY);

    expect(result.externalCallsMade).toBe(0);
    expect(result.persisted).toBe(false);
    expect(result.location.city).toBe("Houston");
    expect(result.location.providerName).toBe("fixture");
    expect(result.location.areaKm2).toBeGreaterThan(0);
  });

  it("skips both Google steps and records why", async () => {
    const result = await resolveBbox(HOUSTON_QUERY);
    const skipped = result.attempts.filter((a) => a.outcome === "skipped");

    expect(skipped.map((a) => a.provider)).toEqual(["geocoding", "places-viewport"]);
    for (const attempt of skipped) {
      expect(attempt.reason).toMatch(/no Google request was made/i);
    }
  });

  it("omits the cache and custom-area steps when no database client is supplied", () => {
    const chain = defaultProviders(undefined, false).map((p) => p.name);
    expect(chain).toEqual(["geocoding", "places-viewport", "fixture", "manual-entry"]);
  });

  it("drops the fixture stand-in once external providers are enabled", () => {
    const chain = defaultProviders(undefined, true).map((p) => p.name);
    expect(chain).toEqual(["geocoding", "places-viewport", "manual-entry"]);
  });

  it("falls back to a user-drawn rectangle for a city it does not know", async () => {
    const result = await resolveBbox({
      country: "United States",
      state: "Texas",
      city: "Nowheresville",
      manualBbox: { minLat: 31, minLng: -97, maxLat: 31.2, maxLng: -96.8 },
    });

    expect(result.location.source).toBe("user_entered");
    expect(result.location.providerName).toBe("manual-entry");
  });

  it("gives up with the full trail when even manual entry has nothing", async () => {
    await expect(
      resolveBbox({ country: "United States", state: "Texas", city: "Nowheresville" }),
    ).rejects.toThrow(BboxResolutionError);
  });

  it("ignores an invalid manual rectangle rather than storing it", async () => {
    await expect(
      resolveBbox({
        country: "United States",
        state: "Texas",
        city: "Nowheresville",
        // Inverted: maxLat below minLat.
        manualBbox: { minLat: 31.2, minLng: -97, maxLat: 31, maxLng: -96.8 },
      }),
    ).rejects.toThrow(BboxResolutionError);
  });
});

describe("cache persistence", () => {
  it("writes a fresh resolution to the cache when persistence is on", async () => {
    const persistFn = vi.fn(async (location) => location);
    const result = await resolveBbox(HOUSTON_QUERY, {
      providers: [new FixtureBboxProvider()],
      persist: true,
      persistFn,
    });

    expect(persistFn).toHaveBeenCalledTimes(1);
    expect(result.persisted).toBe(true);
  });

  it("never re-writes a cache hit", async () => {
    const persistFn = vi.fn(async (location) => location);
    const cached = stubProvider("cache", "hit");
    const cachedProvider: BboxProvider = {
      ...cached,
      source: "cache",
      async resolve(query) {
        const location = await cached.resolve(query);
        return location ? { ...location, fromCache: true, source: "cache" } : null;
      },
    };

    await resolveBbox(HOUSTON_QUERY, {
      providers: [cachedProvider],
      persist: true,
      persistFn,
    });

    expect(persistFn).not.toHaveBeenCalled();
  });

  it("never enshrines a hand-drawn rectangle as a city boundary", async () => {
    // A rectangle the user typed is theirs to keep as a custom area; caching it
    // under the city's key would mis-plan every future search of that city.
    const persistFn = vi.fn(async (location) => location);

    const result = await resolveBbox(
      { ...HOUSTON_QUERY, manualBbox: { minLat: 29, minLng: -96, maxLat: 30, maxLng: -95 } },
      { providers: [new ManualBboxProvider()], persist: true, persistFn },
    );

    expect(result.location.source).toBe("user_entered");
    expect(persistFn).not.toHaveBeenCalled();
    expect(result.persisted).toBe(false);
  });

  it("is off by default in Phase 2, so fixtures never poison the cache", async () => {
    const result = await resolveBbox(HOUSTON_QUERY);
    expect(result.persisted).toBe(false);
  });
});

describe("resolved location shape", () => {
  it("carries everything the grid planner and the cache key need", async () => {
    const { location } = await resolveBbox(HOUSTON_QUERY);

    expect(location.normalizedKey).toBe(normalizedLocationKey("United States", "Texas", "Houston"));
    expect(location.label).toMatch(/Houston/);
    expect(location.country).toBe("United States");
    expect(location.state).toBe("Texas");
    expect(location.canonicalAddress).toMatch(/TX/);
    expect(location.widthKm).toBeGreaterThan(0);
    expect(location.heightKm).toBeGreaterThan(0);
    expect(location.areaKm2).toBeCloseTo(bboxAreaKm2(location.bbox), 9);
    expect(location.resolvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("normalises a blank state to null", async () => {
    const location = await new ManualBboxProvider().resolve({
      country: "Singapore",
      state: "   ",
      city: "Singapore",
      manualBbox: { minLat: 1.2, minLng: 103.6, maxLat: 1.48, maxLng: 104.1 },
    });

    expect(location?.state).toBeNull();
    expect(location?.normalizedKey).toBe("singapore||singapore");
  });
});

describe("fixtures", () => {
  it("are all valid rectangles", () => {
    for (const fixture of [...CITY_FIXTURES, GREATER_HOUSTON_FIXTURE]) {
      expect(fixture.bbox.minLat).toBeLessThan(fixture.bbox.maxLat);
      expect(fixture.bbox.minLng).toBeLessThan(fixture.bbox.maxLng);
      expect(bboxAreaKm2(fixture.bbox)).toBeGreaterThan(0);
    }
  });

  it("show why a custom area exists", () => {
    // "Greater Houston" is several times the municipality, which is the whole
    // reason a lead search wants a custom area rather than the city proper.
    const houston = findCityFixture("United States", "Texas", "Houston");
    expect(houston).not.toBeNull();
    expect(bboxAreaKm2(GREATER_HOUSTON_FIXTURE.bbox)).toBeGreaterThan(
      bboxAreaKm2(houston!.bbox) * 3,
    );
  });

  it("match on city and country when the state is omitted", () => {
    expect(findCityFixture("United States", null, "Chicago")?.state).toBe("Illinois");
  });

  it("refuse to guess when the city name is ambiguous", () => {
    // A state that does not match still resolves when the city+country pair is
    // unique, but a country with no such city must return null rather than
    // guessing -- a wrong guess would search an entirely different metro.
    expect(findCityFixture("United States", "Wrong State", "Houston")?.city).toBe("Houston");
    expect(findCityFixture("Canada", null, "Houston")).toBeNull();
  });
});
