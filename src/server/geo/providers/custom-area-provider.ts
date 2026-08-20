import "server-only";

import { buildResolvedLocation, type GeoDb } from "../resolved-location";
import type { BboxProvider, LocationQuery, ResolvedLocation } from "../types";

/**
 * Step 2 of the chain: a user-defined rectangle beats the official city
 * boundary.
 *
 * "Houston" as a municipality excludes most of the metro area a lead search
 * actually wants, so an area like "Greater Houston" is drawn once by hand and
 * reused. A custom area is free -- it never costs a Geocoding call.
 *
 * `custom_areas` is owned by the signed-in account and protected by RLS, so
 * this provider must run under the request client, not the service-role one.
 */
export class CustomAreaBboxProvider implements BboxProvider {
  readonly name = "custom-area";
  readonly source = "manual" as const;
  readonly requiresExternalCall = false;

  constructor(private readonly db: GeoDb) {}

  async resolve(query: LocationQuery): Promise<ResolvedLocation | null> {
    if (!query.customAreaId) return null;

    const { data, error } = await this.db
      .from("custom_areas")
      .select("*")
      .eq("id", query.customAreaId)
      .maybeSingle();

    if (error) {
      throw new Error(`Custom area lookup failed for "${query.customAreaId}": ${error.message}`);
    }
    if (!data) return null;

    return buildResolvedLocation({
      country: data.country,
      state: data.state ?? query.state ?? null,
      // A custom area may cover several municipalities and have no city of its
      // own; fall back to the requested city so the cache key stays meaningful.
      city: data.city ?? query.city,
      label: data.name,
      bbox: {
        minLat: data.min_lat,
        minLng: data.min_lng,
        maxLat: data.max_lat,
        maxLng: data.max_lng,
      },
      source: this.source,
      providerName: this.name,
      locationId: data.base_location_id,
    });
  }
}
