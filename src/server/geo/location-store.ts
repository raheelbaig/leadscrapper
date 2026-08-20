import "server-only";

import { getSupabaseAdminClient } from "@/server/db/admin";

import { resolvedLocationFromRow, type GeoDb, type LocationRow } from "./resolved-location";
import type { ResolvedLocation } from "./types";

/**
 * Writes to the `locations` cache.
 *
 * `locations` has no authenticated INSERT policy -- deliberately. A bounding box
 * is the input to every cost estimate in the application, so it may only ever be
 * written by the server, from a verified provider response. That means the
 * service-role client, which bypasses RLS, and it means this is the only module
 * that writes the table.
 *
 * A cached row is trusted forever, so nothing approximate may be stored here.
 */
export async function persistResolvedLocation(
  resolved: ResolvedLocation,
  db: GeoDb = getSupabaseAdminClient(),
): Promise<ResolvedLocation> {
  // Re-check rather than upsert: the row may have been written by a concurrent
  // resolution, and the existing row is just as valid as the one in hand.
  const existing = await db
    .from("locations")
    .select("*")
    .eq("normalized_key", resolved.normalizedKey)
    .maybeSingle();

  if (existing.error) {
    throw new Error(`Location cache read failed: ${existing.error.message}`);
  }
  if (existing.data) {
    return resolvedLocationFromRow(existing.data as LocationRow, "cache");
  }

  const { data, error } = await db
    .from("locations")
    .insert({
      country: resolved.country,
      state: resolved.state,
      city: resolved.city,
      label: resolved.label,
      min_lat: resolved.bbox.minLat,
      min_lng: resolved.bbox.minLng,
      max_lat: resolved.bbox.maxLat,
      max_lng: resolved.bbox.maxLng,
      source: resolved.source,
      google_place_id: resolved.googlePlaceId,
      formatted_address: resolved.canonicalAddress,
      address_components: resolved.addressComponents,
      resolved_at: resolved.resolvedAt,
    })
    .select("*")
    .single();

  if (error) {
    throw new Error(`Location cache write failed: ${error.message}`);
  }

  // Keep the ORIGINAL source on the returned value: this resolution really did
  // come from Geocoding, and only the next lookup is a cache hit.
  return {
    ...resolvedLocationFromRow(data as LocationRow, "cache"),
    source: resolved.source,
    providerName: resolved.providerName,
    fromCache: false,
  };
}
