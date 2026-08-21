import "server-only";

import { createHash } from "node:crypto";

import { DEFAULT_GRID_CONFIG, PLACES_FIELD_MASK } from "@/lib/constants";
import { locationLabel } from "@/lib/format";
import { assertValidBbox, bboxAreaKm2, type BoundingBox } from "@/lib/geo/bbox";
import type { CreateSearchValues } from "@/lib/schemas/search";
import { getSupabaseAdminClient } from "@/server/db/admin";
import { resolveBbox } from "@/server/geo/bbox-resolver";
import { ManualBboxProvider } from "@/server/geo/providers/manual-provider";
import type { ResolvedLocation } from "@/server/geo/types";
import * as pricing from "@/server/pricing/pricing-service";

import { PHASE_3A_LIMITS, Phase3aLimitError } from "./limits";
import { logSearchEvent } from "./events";

/**
 * Creates a search and its seed tile.
 *
 * Creating a search costs nothing: planning is free, and only searching bills.
 * That is why the whole grid can be laid down before a single call is made, and
 * why a run that stops early still leaves the unsearched area visible as pending
 * tiles rather than as an unrecorded gap.
 *
 * Writes go through the service-role client because `search_tiles` deliberately
 * has no authenticated INSERT policy -- tile geometry is the input to every cost
 * estimate, so the browser may read it and never write it. Rows written this way
 * must stamp `user_id` explicitly, since RLS will not do it for us.
 */

export type CreateSearchResult = {
  searchId: string;
  tileId: string;
  label: string;
  bbox: BoundingBox;
  areaKm2: number;
  sku: string;
  location: ResolvedLocation;
};

/**
 * A stable fingerprint of "the same area, planned the same way". Lets a repeat
 * of an identical search be recognised later without comparing eight columns.
 */
