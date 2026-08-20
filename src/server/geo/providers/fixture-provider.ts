import "server-only";

import { findCityFixture, type CityFixture } from "../fixtures/cities";
import { buildResolvedLocation } from "../resolved-location";
import type { BboxProvider, LocationQuery, ResolvedLocation } from "../types";

/**
 * A stand-in for the Google providers while external calls are switched off.
 *
 * It occupies the same position in the chain that Geocoding will, so the
 * resolver, the API route and the tests all exercise the real control flow --
 * only the source of the rectangle is different. Phase 3 drops the real
 * provider into the same slot without changing anything around it.
 *
 * `requiresExternalCall` is false, which is the whole point: it can never spend
 * anything.
 */
export class FixtureBboxProvider implements BboxProvider {
  readonly name = "fixture";
  readonly source = "manual" as const;
  readonly requiresExternalCall = false;

  constructor(private readonly fixtures?: readonly CityFixture[]) {}

  async resolve(query: LocationQuery): Promise<ResolvedLocation | null> {
    const fixture = this.fixtures
      ? (this.fixtures.find(
          (f) =>
            f.city.trim().toLowerCase() === query.city.trim().toLowerCase() &&
            f.country.trim().toLowerCase() === query.country.trim().toLowerCase(),
        ) ?? null)
      : findCityFixture(query.country, query.state, query.city);

    if (!fixture) return null;

    return buildResolvedLocation({
      country: fixture.country,
      state: fixture.state,
      city: fixture.city,
      label: fixture.label,
      bbox: fixture.bbox,
      source: this.source,
      providerName: this.name,
      canonicalAddress: fixture.canonicalAddress,
    });
  }
}
