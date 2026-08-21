import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { LeadPayload } from "@/server/places/lead-mapper";

/**
 * Database integration suite. OPT-IN:
 *
 *     LEAD_SCRAPPER_DB_TESTS=1 npx vitest run src/server/search/persistence.db.test.ts
 *
 * Skipped by default so `npm test` stays hermetic and needs no credentials.
 *
 * These are the assertions that CANNOT be made against a fake. Deduplication is
 * a unique constraint, tile transitions are enforced by a trigger, and the
 * progress counters are recomputed by a SQL function -- a mock would only prove
 * that the mock agrees with itself. Static analysis is not enough either: the
 * Phase 1 lesson was that two real defects reached a push with clean grammar.
 *
 * It makes NO Google request. The Google key in this process is a dummy, and
 * nothing here touches the Places client.
 *
 * Every row it writes is deleted afterwards; the search cascade removes tiles,
 * leads and events, and `places_seen` is cleaned up explicitly.
 */
const ENABLED = process.env.LEAD_SCRAPPER_DB_TESTS === "1";

const PLACE_A = "ChIJ_phase3a_dedupe_test_A";
const PLACE_B = "ChIJ_phase3a_dedupe_test_B";

function lead(placeId: string, name: string): LeadPayload {
  return {
    place_id: placeId,
    name,
    phone_national: "(713) 555-0100",
    phone_international: "+1 713-555-0100",
    address: "1 Test Plaza, Houston, TX 77002, USA",
    website: "https://example.test",
    maps_url: "https://maps.google.com/?cid=0",
    city: "Houston",
    state: "TX",
    country: "USA",
    lat: 29.75,
    lng: -95.36,
    query_tile: "Tile #1 · Phase 3A Integration Probe",
    raw: { id: placeId, probe: true },
  };
}

