import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildCoverageReport, type CoverageTile } from "@/lib/coverage-report";
import { bboxAreaKm2 } from "@/lib/geo/bbox";
import type { TileState } from "@/lib/tile-states";
import type { LeadPayload } from "@/server/places/lead-mapper";
import { SEARCH_LIMITS } from "@/server/search/limits";

/**
 * The Phase 3B grid engine, against the REAL database. OPT-IN:
 *
 *     LEAD_SCRAPPER_DB_TESTS=1 npx vitest run src/server/search/grid.db.test.ts
 *
 * Skipped by default so `npm test` stays hermetic and needs no credentials.
 *
 * These are the assertions that cannot be made against a fake. Subdivision is a
 * SQL function with its own all-or-nothing guarantees, tile transitions are
 * enforced by a trigger, coverage invariants are checked by another SQL
 * function, and deduplication is a unique index. A mock would only prove that
 * the mock agrees with itself.
 *
 * It makes NO Google request. The Google key in this process is a dummy, and
 * nothing here touches the Places client -- every tile state below is written
 * directly, exactly as the runner would write it after a response it never has
 * to make.
 *
 * Every row it writes is deleted afterwards; the search cascade removes tiles,
 * leads and events, and `places_seen` is cleaned up explicitly.
 */
const ENABLED = process.env.LEAD_SCRAPPER_DB_TESTS === "1";

/** The rectangle planned for the controlled Phase 3B run. */
const TEST_BBOX = { minLat: 29.69, minLng: -95.45, maxLat: 29.83, maxLng: -95.28 };

const PLACE_SHARED = "ChIJ_phase3b_shared_place";

function lead(placeId: string, name: string, tileLabel: string): LeadPayload {
  return {
    place_id: placeId,
    name,
    phone_national: "(713) 555-0199",
    phone_international: "+1 713-555-0199",
    address: "9 Grid Way, Houston, TX 77002, USA",
    website: "https://example.test",
    maps_url: "https://maps.google.com/?cid=0",
    city: "Houston",
    state: "TX",
    country: "USA",
    lat: 29.75,
    lng: -95.36,
    query_tile: tileLabel,
    raw: { id: placeId, probe: true },
  };
}