export function computeGridKey(bbox: BoundingBox, grid: { seedTileEdgeKm: number; maxSubdivisionDepth: number }): string {
  const canonical = [
    bbox.minLat.toFixed(6),
    bbox.minLng.toFixed(6),
    bbox.maxLat.toFixed(6),
    bbox.maxLng.toFixed(6),
    grid.seedTileEdgeKm,
    grid.maxSubdivisionDepth,
  ].join("|");

  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export async function createSearch(
  input: CreateSearchValues,
  context: { userId: string },
): Promise<CreateSearchResult> {
  const db = getSupabaseAdminClient();

  const niche = input.niche.trim();
  const state = input.state?.trim() ? input.state.trim() : null;

  // ---------------------------------------------------------------------
  // 1. The rectangle.
  //
  // A controlled test supplies its own. It is resolved through the SAME chain
  // the real flow uses, but with only the manual provider in it: the chain
  // tries the cache and the fixtures FIRST, so leaving them in would let a
  // request for a 3 km test box resolve to the whole city instead.
  // ---------------------------------------------------------------------
  if (!input.testBbox) {
    throw new Phase3aLimitError(
      "maxAreaKm2",
      "Phase 3A requires an explicit test rectangle. Automatic city resolution needs the Geocoding provider, which is not enabled yet.",
    );
  }

  const resolution = await resolveBbox(
    {
      country: input.country.trim(),
      state,
      city: input.city.trim(),
      manualBbox: input.testBbox,
      userId: context.userId,
    },
    { providers: [new ManualBboxProvider()], persist: false },
  );

  const location = resolution.location;
  const bbox = location.bbox;
  assertValidBbox(bbox);

  const areaKm2 = bboxAreaKm2(bbox);

  // ---------------------------------------------------------------------
  // 2. Phase 3A guard rails, enforced on the server. A value typed into the
  //    browser cannot widen these.
  // ---------------------------------------------------------------------
  if (areaKm2 > PHASE_3A_LIMITS.maxAreaKm2) {
    throw new Phase3aLimitError(
      "maxAreaKm2",
      `The test area is ${areaKm2.toFixed(1)} km², over the Phase 3A limit of ${PHASE_3A_LIMITS.maxAreaKm2} km². ` +
        `This phase proves the pipeline on one small tile; full-city grids arrive in Phase 3B.`,
    );
  }

  if (input.targetLeads > PHASE_3A_LIMITS.maxTargetLeads) {
    throw new Phase3aLimitError(
      "maxTargetLeads",
      `Target of ${input.targetLeads} exceeds the Phase 3A limit of ${PHASE_3A_LIMITS.maxTargetLeads} leads.`,
    );
  }

  // ---------------------------------------------------------------------
  // 3. The frozen definition.
  //
  // The grid config recorded here describes what will ACTUALLY happen: one
  // seed tile and no subdivision. Storing the normal defaults would leave the
  // row claiming a 90-tile plan that this phase never runs.
  // ---------------------------------------------------------------------
  const gridConfig = {
    ...DEFAULT_GRID_CONFIG,
    ...input.gridConfig,
    minSeedTiles: PHASE_3A_LIMITS.maxSeedTiles,
    maxSeedTiles: PHASE_3A_LIMITS.maxSeedTiles,
    maxSubdivisionDepth: 0,
    phase: "3A-controlled" as const,
    maxPagesPerTile: PHASE_3A_LIMITS.maxPagesPerTile,
  };

  const sku = pricing.classify(PLACES_FIELD_MASK).sku;
  const label = `${locationLabel(input.city.trim(), state, input.country.trim())} · controlled test`;

  const { data: search, error: searchError } = await db
    .from("searches")
    .insert({
      user_id: context.userId,
      niche,
      // The niche ALONE. Never "niche in city" -- naming the city pulls
      // Google's ranking back to the centroid and defeats the tiling.
      query_text: niche,
      country: input.country.trim(),
      state,
      city: input.city.trim(),
      label,
      min_lat: bbox.minLat,
      min_lng: bbox.minLng,
      max_lat: bbox.maxLat,
      max_lng: bbox.maxLng,
      target_leads: input.targetLeads,
      grid_config: gridConfig,
      grid_key: computeGridKey(bbox, gridConfig),
      pricing_version: pricing.getVersion(),
      field_mask: [...PLACES_FIELD_MASK],
      search_sku: sku,
      status: "draft",
    })
    .select("id")
    .single();

  if (searchError || !search) {
    throw new Error(`Could not create the search: ${searchError?.message ?? "no row returned"}`);
  }

  // ---------------------------------------------------------------------
  // 4. The seed grid. Phase 3A is exactly one tile covering the whole test
  //    rectangle, so the union of leaves equals the bbox trivially and
  //    verify_search_coverage has an exact area match to check against.
  // ---------------------------------------------------------------------
  const { data: tile, error: tileError } = await db
    .from("search_tiles")
    .insert({
      search_id: search.id,
      depth: 0,
      path: "1",
      label: "Tile #1",
      min_lat: bbox.minLat,
      min_lng: bbox.minLng,
      max_lat: bbox.maxLat,
      max_lng: bbox.maxLng,
      last_reason: "seed",
    })
    .select("id")
    .single();

  if (tileError || !tile) {
    // Leave the search row: it is a draft with no tiles, which the UI can show
    // and the user can delete. Silently discarding it would hide the failure.
    throw new Error(`Could not create the seed tile: ${tileError?.message ?? "no row returned"}`);
  }

  await db.rpc("recompute_search_progress", { p_search: search.id });

  await logSearchEvent(db, {
    searchId: search.id,
    level: "info",
    code: "search_created",
    message: `Controlled test created: 1 tile, ${areaKm2.toFixed(2)} km², target ${input.targetLeads} leads`,
    meta: {
      area_km2: Number(areaKm2.toFixed(4)),
      bbox,
      sku,
      pricing_version: pricing.getVersion(),
      phase: "3A",
      max_pages_per_tile: PHASE_3A_LIMITS.maxPagesPerTile,
    },
  });

  return {
    searchId: search.id,
    tileId: tile.id,
    label,
    bbox,
    areaKm2,
    sku,
    location,
  };
}
