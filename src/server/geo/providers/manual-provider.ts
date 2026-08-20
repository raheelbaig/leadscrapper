import "server-only";

import { isValidBbox } from "@/lib/geo/bbox";

import { buildResolvedLocation } from "../resolved-location";
import type { BboxProvider, LocationQuery, ResolvedLocation } from "../types";

/**
 * Step 5, the last resort: a rectangle typed in by the user.
 *
 * There is always an answer at the end of the chain. If Google cannot name a
 * place, the user can still draw a box around it and run the search -- the grid
 * only ever needed a rectangle.
 *
 * An invalid rectangle returns null rather than throwing, so the resolver
 * reports "no provider could resolve this" with the full attempt trail instead
 * of a validation error that hides the four earlier misses.
 */
export class ManualBboxProvider implements BboxProvider {
  readonly name = "manual-entry";
  readonly source = "user_entered" as const;
  readonly requiresExternalCall = false;

  async resolve(query: LocationQuery): Promise<ResolvedLocation | null> {
    if (!query.manualBbox || !isValidBbox(query.manualBbox)) return null;

    return buildResolvedLocation({
      country: query.country,
      state: query.state,
      city: query.city,
      bbox: query.manualBbox,
      source: this.source,
      providerName: this.name,
    });
  }
}
