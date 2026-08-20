import "server-only";

import { normalizedLocationKey } from "@/lib/geo/bbox";

import { resolvedLocationFromRow, type GeoDb, type LocationRow } from "../resolved-location";
import type { BboxProvider, LocationQuery, ResolvedLocation } from "../types";

/**
 * Step 1 of the chain: a city already resolved once is never resolved again.
 *
 * `locations` is keyed by the generated `normalized_key` column, and the key
 * built here uses the identical formula. A mismatch would not raise an error --
 * it would simply miss, and every search would pay for a fresh Geocoding call
 * forever. That is why the formula lives in one tested function.
 *
 * Reads only. Writing the cache is the resolver's job, through the service-role
 * client, because `locations` deliberately has no authenticated INSERT policy.
 */
export class CacheBboxProvider implements BboxProvider {
  readonly name = "cache";
  readonly source = "cache" as const;
  readonly requiresExternalCall = false;

  constructor(private readonly db: GeoDb) {}

  async resolve(query: LocationQuery): Promise<ResolvedLocation | null> {
    const key = normalizedLocationKey(query.country, query.state, query.city);

    const { data, error } = await this.db
      .from("locations")
      .select("*")
      .eq("normalized_key", key)
      .maybeSingle();

    if (error) {
      throw new Error(`Location cache lookup failed for "${key}": ${error.message}`);
    }
    if (!data) return null;

    return resolvedLocationFromRow(data as LocationRow, this.name);
  }
}
