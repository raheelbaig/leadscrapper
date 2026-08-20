import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import {
  assertValidBbox,
  bboxMetrics,
  normalizedLocationKey,
  type BoundingBox,
} from "@/lib/geo/bbox";
import { locationLabel } from "@/lib/format";

import type { BboxSource, ResolvedLocation } from "./types";

/** Any Supabase client -- the RLS-bound request client or the service-role one. */
export type GeoDb = SupabaseClient<Database>;

export type LocationRow = Database["public"]["Tables"]["locations"]["Row"];

/**
 * Assembles a `ResolvedLocation` from a rectangle.
 *
 * Width, height and area are computed with the same formulas as the generated
 * columns on `public.locations`, so a value read from the cache and a value
 * computed here are the same number rather than two nearly-equal ones.
 */
export function buildResolvedLocation(args: {
  country: string;
  state?: string | null;
  city: string;
  label?: string | null;
  bbox: BoundingBox;
  source: BboxSource;
  providerName: string;
  canonicalAddress?: string | null;
  googlePlaceId?: string | null;
  addressComponents?: Record<string, string>;
  locationId?: string | null;
  fromCache?: boolean;
  resolvedAt?: string;
}): ResolvedLocation {
  assertValidBbox(args.bbox);

  const state = args.state?.trim() ? args.state.trim() : null;
  const metrics = bboxMetrics(args.bbox);

  return {
    normalizedKey: normalizedLocationKey(args.country, state, args.city),
    label: args.label?.trim() || locationLabel(args.city, state, args.country),
    country: args.country.trim(),
    state,
    city: args.city.trim(),
    canonicalAddress: args.canonicalAddress ?? null,
    googlePlaceId: args.googlePlaceId ?? null,
    addressComponents: args.addressComponents ?? {},
    bbox: args.bbox,
    widthKm: metrics.widthKm,
    heightKm: metrics.heightKm,
    areaKm2: metrics.areaKm2,
    source: args.source,
    providerName: args.providerName,
    resolvedAt: args.resolvedAt ?? new Date().toISOString(),
    fromCache: args.fromCache ?? false,
    locationId: args.locationId ?? null,
  };
}

/** Turns a cached `locations` row back into a `ResolvedLocation`. */
export function resolvedLocationFromRow(row: LocationRow, providerName: string): ResolvedLocation {
  return buildResolvedLocation({
    country: row.country,
    state: row.state,
    city: row.city,
    label: row.label,
    bbox: {
      minLat: row.min_lat,
      minLng: row.min_lng,
      maxLat: row.max_lat,
      maxLng: row.max_lng,
    },
    // A cache hit is recorded as `cache` no matter how the row was originally
    // obtained; `locations.source` still remembers the original provenance.
    source: "cache",
    providerName,
    canonicalAddress: row.formatted_address,
    googlePlaceId: row.google_place_id,
    addressComponents: (row.address_components ?? {}) as Record<string, string>,
    locationId: row.id,
    fromCache: true,
    resolvedAt: row.resolved_at,
  });
}