describe.skipIf(!ENABLED)("database persistence and deduplication", () => {
  let db: Awaited<typeof import("@/server/db/admin")> extends never
    ? never
    : ReturnType<typeof import("@/server/db/admin").getSupabaseAdminClient>;
  let userId: string;
  let searchId: string;
  let tileId: string;

  beforeAll(async () => {
    const { getSupabaseAdminClient } = await import("@/server/db/admin");
    db = getSupabaseAdminClient();

    const { data: settings, error } = await db.from("app_settings").select("user_id").limit(1);
    if (error) throw new Error(`Could not read app_settings: ${error.message}`);
    if (!settings?.length) throw new Error("No account exists to attach the probe search to.");
    userId = settings[0].user_id;

    const { data: search, error: searchError } = await db
      .from("searches")
      .insert({
        user_id: userId,
        niche: "Phase 3A Integration Probe",
        query_text: "Phase 3A Integration Probe",
        country: "United States",
        state: "Texas",
        city: "Houston",
        label: "PROBE — safe to delete",
        min_lat: 29.74,
        min_lng: -95.38,
        max_lat: 29.77,
        max_lng: -95.35,
        target_leads: 5,
        grid_config: { phase: "3A-probe" },
        grid_key: "probe",
        pricing_version: "probe",
        field_mask: ["places.id"],
        search_sku: "places-text-search-enterprise",
        status: "draft",
      })
      .select("id")
      .single();

    if (searchError || !search) throw new Error(`probe search insert failed: ${searchError?.message}`);
    searchId = search.id;

    const { data: tile, error: tileError } = await db
      .from("search_tiles")
      .insert({
        search_id: searchId,
        depth: 0,
        path: "1",
        label: "Tile #1",
        min_lat: 29.74,
        min_lng: -95.38,
        max_lat: 29.77,
        max_lng: -95.35,
        last_reason: "seed",
      })
      .select("id")
      .single();

    if (tileError || !tile) throw new Error(`probe tile insert failed: ${tileError?.message}`);
    tileId = tile.id;
  }, 60_000);

  afterAll(async () => {
    if (!ENABLED || !db) return;
    // The search cascade takes tiles, leads, tile_events and search_events.
    await db.from("places_seen").delete().in("place_id", [PLACE_A, PLACE_B]).eq("user_id", userId);
    if (searchId) await db.from("searches").delete().eq("id", searchId);
  }, 60_000);

  it("starts the tile in pending", async () => {
    const { data } = await db.from("search_tiles").select("state").eq("id", tileId).single();
    expect(data?.state).toBe("pending");
  });

  it("moves pending -> in_progress and records the transition", async () => {
    const { error } = await db
      .from("search_tiles")
      .update({ state: "in_progress", last_reason: "probe claimed" })
      .eq("id", tileId);
    expect(error).toBeNull();

    const { data: events } = await db
      .from("tile_events")
      .select("from_state, to_state")
      .eq("tile_id", tileId)
      .order("id");

    // The AFTER trigger writes the ledger row; the application never does.
    expect(events?.map((e) => `${e.from_state ?? "∅"}->${e.to_state}`)).toContain(
      "pending->in_progress",
    );
  });

  it("rejects an illegal transition at the database, not in application code", async () => {
    const { error } = await db
      .from("search_tiles")
      .update({ state: "pending" })
      .eq("id", tileId)
      .select();

    // in_progress -> pending IS legal (crash recovery), so probe a genuinely
    // illegal one instead: covered is terminal and has no outbound rows.
    expect(error).toBeNull();

    await db.from("search_tiles").update({ state: "in_progress" }).eq("id", tileId);
    await db.from("search_tiles").update({ state: "covered", last_reason: "probe" }).eq("id", tileId);

    const { error: illegal } = await db
      .from("search_tiles")
      .update({ state: "in_progress" })
      .eq("id", tileId);

    expect(illegal).not.toBeNull();
    expect(illegal?.message).toMatch(/illegal tile transition/i);
  });

  it("inserts new leads and reports how many were genuinely new", async () => {
    const { data, error } = await db.rpc("insert_leads_dedup", {
      p_search: searchId,
      p_tile: tileId,
      p_leads: [lead(PLACE_A, "Probe Shop A"), lead(PLACE_B, "Probe Shop B")] as never,
    });

    expect(error).toBeNull();
    const row = Array.isArray(data) ? data[0] : null;
    expect(row?.received).toBe(2);
    expect(row?.inserted).toBe(2);
  });

  it("does NOT create a duplicate when the same place arrives twice", async () => {
    // The authoritative dedupe is the unique index on (search_id, place_id).
    // An in-memory Set would not survive a crash, a resume, or two ticks.
    const { data, error } = await db.rpc("insert_leads_dedup", {
      p_search: searchId,
      p_tile: tileId,
      p_leads: [lead(PLACE_A, "Probe Shop A (again)")] as never,
    });

    expect(error).toBeNull();
    const row = Array.isArray(data) ? data[0] : null;
    expect(row?.received).toBe(1);
    expect(row?.inserted).toBe(0);

    const { count } = await db
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("search_id", searchId)
      .eq("place_id", PLACE_A);

    expect(count).toBe(1);
  });

  it("collapses duplicates inside a single batch", async () => {
    const { data } = await db.rpc("insert_leads_dedup", {
      p_search: searchId,
      p_tile: tileId,
      p_leads: [
        lead("ChIJ_phase3a_batch_dupe", "Batch Dupe"),
        lead("ChIJ_phase3a_batch_dupe", "Batch Dupe"),
      ] as never,
    });

    const row = Array.isArray(data) ? data[0] : null;
    expect(row?.received).toBe(2);
    expect(row?.inserted).toBe(1);

    await db.from("leads").delete().eq("search_id", searchId).eq("place_id", "ChIJ_phase3a_batch_dupe");
    await db.from("places_seen").delete().eq("user_id", userId).eq("place_id", "ChIJ_phase3a_batch_dupe");
  });

  it("stores leads with no email, as the CHECK constraint requires", async () => {
    const { data } = await db
      .from("leads")
      .select("email, email_status, name, phone_national, website")
      .eq("search_id", searchId)
      .eq("place_id", PLACE_A)
      .single();

    expect(data?.email).toBeNull();
    expect(data?.email_status).toBe("not_enriched");
    expect(data?.name).toBe("Probe Shop A");
  });

  it("refuses a lead row that claims an email while unenriched", async () => {
    const { error } = await db
      .from("leads")
      .update({ email: "someone@example.test" })
      .eq("search_id", searchId)
      .eq("place_id", PLACE_A);

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/leads_email_null_until_enriched/i);
  });

  it("recomputes the search counters from the tables, not from the runner", async () => {
    const { error } = await db.rpc("recompute_search_progress", { p_search: searchId });
    expect(error).toBeNull();

    const { data } = await db
      .from("searches")
      .select("leads_found, tiles_total, tiles_covered, coverage_pct, area_total_km2")
      .eq("id", searchId)
      .single();

    // Two probe leads survive at this point.
    expect(data?.leads_found).toBe(2);
    expect(data?.tiles_total).toBe(1);
    expect(data?.tiles_covered).toBe(1);
    expect(data?.coverage_pct).toBe(100);
    expect(data?.area_total_km2).toBeGreaterThan(0);
  });

  it("passes the coverage invariant for a single-tile grid", async () => {
    const { data, error } = await db.rpc("verify_search_coverage", { p_search: searchId });
    expect(error).toBeNull();

    const report = data as Record<string, unknown>;
    expect(report.ok).toBe(true);
    expect(report.in_progress).toBe(0);
    expect(report.area_matches).toBe(true);
    expect(report.disjoint).toBe(true);
  });

  it("survives a reload, because every figure lives in Postgres", async () => {
    // The same query a fresh page render makes. Nothing important is in React.
    const { data } = await db
      .from("searches")
      .select("status, leads_found, api_calls_run, tiles_total")
      .eq("id", searchId)
      .single();

    expect(data?.leads_found).toBe(2);
    expect(data?.tiles_total).toBe(1);
  });
});
