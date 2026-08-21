import "server-only";

import { createHash } from "node:crypto";

import { DEFAULT_GRID_CONFIG, PLACES_FIELD_MASK } from "@/lib/constants";
import { locationLabel } from "@/lib/format";
import {
  assertValidBbox,
  bboxAreaKm2,
  gridDimensions,
  seedTilePath,
  seedTileRects,
  type BoundingBox,
  type GridDimensions,
} from "@/lib/geo/bbox";
import type { CreateSearchValues } from "@/lib/schemas/search";
import { getSupabaseAdminClient } from "@/server/db/admin";
import { resolveBbox } from "@/server/geo/bbox-resolver";
import { ManualBboxProvider } from "@/server/geo/providers/manual-provider";
import type { ResolvedLocation } from "@/server/geo/types";
import * as pricing from "@/server/pricing/pricing-service";

import { PHASE_3B_LIMITS, SearchLimitError } from "./limits";
import { logSearchEvent } from "./events";

/**
 * Creates a search and its complete seed grid.
 *
 * Creating a search costs nothing: planning is free, and only searching bills.
 * That is why the whole grid is laid down before a single call is made, and why
 * a run that stops early still leaves the unsearched area visible as pending
 * tiles rather than as an unrecorded gap.
 *
 * The grid is COVERAGE-FIRST. `target_leads` has zero influence on the
 * geometry: the tile count follows from the size of the rectangle and the seed
 * edge length alone. A target decides only when a run may stop early, and the
 * coverage report then has to say exactly what geography went unsearched.
 *
 * Writes go through the service-role client because `search_tiles` deliberately
 * has no authenticated INSERT policy -- tile geometry is the input to every
 * cost estimate, so the browser may read it and never write it. Rows written
 * this way must stamp `user_id` explicitly, since RLS will not do it for us.
 */

export type CreateSearchResult = {
  searchId: string;
  tileIds: string[];
  label: string;
  bbox: BoundingBox;
  areaKm2: number;
  grid: GridDimensions;
  sku: string;
  location: ResolvedLocation;
};

/**
 * A stable fingerprint of "the same area, planned the same way". Lets a repeat
 * of an identical search be recognised later without comparing eight columns.
 */
