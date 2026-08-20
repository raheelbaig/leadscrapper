import "server-only";

import {
  ProviderNotEnabledError,
  type BboxProvider,
  type LocationQuery,
  type ResolvedLocation,
} from "../types";

/**
 * Step 4 of the chain: the viewport of a Places result, used only when
 * Geocoding returns nothing usable for a place.
 *
 * NOT IMPLEMENTED IN PHASE 2, BY DESIGN. No URL, no `fetch`, no key.
 *
 * Phase 3 note that must not be lost: `places.viewport` is a PRO-tier field, so
 * a request asking for it bills at Pro, not Essentials -- and if the mask ever
 * also carried an Enterprise field the whole request would bill at Enterprise.
 * The SKU therefore has to come from `pricing.classify(mask)` on the mask this
 * provider actually sends, never from an assumption about which endpoint it is.
 *
 * A viewport is what Google would display, which is not the same thing as an
 * administrative boundary. It is a fallback, and a resolution that used it
 * should be surfaced to the user as approximate.
 */
export class PlacesViewportBboxProvider implements BboxProvider {
  readonly name = "places-viewport";
  readonly source = "places" as const;
  readonly requiresExternalCall = true;

  async resolve(_query: LocationQuery): Promise<ResolvedLocation | null> {
    void _query;
    throw new ProviderNotEnabledError(
      this.name,
      "The Places viewport provider lands in Phase 3. Phase 2 makes zero Google requests.",
    );
  }
}
