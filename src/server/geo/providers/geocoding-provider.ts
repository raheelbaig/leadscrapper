import "server-only";

import {
  ProviderNotEnabledError,
  type BboxProvider,
  type LocationQuery,
  type ResolvedLocation,
} from "../types";

/**
 * Step 3 of the chain: the Google Geocoding API.
 *
 * NOT IMPLEMENTED IN PHASE 2, BY DESIGN.
 *
 * This file contains no URL, no `fetch`, and no reference to the API key. The
 * resolver skips it while `EXTERNAL_PROVIDERS_ENABLED` is false, so the throw
 * below is a second line of defence rather than the mechanism -- a direct
 * caller that bypassed the resolver would still be stopped here.
 *
 * Phase 3 fills this in, and the shape of that change is already fixed:
 *
 *   1. reserve quota FIRST, through `reserveCalls({ sku, calls: 1 })` with the
 *      SKU from `pricing.getSkuForEndpoint("geocoding")`. Never the Enterprise
 *      search SKU -- resolving a city must not consume the allowance the leads
 *      themselves depend on;
 *   2. issue the request;
 *   3. `recordCall(...)` on a billable response, or `releaseCalls(...)` when no
 *      HTTP status ever arrived;
 *   4. take `geometry.bounds` when present, falling back to `geometry.viewport`,
 *      and reject a response with neither rather than inventing a rectangle.
 *
 * Because a resolved city is cached forever, this costs one Geocoding call per
 * city for the lifetime of the application.
 */
export class GeocodingBboxProvider implements BboxProvider {
  readonly name = "geocoding";
  readonly source = "geocoding" as const;
  readonly requiresExternalCall = true;

  async resolve(_query: LocationQuery): Promise<ResolvedLocation | null> {
    void _query;
    throw new ProviderNotEnabledError(
      this.name,
      "The Geocoding provider lands in Phase 3. Phase 2 makes zero Google requests.",
    );
  }
}