export function computeGridKey(
  bbox: BoundingBox,
  grid: { seedTileEdgeKm: number; maxSubdivisionDepth: number },
): string {
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
  // request for a small test box resolve to the whole city instead.
  // ---------------------------------------------------------------------
  if (!input.testBbox) {
    throw new SearchLimitError(
      "maxAreaKm2",
      "Phase 3B still requires an explicit test rectangle. Automatic city resolution needs the Geocoding provider, which is not enabled.",
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
  // 2. Phase 3B guard rails, enforced on the server. A value typed into the
  //    browser cannot widen these.
  // ---------------------------------------------------------------------
  if (areaKm2 > PHASE_3B_LIMITS.maxAreaKm2) {
    throw new SearchLimitError(
      "maxAreaKm2",
      `The test area is ${areaKm2.toFixed(1)} km², over the Phase 3B limit of ${PHASE_3B_LIMITS.maxAreaKm2} km². ` +
        `Houston's full bounding box is roughly 3,700 km²; this phase proves the grid engine on a district, not a city.`,
    );
  }

  if (input.targetLeads > PHASE_3B_LIMITS.maxTargetLeads) {
    throw new SearchLimitError(
      "maxTargetLeads",
      `Target of ${input.targetLeads} exceeds the Phase 3B limit of ${PHASE_3B_LIMITS.maxTargetLeads} leads.`,
    );
  }

  // ---------------------------------------------------------------------
  // 3. The frozen definition.
  //
  // The grid config recorded here describes what will ACTUALLY happen, capped
  // to the phase limits. Storing the raw defaults would leave the row claiming
  // a 400-tile, depth-3 plan this phase will never run.
  // ---------------------------------------------------------------------
  const requested = { ...DEFAULT_GRID_CONFIG, ...input.gridConfig };

  const gridConfig = {
    ...requested,
    minSeedTiles: Math.min(requested.minSeedTiles, PHASE_3B_LIMITS.maxSeedTiles),
    maxSeedTiles: Math.min(requested.maxSeedTiles, PHASE_3B_LIMITS.maxSeedTiles),
    maxSubdivisionDepth: Math.min(
      requested.maxSubdivisionDepth,
      PHASE_3B_LIMITS.maxSubdivisionDepth,
    ),
    phase: "3B-controlled" as const,
    maxPagesPerTile: PHASE_3B_LIMITS.maxPagesPerTile,
    maxAttemptsPerPage: PHASE_3B_LIMITS.maxAttemptsPerPage,
    maxCallsPerSearch: PHASE_3B_LIMITS.maxCallsPerSearch,
  };

  // Coverage-first sizing, from the rectangle and the seed edge alone.
  const grid = gridDimensions(bbox, {
    seedTileEdgeKm: gridConfig.seedTileEdgeKm,
    minSeedTiles: gridConfig.minSeedTiles,
    maxSeedTiles: gridConfig.maxSeedTiles,
  });

  if (grid.tileCount > PHASE_3B_LIMITS.maxSeedTiles) {
    // Unreachable while gridDimensions clamps to the same ceiling, kept because
    // a silently oversized grid is the one failure this phase cannot absorb.
    throw new SearchLimitError(
      "maxSeedTiles",
      `The grid resolved to ${grid.tileCount} seed tiles, over the Phase 3B limit of ${PHASE_3B_LIMITS.maxSeedTiles}.`,
    );
  }

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
  // 4. The seed grid.
  //
  // Edges are interpolated between min and max, so the union of the tiles is
  // the search rectangle exactly -- which is the property `verify_search_coverage`
  // checks by area a few lines below.
  //
  // Paths are zero-padded because `ORDER BY path` is also the scan order, and
  // Postgres sorts text: "10" would otherwise come before "2" and scramble the
  // order of any grid larger than nine tiles.
  // ---------------------------------------------------------------------
  const rects = seedTileRects(bbox, grid);

  const { data: tiles, error: tileError } = await db
    .from("search_tiles")
    .insert(
      rects.map((rect) => ({
        search_id: search.id,
        depth: 0,
        path: seedTilePath(rect.index),
        label: `Tile #${rect.index}`,
        min_lat: rect.minLat,
        min_lng: rect.minLng,
        max_lat: rect.maxLat,
        max_lng: rect.maxLng,
        last_reason: "seed",
      })),
    )
    .select("id, path")
    .order("path");

  if (tileError || !tiles || tiles.length !== rects.length) {
    // Leave the search row: it is a draft with an incomplete grid, which the UI
    // can show and the user can delete. Silently discarding it would hide the
    // failure, and silently running it would search a grid with holes in it.
    throw new Error(
      `Could not create the seed grid: ${tileError?.message ?? `expected ${rects.length} tiles, got ${tiles?.length ?? 0}`}`,
    );
  }

  await db.rpc("recompute_search_progress", { p_search: search.id });

  // Free, and it checks the one thing a grid can get wrong before any call is
  // billed: that the leaves tile the rectangle with no gap and no overlap.
  const { data: invariant } = await db.rpc("verify_search_coverage", { p_search: search.id });
  const report = invariant as Record<string, unknown> | null;

  await logSearchEvent(db, {
    searchId: search.id,
    level: report?.ok === false ? "error" : "info",
    code: "search_created",
    message:
      `Controlled test created: ${grid.cols}×${grid.rows} = ${grid.tileCount} seed tile(s), ` +
      `${grid.tileWidthKm.toFixed(2)}×${grid.tileHeightKm.toFixed(2)} km each, ` +
      `${areaKm2.toFixed(2)} km² total, target ${input.targetLeads} leads. ` +
      `Nothing has been requested from Google.`,
    meta: {
      area_km2: Number(areaKm2.toFixed(4)),
      bbox,
      sku,
      pricing_version: pricing.getVersion(),
      phase: "3B",
      cols: grid.cols,
      rows: grid.rows,
      tile_count: grid.tileCount,
      tile_width_km: Number(grid.tileWidthKm.toFixed(4)),
      tile_height_km: Number(grid.tileHeightKm.toFixed(4)),
      clamped: grid.clamped,
      max_pages_per_tile: gridConfig.maxPagesPerTile,
      max_subdivision_depth: gridConfig.maxSubdivisionDepth,
      max_calls_per_search: gridConfig.maxCallsPerSearch,
      coverage_ok: report?.ok ?? null,
      api_calls_made: 0,
    },
  });

  return {
    searchId: search.id,
    tileIds: tiles.map((tile) => tile.id),
    label,
    bbox,
    areaKm2,
    grid,
    sku,
    location,
  };
}
