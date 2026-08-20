import type { BoundingBox } from "@/lib/geo/bbox";

/**
 * Fixture rectangles for development and tests.
 *
 * APPROXIMATE, and deliberately so. They exist to exercise the resolver chain
 * and the geometry math without spending a Geocoding call, and to give the
 * `/api/locations/resolve` route something real-shaped to return while external
 * providers are switched off.
 *
 * They are NOT authoritative and are never written to the `locations` cache: a
 * cached row is treated as correct forever, so seeding the cache with an
 * approximation would silently mis-plan every future search of that city. Phase
 * 3 resolves the real boundaries through Geocoding.
 *
 * Not marked `server-only` -- it holds nothing secret, and tests import it
 * directly.
 */

export type CityFixture = {
  country: string;
  state: string | null;
  city: string;
  label: string;
  bbox: BoundingBox;
  canonicalAddress: string;
};

export const CITY_FIXTURES: readonly CityFixture[] = [
  {
    country: "United States",
    state: "Texas",
    city: "Houston",
    label: "Houston, Texas, United States",
    bbox: { minLat: 29.523, minLng: -95.789, maxLat: 30.11, maxLng: -95.014 },
    canonicalAddress: "Houston, TX, USA",
  },
  {
    country: "United States",
    state: "Texas",
    city: "Dallas",
    label: "Dallas, Texas, United States",
    bbox: { minLat: 32.617, minLng: -96.999, maxLat: 33.017, maxLng: -96.555 },
    canonicalAddress: "Dallas, TX, USA",
  },
  {
    country: "United States",
    state: "California",
    city: "Los Angeles",
    label: "Los Angeles, California, United States",
    bbox: { minLat: 33.703, minLng: -118.668, maxLat: 34.337, maxLng: -118.155 },
    canonicalAddress: "Los Angeles, CA, USA",
  },
  {
    country: "United States",
    state: "New York",
    city: "New York",
    label: "New York, New York, United States",
    bbox: { minLat: 40.496, minLng: -74.256, maxLat: 40.916, maxLng: -73.7 },
    canonicalAddress: "New York, NY, USA",
  },
  {
    country: "United States",
    state: "Illinois",
    city: "Chicago",
    label: "Chicago, Illinois, United States",
    bbox: { minLat: 41.644, minLng: -87.94, maxLat: 42.023, maxLng: -87.524 },
    canonicalAddress: "Chicago, IL, USA",
  },
  {
    country: "United States",
    state: "Arizona",
    city: "Phoenix",
    label: "Phoenix, Arizona, United States",
    bbox: { minLat: 33.29, minLng: -112.324, maxLat: 33.92, maxLng: -111.926 },
    canonicalAddress: "Phoenix, AZ, USA",
  },
  {
    country: "United States",
    state: "Alaska",
    city: "Anchorage",
    // Far enough north that the cos(latitude) width correction is impossible to
    // overlook: the same degree span is roughly half as wide as in Houston.
    label: "Anchorage, Alaska, United States",
    bbox: { minLat: 61.05, minLng: -150.05, maxLat: 61.35, maxLng: -149.55 },
    canonicalAddress: "Anchorage, AK, USA",
  },
  {
    country: "United Kingdom",
    state: "England",
    city: "London",
    // Straddles the prime meridian, so a sign error in the width calculation
    // shows up here rather than in production.
    label: "London, England, United Kingdom",
    bbox: { minLat: 51.286, minLng: -0.51, maxLat: 51.692, maxLng: 0.334 },
    canonicalAddress: "London, UK",
  },
] as const;

/**
 * An example of the case custom areas exist for: the City of Houston proper
 * excludes most of the metro a lead search actually wants.
 */
export const GREATER_HOUSTON_FIXTURE: CityFixture = {
  country: "United States",
  state: "Texas",
  city: "Houston",
  label: "Greater Houston",
  bbox: { minLat: 29.2, minLng: -96.1, maxLat: 30.4, maxLng: -94.7 },
  canonicalAddress: "Greater Houston, TX, USA",
};

function key(country: string, state: string | null | undefined, city: string): string {
  return [country, state ?? "", city].map((part) => part.trim().toLowerCase()).join("|");
}

const BY_KEY = new Map(CITY_FIXTURES.map((f) => [key(f.country, f.state, f.city), f]));

/** Exact match on country/state/city. */
export function findCityFixture(
  country: string,
  state: string | null | undefined,
  city: string,
): CityFixture | null {
  const exact = BY_KEY.get(key(country, state, city));
  if (exact) return exact;

  // State is optional in the search form, so fall back to a city+country match
  // when exactly one candidate exists. Two candidates means the state is not
  // optional after all, and guessing would silently search the wrong metro.
  const candidates = CITY_FIXTURES.filter(
    (f) =>
      f.city.trim().toLowerCase() === city.trim().toLowerCase() &&
      f.country.trim().toLowerCase() === country.trim().toLowerCase(),
  );

  return candidates.length === 1 ? candidates[0] : null;
}