describe.skipIf(!ENABLED)("the Phase 3B grid engine", () => {
  let db: ReturnType<typeof import("@/server/db/admin").getSupabaseAdminClient>;
  let userId: string;
  let searchId: string;
  let tileIds: string[] = [];
  const placeIds: string[] = [PLACE_SHARED];

  beforeAll(async () => {
    const { getSupabaseAdminClient } = await import("@/server/db/admin");
    const { createSearch } = await import("./create-search");
    db = getSupabaseAdminClient();

    const { data: settings, error } = await db.from("app_settings").select("user_id").limit(1);
    if (error) throw new Error(`Could not read app_settings: ${error.message}`);
    if (!settings?.length) throw new Error("No account exists to attach the probe search to.");
    userId = settings[0].user_id;

    const created = await createSearch(
      {
        niche: "Phase 3B Grid Probe",
        country: "United States",
        state: "Texas",
        city: "Houston",
        targetLeads: 40,
        gridConfig: {
          sizingStrategy: "coverage-first",
          seedTileEdgeKm: 8,
          maxSubdivisionDepth: 3,
          minTileEdgeKm: 0.5,
          saturationRatio: 0.95,
          minSeedTiles: 4,
          maxSeedTiles: 400,
          // False, which is now the only value the product ships. The probe
          // used to pass `true` here; carrying that forward would have made
          // this suite assert the behaviour Phase 4 removed.
          stopOnTargetReached: false,
        },
        testBbox: TEST_BBOX,
      },
      { userId },
    );

    searchId = created.searchId;
    tileIds = created.tileIds;
  }, 90_000);

  afterAll(async () => {
    if (!ENABLED || !db) return;
    // The search cascade takes tiles, leads, tile_events and search_events.
    await db.from("places_seen").delete().in("place_id", placeIds).eq("user_id", userId);
    if (searchId) await db.from("searches").delete().eq("id", searchId);
  }, 60_000);

  // -------------------------------------------------------------------------
  describe("the seed grid", () => {
    it("lays a 3x2 grid from the bbox and the seed edge, not from the target", () => {
      // 16.43 km wide / 8 km = 3 columns; 15.48 km tall / 8 km = 2 rows.
      expect(tileIds).toHaveLength(6);
    });

    it("freezes the grid config the runner will actually honour", async () => {
      const { data } = await db.from("searches").select("grid_config").eq("id", searchId).single();

      const config = data?.grid_config as Record<string, unknown>;

      // The row records what will ACTUALLY happen, clamped to the server
      // limits -- not the raw request. These are the Phase 4 values; the
      // controlled Phase 3B caps (depth 1, 9 seed tiles) were raised by
      // approval on 2026-08-22.
      expect(config.maxSubdivisionDepth).toBe(SEARCH_LIMITS.maxSubdivisionDepth);
      expect(config.maxSeedTiles).toBe(SEARCH_LIMITS.maxSeedTiles);
      expect(config.maxCallsPerSearch).toBe(SEARCH_LIMITS.maxCallsPerSearch);
      expect(config.phase).toBe("4");

      // The stop policy is frozen too, and it is the new default: the lead
      // target does not end this search.
      expect(config.stopOnTargetReached).toBe(false);
    });

    it("starts every tile pending, at depth 0", async () => {
      const { data } = await db
        .from("search_tiles")
        .select("state, depth, path, label")
        .eq("search_id", searchId)
        .order("path");

      expect(data).toHaveLength(6);
      expect(data?.every((t) => t.state === "pending" && t.depth === 0)).toBe(true);
    });

    it("zero-pads the paths, so ORDER BY path is also scan order", async () => {
      const { data } = await db
        .from("search_tiles")
        .select("path, label")
        .eq("search_id", searchId)
        .order("path");

      expect(data?.map((t) => t.path)).toEqual(["001", "002", "003", "004", "005", "006"]);
      expect(data?.map((t) => t.label)).toEqual([
        "Tile #1",
        "Tile #2",
        "Tile #3",
        "Tile #4",
        "Tile #5",
        "Tile #6",
      ]);
    });

    it("tiles the rectangle exactly: the leaf areas sum to the bbox area", async () => {
      const { data } = await db.from("search_tiles").select("area_km2").eq("search_id", searchId);

      const summed = (data ?? []).reduce((sum, t) => sum + (t.area_km2 ?? 0), 0);
      expect(summed).toBeCloseTo(bboxAreaKm2(TEST_BBOX), 0);
    });

    it("passes the coverage invariant before a single call is made", async () => {
      // Planning is free. A grid with a hole in it should be caught here, not
      // after the geography has been paid for.
      const { data } = await db.rpc("verify_search_coverage", { p_search: searchId });
      const report = data as Record<string, unknown>;

      expect(report.ok).toBe(true);
      expect(report.disjoint).toBe(true);
      expect(report.area_matches).toBe(true);
      expect(report.in_progress).toBe(0);
      expect(report.leaf_count).toBe(6);
    });
  });

  // -------------------------------------------------------------------------
  describe("subdivision", () => {
    let parentId: string;
    let parentArea: number;

    beforeAll(async () => {
      const { data } = await db
        .from("search_tiles")
        .select("id, area_km2")
        .eq("search_id", searchId)
        .order("path")
        .limit(1)
        .single();

      parentId = data!.id;
      parentArea = data!.area_km2 ?? 0;

      // The runner never subdivides a pending tile: create_child_tiles performs
      // the in_progress -> subdivided transition itself.
      await db
        .from("search_tiles")
        .update({ state: "in_progress", last_reason: "probe claimed" })
        .eq("id", parentId);
    }, 60_000);

    it("creates exactly 4 children", async () => {
      const { data, error } = await db.rpc("create_child_tiles", {
        p_tile: parentId,
        p_reason: "R4a: saturated — probe",
      });

      expect(error).toBeNull();
      expect(data).toBe(4);
    });

    it("returns 4 again on an idempotent retry, not 0", async () => {
      // A retry after a crash must not read as a failure. The function returns
      // how many children the parent HAS, not how many it just inserted.
      const { data, error } = await db.rpc("create_child_tiles", {
        p_tile: parentId,
        p_reason: "R4a: saturated — probe retry",
      });

      expect(error).toBeNull();
      expect(data).toBe(4);
    });

    it("turns the parent into a container, not a leaf", async () => {
      const { data } = await db.from("search_tiles").select("state").eq("id", parentId).single();
      expect(data?.state).toBe("subdivided");
    });

    it("leaves the children pending at depth 1", async () => {
      const { data } = await db
        .from("search_tiles")
        .select("state, depth, path, label")
        .eq("parent_tile_id", parentId)
        .order("path");

      expect(data).toHaveLength(4);
      expect(data?.every((c) => c.state === "pending" && c.depth === 1)).toBe(true);
      expect(data?.map((c) => c.path)).toEqual(["001.ne", "001.nw", "001.se", "001.sw"]);
    });

    it("covers the parent exactly: no gap, no overlap", async () => {
      const { data } = await db
        .from("search_tiles")
        .select("area_km2")
        .eq("parent_tile_id", parentId);

      const summed = (data ?? []).reduce((sum, c) => sum + (c.area_km2 ?? 0), 0);
      expect(summed).toBeCloseTo(parentArea, 1);
    });

    it("keeps the coverage invariant true after the split", async () => {
      const { data } = await db.rpc("verify_search_coverage", { p_search: searchId });
      const report = data as Record<string, unknown>;

      expect(report.ok).toBe(true);
      expect(report.disjoint).toBe(true);
      expect(report.area_matches).toBe(true);
      // 5 untouched seeds + 4 children. The subdivided parent is not a leaf.
      expect(report.leaf_count).toBe(9);
    });

    it("counts leaves only, so a split does not inflate the coverage total", async () => {
      await db.rpc("recompute_search_progress", { p_search: searchId });

      const { data } = await db
        .from("searches")
        .select("tiles_total, tiles_subdivided, tiles_pending, area_total_km2")
        .eq("id", searchId)
        .single();

      expect(data?.tiles_total).toBe(9);
      expect(data?.tiles_subdivided).toBe(1);
      expect(data?.tiles_pending).toBe(9);
      expect(data?.area_total_km2).toBeCloseTo(bboxAreaKm2(TEST_BBOX), 0);
    });

    it("refuses to subdivide a tile that is not claimed", async () => {
      // Four children beside a parent that is still a live leaf would overlap
      // it -- exactly what verify_search_coverage flags as a broken grid.
      const { data: pending } = await db
        .from("search_tiles")
        .select("id")
        .eq("search_id", searchId)
        .eq("state", "pending")
        .limit(1)
        .single();

      const { error } = await db.rpc("create_child_tiles", {
        p_tile: pending!.id,
        p_reason: "probe: should be refused",
      });

      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/cannot subdivide/i);
    });
  });

  // -------------------------------------------------------------------------
  describe("deduplication across tiles", () => {
    let tileA: string;
    let tileB: string;

    beforeAll(async () => {
      const { data } = await db
        .from("search_tiles")
        .select("id, label")
        .eq("search_id", searchId)
        .eq("state", "pending")
        .order("path")
        .limit(2);

      tileA = data![0].id;
      tileB = data![1].id;
    }, 60_000);

    it("accepts a place the first time it is seen", async () => {
      const { data, error } = await db.rpc("insert_leads_dedup", {
        p_search: searchId,
        p_tile: tileA,
        p_leads: [lead(PLACE_SHARED, "Shared Shop", "Tile A")] as never,
      });

      expect(error).toBeNull();
      const row = Array.isArray(data) ? data[0] : null;
      expect(row).toMatchObject({ received: 1, inserted: 1 });
    });

    it("rejects the same place arriving from a DIFFERENT tile", async () => {
      // Adjacent tiles overlap in Google's ranking, not in geometry -- the same
      // business genuinely comes back from two rectangles. The unique index on
      // (search_id, place_id) is what makes that a no-op rather than a duplicate
      // row, and it survives a crash, a resume and two ticks back to back.
      const { data, error } = await db.rpc("insert_leads_dedup", {
        p_search: searchId,
        p_tile: tileB,
        p_leads: [lead(PLACE_SHARED, "Shared Shop (again)", "Tile B")] as never,
      });

      expect(error).toBeNull();
      const row = Array.isArray(data) ? data[0] : null;
      expect(row).toMatchObject({ received: 1, inserted: 0 });
    });

    it("still holds exactly one row for that place", async () => {
      const { count } = await db
        .from("leads")
        .select("id", { count: "exact", head: true })
        .eq("search_id", searchId)
        .eq("place_id", PLACE_SHARED);

      expect(count).toBe(1);
    });

    it("keeps the lead attributed to the tile that first found it", async () => {
      const { data } = await db
        .from("leads")
        .select("tile_id, query_tile, email, email_status")
        .eq("search_id", searchId)
        .eq("place_id", PLACE_SHARED)
        .single();

      expect(data?.tile_id).toBe(tileA);
      // Phase 3B adds no email enrichment whatsoever.
      expect(data?.email).toBeNull();
      expect(data?.email_status).toBe("not_enriched");
    });

    it("rejects it again after a simulated resume", async () => {
      // The dedupe is not in memory, so a fresh runner rediscovers nothing new.
      const { data } = await db.rpc("insert_leads_dedup", {
        p_search: searchId,
        p_tile: tileA,
        p_leads: [lead(PLACE_SHARED, "Shared Shop (resumed)", "Tile A")] as never,
      });

      const row = Array.isArray(data) ? data[0] : null;
      expect(row).toMatchObject({ received: 1, inserted: 0 });
    });
  });

  // -------------------------------------------------------------------------
  describe("resume", () => {
    it("returns an interrupted in_progress tile to pending and drops its token", async () => {
      // A dead process cannot have completed a tile, and page tokens expire --
      // so the tile restarts at page 1 rather than from a token Google forgot.
      const { data: tile } = await db
        .from("search_tiles")
        .select("id")
        .eq("search_id", searchId)
        .eq("state", "pending")
        .order("path")
        .limit(1)
        .single();

      await db
        .from("search_tiles")
        .update({
          state: "in_progress",
          last_reason: "probe: pretend a runner died here",
          next_page_token: "stale-token-from-a-dead-process",
          results_count: 20,
          pages_fetched: 1,
        })
        .eq("id", tile!.id);

      const { data: recovered, error } = await db.rpc("recover_stalled_tiles", {
        p_search: searchId,
      });

      expect(error).toBeNull();
      expect(recovered).toBeGreaterThanOrEqual(1);

      const { data: after } = await db
        .from("search_tiles")
        .select("state, next_page_token, started_at")
        .eq("id", tile!.id)
        .single();

      expect(after?.state).toBe("pending");
      expect(after?.next_page_token).toBeNull();
      expect(after?.started_at).toBeNull();
    });

    it("allows a failed tile back to pending", async () => {
      const { data: tile } = await db
        .from("search_tiles")
        .select("id")
        .eq("search_id", searchId)
        .eq("state", "pending")
        .order("path")
        .limit(1)
        .single();

      await db.from("search_tiles").update({ state: "in_progress" }).eq("id", tile!.id);
      await db
        .from("search_tiles")
        .update({ state: "failed", last_reason: "R1: probe error" })
        .eq("id", tile!.id);

      const { error } = await db
        .from("search_tiles")
        .update({ state: "pending", last_reason: "retry on resume" })
        .eq("id", tile!.id);

      expect(error).toBeNull();
    });

    it("allows a quota-skipped tile back to pending", async () => {
      const { data: tile } = await db
        .from("search_tiles")
        .select("id")
        .eq("search_id", searchId)
        .eq("state", "pending")
        .order("path")
        .limit(1)
        .single();

      await db.from("search_tiles").update({ state: "in_progress" }).eq("id", tile!.id);
      await db
        .from("search_tiles")
        .update({ state: "skipped_quota", last_reason: "budget guard denied" })
        .eq("id", tile!.id);

      const { error } = await db
        .from("search_tiles")
        .update({ state: "pending", last_reason: "retry on resume" })
        .eq("id", tile!.id);

      expect(error).toBeNull();
    });

    it("NEVER lets a covered tile be re-searched", async () => {
      // `covered` is terminal. A resume that re-claimed it would pay Google
      // again for geography that is already accounted for.
      const { data: tile } = await db
        .from("search_tiles")
        .select("id")
        .eq("search_id", searchId)
        .eq("state", "pending")
        .order("path")
        .limit(1)
        .single();

      await db.from("search_tiles").update({ state: "in_progress" }).eq("id", tile!.id);
      await db
        .from("search_tiles")
        .update({ state: "covered", last_reason: "R3: probe covered" })
        .eq("id", tile!.id);

      const { error } = await db
        .from("search_tiles")
        .update({ state: "pending" })
        .eq("id", tile!.id);

      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/illegal tile transition/i);
    });

    it("does not offer a covered tile to the next-pending query", async () => {
      const { data: pending } = await db
        .from("search_tiles")
        .select("id, state")
        .eq("search_id", searchId)
        .eq("state", "pending");

      expect(pending?.every((t) => t.state === "pending")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe("the coverage report over real rows", () => {
    it("reports partial coverage honestly while tiles remain", async () => {
      await db.rpc("recompute_search_progress", { p_search: searchId });

      const [{ data: tiles }, { data: search }] = await Promise.all([
        db.from("search_tiles").select("label, state, area_km2, depth").eq("search_id", searchId),
        db.from("searches").select("leads_found, target_leads").eq("id", searchId).single(),
      ]);

      const report = buildCoverageReport({
        tiles: (tiles ?? []).map((t): CoverageTile => ({
          label: t.label,
          state: t.state as TileState,
          area_km2: t.area_km2 ?? 0,
          depth: t.depth,
        })),
        target: search!.target_leads,
        leadsFound: search!.leads_found,
      });

      expect(report.fullyCovered).toBe(false);
      expect(report.owed.tiles).toBeGreaterThan(0);
      expect(report.summary).toMatch(/DID NOT COVER THE WHOLE AREA/);
      // The leaves still add up to the whole rectangle.
      expect(report.areaTotalKm2).toBeCloseTo(bboxAreaKm2(TEST_BBOX), 0);
    });

    it("agrees with the denormalized counters the UI reads", async () => {
      const { data: search } = await db
        .from("searches")
        .select("tiles_total, tiles_covered, tiles_pending, coverage_pct")
        .eq("id", searchId)
        .single();

      const { data: tiles } = await db
        .from("search_tiles")
        .select("label, state, area_km2, depth")
        .eq("search_id", searchId);

      const report = buildCoverageReport({
        tiles: (tiles ?? []).map((t): CoverageTile => ({
          label: t.label,
          state: t.state as TileState,
          area_km2: t.area_km2 ?? 0,
          depth: t.depth,
        })),
        target: 40,
        leadsFound: 1,
      });

      expect(report.leafTiles).toBe(search?.tiles_total);
      expect(report.byState.covered.tiles).toBe(search?.tiles_covered);
      expect(report.byState.pending.tiles).toBe(search?.tiles_pending);
      expect(report.coveragePct).toBeCloseTo(search?.coverage_pct ?? 0, 1);
    });
  });

  // -------------------------------------------------------------------------
  describe("nothing reached Google", () => {
    it("logged no API call for this search", async () => {
      // Every tile state above was written directly. The whole suite runs with
      // a dummy key and never touches the Places client.
      const { count } = await db
        .from("api_call_log")
        .select("id", { count: "exact", head: true })
        .eq("search_id", searchId);

      expect(count).toBe(0);
    });

    it("left the search with zero billable calls recorded", async () => {
      const { data } = await db
        .from("searches")
        .select("api_calls_run")
        .eq("id", searchId)
        .single();

      expect(data?.api_calls_run).toBe(0);
    });
  });
});
