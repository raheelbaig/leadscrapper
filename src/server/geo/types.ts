import "server-only";

import type { BoundingBox } from "@/lib/geo/bbox";

/**
 * The bounding-box resolver contract.
 *
 * A city's rectangle is resolved ONCE and cached forever, because the whole
 * grid is planned from it and planning must be free. Resolution costs at most a
 * single Geocoding call per city in its entire lifetime, and that call is billed
 * against the Geocoding SKU -- it must never touch the Enterprise search
 * allowance the leads themselves depend on.
 *
 * `locationRestriction` on Text Search accepts a RECTANGLE only. That
 * restriction is not an inconvenience; it is what makes coverage accounting
 * meaningful, because a rectangle can be subdivided into four rectangles whose
 * union is exactly the parent.
 */

/** Mirrors the `public.bbox_source` enum. */
export type BboxSource = "cache" | "manual" | "geocoding" | "places" | "user_entered";

export type LocationQuery = {
  country: string;
  state?: string | null;
  city: string;
  /** Prefer a user-defined area, e.g. "Greater Houston", over the city proper. */
  customAreaId?: string | null;
  /** A rectangle typed in by the user. The last resort in the chain. */
  manualBbox?: BoundingBox | null;
  /** Scopes custom-area lookups. Single-user app, but never assumed. */
  userId?: string | null;
};

export type ResolvedLocation = {
  /** Matches the `locations.normalized_key` generated column exactly. */
  normalizedKey: string;
  label: string;
  country: string;
  state: string | null;
  city: string;
  canonicalAddress: string | null;
  googlePlaceId: string | null;
  addressComponents: Record<string, string>;
  bbox: BoundingBox;
  widthKm: number;
  heightKm: number;
  areaKm2: number;
  source: BboxSource;
  /** Which provider produced it. Useful in logs; not persisted. */
  providerName: string;
  /** ISO instant. */
  resolvedAt: string;
  /** True when it came from the `locations` cache rather than a fresh lookup. */
  fromCache: boolean;
  /** `locations.id`, when the row exists. */
  locationId: string | null;
};

export interface BboxProvider {
  /** Stable identifier used in logs and in the resolver's attempt trail. */
  readonly name: string;
  /** The `bbox_source` value a hit from this provider is recorded under. */
  readonly source: BboxSource;
  /**
   * True for providers that reach a Google endpoint.
   *
   * The resolver SKIPS these entirely unless external calls are explicitly
   * enabled, so a disabled provider never constructs a request, never reserves
   * quota, and never has an opportunity to spend anything.
   */
  readonly requiresExternalCall: boolean;
  /** Returns null for "not my job" -- only a real failure should throw. */
  resolve(query: LocationQuery): Promise<ResolvedLocation | null>;
}

export class ProviderNotEnabledError extends Error {
  readonly providerName: string;
  constructor(providerName: string, message: string) {
    super(message);
    this.name = "ProviderNotEnabledError";
    this.providerName = providerName;
  }
}
