import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildCoverageReport, type CoverageTile } from "@/lib/coverage-report";
import type { TileState } from "@/lib/tile-states";
import type { EnrichmentRunResult } from "@/server/enrichment/run-enrichment";
import type { ControlledTickResult } from "@/server/search/run-controlled-tick";
import { SEARCH_LIMITS } from "@/server/search/limits";

import { GENERATION_LIMITS } from "./limits";

/**
 * The guided flow against the REAL database. OPT-IN:
 *
 *     LEAD_SCRAPPER_DB_TESTS=1 npx vitest run src/server/generate/orchestrator.db.test.ts
 *
 * ---------------------------------------------------------------------------
 * ZERO GOOGLE CALLS. ZERO EXTERNAL REQUESTS.
 *
 * `runControlledTick` and `runEnrichment` are INJECTED. The fakes move tiles
 * through the real state machine, insert real lead rows and advance
 * `searches.api_calls_run` exactly as a real tick would -- but they reach
 * nothing. In particular the tick fake never calls `record_api_call`, so
 * `api_usage_counters` is not touched and the month's real allowance is
 * unaffected; the suite asserts that at the end.
 *
 * What is real: the schema, the tile state machine, the coverage computation,
 * the quota snapshot, the phase machine, and every one of the orchestrator's
 * own budget decisions. Those are the things a mock could only prove agreed
 * with itself.
 *
 * Every fixture is created by the suite and deleted afterwards. The real
 * historical searches and leads are never selected, never modified, and are
 * asserted untouched at the end.
 * ---------------------------------------------------------------------------
 */

const ENABLED = process.env.LEAD_SCRAPPER_DB_TESTS === "1";

type Db = ReturnType<typeof import("@/server/db/admin").getSupabaseAdminClient>;

/** A tiny rectangle: at an 8 km seed edge it floors to the 4-tile minimum. */
const SMALL_BOX = { minLat: 29.7, minLng: -95.4, maxLat: 29.72, maxLng: -95.38 };
/** Big enough to tile into far more areas than one approval can pay for. */
const LARGE_BOX = { minLat: 29.5, minLng: -95.6, maxLat: 29.8, maxLng: -95.3 };

describe.skipIf(!ENABLED)("guided generation orchestration", () => {
  let db: Db;
  let userId: string;
  let orchestrator: typeof import("./orchestrator");
  let stateModule: typeof import("./state");

  const createdSearchIds: string[] = [];

  let searchesBefore: unknown;
  let leadsBefore: unknown;
  let countersBefore: unknown;

  beforeAll(async () => {
    const { getSupabaseAdminClient } = await import("@/server/db/admin");
    db = getSupabaseAdminClient();
    orchestrator = await import("./orchestrator");
    stateModule = await import("./state");

    const { data: anySearch } = await db.from("searches").select("user_id").limit(1).single();
    userId = anySearch!.user_id;

    const { data: searches } = await db
      .from("searches")
      .select("id, status, leads_found, api_calls_run, coverage_pct, stop_reason")
      .order("id");
    searchesBefore = searches;

    const { data: leads } = await db.from("leads").select("id, email_status").order("id");
    leadsBefore = leads;

    const { data: counters } = await db.from("api_usage_counters").select("*").order("sku");
    countersBefore = counters;
  });

  afterAll(async () => {
    // SWEPT BY MARKER, not only by the ids this run collected.
    //
    // `createGenerationRun` can throw AFTER `createSearch` has already written
    // its row -- a failed tile insert deliberately leaves the search behind so
    // the incomplete grid is visible rather than silently discarded. When that
    // happened, the id was never pushed onto `createdSearchIds` and the fixture
    // survived the suite. It really did: two "Guided Fixture" searches were
    // found in the shared project afterwards.
    //
    // So cleanup keys off the fixture marker instead. `city = 'Fixtureville'`
    // and a `Guided Fixture` niche cannot match anything real, which makes this
    // safe to run unconditionally and makes a partial failure self-healing.
    // AND RETRIED, because a single pass is not enough against a shared hosted
    // database. Under load this project starts returning `{ data: null }`
    // without an error, and a cleanup written as one straight-line pass reads
    // that as "nothing to delete" and exits satisfied. It happened: a throttled
    // run left twelve fixture searches and 110 fixture leads behind.
    //
    // Everything here is therefore retried until it genuinely succeeds, and the
    // sweep is keyed off the fixture marker rather than the collected ids so a
    // partially-failed run still cleans up after itself.
    const strays = await withRetry("list fixtures", () =>
      db
        .from("searches")
        .select("id")
        .eq("user_id", userId)
        .eq("city", "Fixtureville")
        .like("niche", "Guided Fixture%"),
    );

    const ids = new Set([...createdSearchIds, ...(strays ?? []).map((row) => row.id)]);

    // Order matters: leads hang off the search, and generation runs cascade
    // with it.
    for (const searchId of ids) {
      await withRetry("leads", () =>
        db.from("leads").delete().eq("search_id", searchId).select("id"),
      );
      await withRetry("runs", () =>
        db.from("generation_runs").delete().eq("search_id", searchId).select("id"),
      );
      await withRetry("search", () => db.from("searches").delete().eq("id", searchId).select("id"));
    }
  });

  /**
   * Runs a query until it actually answers.
   *
   * A transient `{ data: null, error: null }` from an overloaded project is
   * indistinguishable from an empty result at the call site, and treating it as
   * empty is what leaks fixtures into a shared database. Six attempts with
   * increasing backoff is ample for a hiccup and still bounded.
   */
  async function withRetry<T>(
    label: string,
    run: () => PromiseLike<{ data: T | null; error: { message: string } | null }>,
    attempts = 6,
  ): Promise<T | null> {
    let lastError = "";
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const { data, error } = await run();
      if (!error && data !== null) return data;
      lastError = error?.message ?? "null data with no error";
      await new Promise((resolve) => setTimeout(resolve, attempt * 750));
    }
    // Loud rather than silent: a fixture left in a shared project is worse than
    // a failing hook, because the next run inherits it.
    throw new Error(`Fixture cleanup could not complete (${label}): ${lastError}`);
  }

  // -------------------------------------------------------------------------
  // Fakes
  // -------------------------------------------------------------------------

  /**
   * Stands in for one real tick.
   *
   * Honours `maxTilesPerTick` -- which is the whole point, since that is the
   * only lever the orchestrator uses to keep a slice inside the approval.
   * Records what it was asked for so the tests can assert on it.
   */
  function makeTickFake(options: { callsPerArea?: number; asked: number[] }) {
    const callsPerArea = options.callsPerArea ?? 1;

    return async function fakeTick(
      args: { searchId: string; userId: string },
      tickOptions: { maxTilesPerTick?: number } = {},
    ): Promise<ControlledTickResult> {
      const maxTiles = tickOptions.maxTilesPerTick ?? 12;
      options.asked.push(maxTiles);

      const { data: pending } = await db
        .from("search_tiles")
        .select("id, label")
        .eq("search_id", args.searchId)
        .eq("state", "pending")
        .order("path")
        .limit(maxTiles);

      let apiCalls = 0;
      let leadsInserted = 0;

      for (const tile of pending ?? []) {
        const startedAt = new Date().toISOString();
        // Through the real, trigger-enforced state machine.
        await db
          .from("search_tiles")
          .update({ state: "in_progress", started_at: startedAt })
          .eq("id", tile.id);
        await db
          .from("search_tiles")
          .update({
            state: "covered",
            completed_at: new Date(Date.parse(startedAt) + 3_000).toISOString(),
            api_calls: callsPerArea,
            pages_fetched: 1,
            results_count: 2,
            unique_new_count: 2,
            last_reason: "fake tick (no Google request was made)",
          })
          .eq("id", tile.id);

        apiCalls += callsPerArea;

        // Two leads per area, both with a website so the email phase has work.
        const rows = [0, 1].map((n) => ({
          user_id: args.userId,
          search_id: args.searchId,
          tile_id: tile.id,
          place_id: `fake-place-${tile.id}-${n}`,
          name: `Fake Business ${tile.label} #${n}`,
          website: `https://example.invalid/${tile.id}-${n}`,
          query_tile: tile.label,
          raw: {},
        }));
        const { error } = await db.from("leads").insert(rows);
        if (!error) leadsInserted += rows.length;
      }

      // Billed against the SEARCH only. `api_usage_counters` is deliberately
      // untouched: no Google request was made, so nothing may be recorded
      // against the month's real allowance.
      const { data: current } = await db
        .from("searches")
        .select("api_calls_run, leads_found, target_leads, status")
        .eq("id", args.searchId)
        .single();

      await db
        .from("searches")
        .update({ api_calls_run: (current?.api_calls_run ?? 0) + apiCalls })
        .eq("id", args.searchId);

      await db.rpc("recompute_search_progress", { p_search: args.searchId });

      const { data: tiles } = await db
        .from("search_tiles")
        .select("label, state, area_km2, depth")
        .eq("search_id", args.searchId)
        .order("path");

      const { data: after } = await db
        .from("searches")
        .select("api_calls_run, leads_found, target_leads, status, tiles_pending")
        .eq("id", args.searchId)
        .single();

      const coverage = buildCoverageReport({
        tiles: (tiles ?? []).map((tile): CoverageTile => ({
          label: tile.label,
          state: tile.state as TileState,
          area_km2: tile.area_km2 ?? 0,
          depth: tile.depth,
        })),
        target: after?.target_leads ?? 0,
        leadsFound: after?.leads_found ?? 0,
      });

      const stopReason =
        coverage.tilesRemaining === 0 ? "coverage_complete" : "tile_budget_reached";

      return {
        outcome: stopReason === "coverage_complete" ? "completed" : "paused-tile-limit",
        searchId: args.searchId,
        searchStatus: after?.status ?? "running",
        stopReason,
        tiles: [],
        apiCalls,
        apiCallsTotal: after?.api_calls_run ?? 0,
        callBudget: 150,
        resultsReceived: leadsInserted,
        leadsInserted,
        duplicatesRejected: 0,
        placesRejected: 0,
        leadsFound: after?.leads_found ?? 0,
        targetLeads: after?.target_leads ?? 0,
        targetReached: (after?.leads_found ?? 0) >= (after?.target_leads ?? 0),
        preflight: null as never,
        coverage,
        error: null,
      };
    } as unknown as typeof import("@/server/search/run-controlled-tick").runControlledTick;
  }

  /** Stands in for one real enrichment batch. Reaches nothing. */
  function makeEnrichmentFake(counters: { calls: number }, batchSizes?: number[]) {
    return async function fakeEnrichment(args: {
      userId: string;
      searchId?: string;
      limit?: number;
    }): Promise<EnrichmentRunResult> {
      counters.calls += 1;

      const limit = args.limit ?? GENERATION_LIMITS.enrichmentLeadsPerAdvance;

      const { data: candidates } = await db
        .from("leads")
        .select("id")
        .eq("search_id", args.searchId!)
        .eq("user_id", args.userId)
        .eq("email_status", "not_enriched")
        .not("website", "is", null)
        .neq("website", "")
        .order("created_at")
        .limit(limit);

      // Recorded so a test can prove the loop really ran in several bounded
      // rounds rather than one unbounded pass.
      batchSizes?.push((candidates ?? []).length);

      let found = 0;
      for (const [index, lead] of (candidates ?? []).entries()) {
        // Alternating outcomes, so the results page has a realistic mixture.
        const isFound = index % 2 === 0;
        if (isFound) found += 1;

        await db
          .from("leads")
          .update({
            email_status: isFound ? "found" : "not_found",
            email: isFound ? `hello+${lead.id}@example.invalid` : null,
            email_confidence: isFound ? 0.8 : null,
            email_source: "website",
            email_checked_at: new Date().toISOString(),
          })
          .eq("id", lead.id);

        await db.from("lead_enrichment_attempts").insert({
          user_id: args.userId,
          lead_id: lead.id,
          provider: "website",
          status: isFound ? "found" : "not_found",
          email: isFound ? `hello+${lead.id}@example.invalid` : null,
          duration_ms: 4_000,
          cost_units: 0,
          raw: {},
        });
      }

      const { count: remaining } = await db
        .from("leads")
        .select("id", { count: "exact", head: true })
        .eq("search_id", args.searchId!)
        .eq("email_status", "not_enriched")
        .not("website", "is", null)
        .neq("website", "");

      const processed = candidates?.length ?? 0;

      return {
        dryRun: false,
        mode: "new",
        selected: processed,
        processed,
        found,
        notFound: processed - found,
        failed: 0,
        remaining: remaining ?? 0,
        scope: null as never,
        results: [],
      };
    } as unknown as typeof import("@/server/enrichment/run-enrichment").runEnrichment;
  }

  async function createRun(args: {
    enrichEmails: boolean;
    testBbox?: typeof SMALL_BOX;
    targetLeads?: number;
  }) {
    const created = await orchestrator.createGenerationRun(
      {
        niche: `Guided Fixture ${Date.now()}`,
        country: "Testland",
        state: null,
        city: "Fixtureville",
        targetLeads: args.targetLeads ?? 40,
        gridConfig: (await import("@/lib/constants")).DEFAULT_GRID_CONFIG,
        testBbox: args.testBbox ?? SMALL_BOX,
        enrichEmails: args.enrichEmails,
      } as never,
      { userId },
    );

    createdSearchIds.push(created.searchId);
    return created;
  }

  // -------------------------------------------------------------------------
  // Creating an approval
  // -------------------------------------------------------------------------

  it("records the approval and the consent, and spends nothing doing it", async () => {
    const created = await createRun({ enrichEmails: true });

    const { data: run } = await db
      .from("generation_runs")
      .select("*")
      .eq("id", created.runId)
      .single();

    expect(run!.status).toBe("running");
    expect(run!.phase).toBe("searching");
    expect(run!.call_ceiling).toBe(GENERATION_LIMITS.maxGoogleCallsPerRun);
    expect(run!.api_calls_at_start).toBe(0);
    // A TIMESTAMP, not a boolean: the row says when consent was given.
    expect(run!.enrichment_consented_at).not.toBeNull();

    // Planning is free. Nothing has been requested from Google.
    const { data: search } = await db
      .from("searches")
      .select("api_calls_run, status")
      .eq("id", created.searchId)
      .single();
    expect(search!.api_calls_run).toBe(0);
    expect(search!.status).toBe("draft");
  });

  it("records the absence of consent just as explicitly", async () => {
    const created = await createRun({ enrichEmails: false });

    const { data: run } = await db
      .from("generation_runs")
      .select("enrichment_consented_at")
      .eq("id", created.runId)
      .single();

    expect(run!.enrichment_consented_at).toBeNull();
  });

  it("refuses a second live approval for the same search", async () => {
    const created = await createRun({ enrichEmails: true });

    await expect(
      orchestrator.continueGenerationRun({
        searchId: created.searchId,
        userId,
        enrichEmails: true,
      }),
    ).rejects.toThrow(/already has a generation in progress/i);
  });

  // -------------------------------------------------------------------------
  // Advancing
  // -------------------------------------------------------------------------

  it("asks for only as many areas as the approval can pay for at their worst case", async () => {
    const created = await createRun({ enrichEmails: true });
    const asked: number[] = [];

    await orchestrator.advanceGenerationRun(
      { runId: created.runId, userId },
      { runTick: makeTickFake({ asked }), runEnrichment: makeEnrichmentFake({ calls: 0 }) },
    );

    // floor(150 / 9) = 16, clamped to the tick runner's own cap of 12. Under the
    // 30-call gate this was 3, which is what made a real city take several
    // presses to finish. The clamp is what still keeps a slice bounded.
    expect(asked[0]).toBe(12);
    expect(asked[0]).toBeLessThanOrEqual(SEARCH_LIMITS.maxTilesPerTick);
  });

  it("walks searching -> finding emails -> ready and completes", async () => {
    const created = await createRun({ enrichEmails: true });
    const asked: number[] = [];
    const enrichmentCounter = { calls: 0 };

    const deps = {
      runTick: makeTickFake({ asked }),
      runEnrichment: makeEnrichmentFake(enrichmentCounter),
    };

    const phases: string[] = [];
    let state = await stateModule.loadGenerationState({ runId: created.runId, userId });

    // The phase BEFORE each advance as well as after it. A slice may now cover
    // a small grid in one go, so `searching` can be true only on the way in --
    // recording just the outcomes would miss it and, worse, would look like the
    // search phase had been skipped.
    phases.push(state.phase);

    for (let i = 0; i < 30 && state.status === "running" && state.canAdvance; i += 1) {
      state = await orchestrator.advanceGenerationRun({ runId: created.runId, userId }, deps);
      phases.push(state.phase);
    }

    expect(phases).toContain("searching");
    expect(phases).toContain("enriching");
    expect(state.phase).toBe("ready");
    expect(state.status).toBe("completed");
    expect(state.stopReason).toBe("generation_complete");

    // Coverage is the completion criterion, and it was actually met.
    expect(state.search.fullyCovered).toBe(true);
    expect(state.search.areasRemaining).toBe(0);

    // Email discovery really ran, and found something.
    expect(enrichmentCounter.calls).toBeGreaterThan(0);
    expect(state.enrichment.remaining).toBe(0);
    expect(state.enrichment.found).toBeGreaterThan(0);

    // Phase boundaries were persisted, which is what makes elapsed survive.
    const { data: run } = await db
      .from("generation_runs")
      .select("search_started_at, search_completed_at, enrichment_started_at, completed_at")
      .eq("id", created.runId)
      .single();

    expect(run!.search_started_at).not.toBeNull();
    expect(run!.search_completed_at).not.toBeNull();
    expect(run!.enrichment_started_at).not.toBeNull();
    expect(run!.completed_at).not.toBeNull();
  });

  /**
   * THE CEILING.
   *
   * Every area costs its worst case here, so the approval binds long before the
   * geography is covered. The run must stop having spent AT MOST what the user
   * approved -- not approximately, and never one call more.
   */
  /**
   * THE HARD LIMIT, WITHOUT A GATE IN FRONT OF IT.
   *
   * Every area here costs its worst case, so the per-search spending limit binds
   * long before the geography is covered. The run must stop having spent AT MOST
   * what the limit allows -- not approximately, and never one call more -- and
   * it must say "paused for safety" rather than inviting the user to continue.
   */
  it("never exceeds the hard call limit, even when every area costs its worst case", async () => {
    const created = await createRun({ enrichEmails: true, testBbox: LARGE_BOX });
    const asked: number[] = [];

    const deps = {
      runTick: makeTickFake({ asked, callsPerArea: GENERATION_LIMITS.worstCaseCallsPerArea }),
      runEnrichment: makeEnrichmentFake({ calls: 0 }),
    };

    let state = await stateModule.loadGenerationState({ runId: created.runId, userId });

    for (let i = 0; i < 40 && state.status === "running" && state.canAdvance; i += 1) {
      state = await orchestrator.advanceGenerationRun({ runId: created.runId, userId }, deps);
      // Checked after EVERY advance, not only at the end.
      expect(state.budget.used).toBeLessThanOrEqual(GENERATION_LIMITS.maxGoogleCallsPerRun);
      expect(state.budget.used).toBeLessThanOrEqual(SEARCH_LIMITS.maxCallsPerSearch);
    }

    expect(state.status).toBe("stopped");
    expect(state.stopReason).toBe("safety_limit_reached");
    expect(state.budget.used).toBeLessThanOrEqual(SEARCH_LIMITS.maxCallsPerSearch);

    // Honest wording, and the figures the user needs to understand it.
    expect(state.displayState).toBe("paused-for-safety");
    expect(state.title).toBe("Generation paused for safety");
    expect(state.lifecycleComplete).toBe(false);

    // It stopped with area still owed, and says so rather than claiming to be
    // finished.
    expect(state.search.fullyCovered).toBe(false);
    expect(state.search.areasRemaining).toBeGreaterThan(0);

    // A further advance is refused: the limit is the limit.
    const usedAtStop = state.budget.used;
    const after = await orchestrator.advanceGenerationRun({ runId: created.runId, userId }, deps);
    expect(after.budget.used).toBe(usedAtStop);
    expect(after.status).toBe("stopped");
  });

  /**
   * NO MANUAL CONTINUE IN THE NORMAL FLOW.
   *
   * The point of the redesign: one approval, and the orchestrator walks the
   * whole lifecycle by itself. Nothing here creates a second approval, and the
   * run still reaches a finished state.
   */
  it("drives the whole lifecycle from a single approval", async () => {
    const created = await createRun({ enrichEmails: true });
    const asked: number[] = [];
    const enrichmentCounter = { calls: 0 };
    const deps = {
      runTick: makeTickFake({ asked }),
      runEnrichment: makeEnrichmentFake(enrichmentCounter),
    };

    let state = await stateModule.loadGenerationState({ runId: created.runId, userId });
    let advances = 0;

    while (state.status === "running" && state.canAdvance && advances < 40) {
      state = await orchestrator.advanceGenerationRun({ runId: created.runId, userId }, deps);
      advances += 1;
    }

    expect(state.lifecycleComplete).toBe(true);
    expect(state.title).toBe("Your leads are ready");

    // Exactly ONE approval existed for the whole job.
    const { count } = await db
      .from("generation_runs")
      .select("id", { count: "exact", head: true })
      .eq("search_id", created.searchId);
    expect(count).toBe(1);

    // It really did both halves of the work by itself.
    expect(asked.length).toBeGreaterThan(0);
    expect(enrichmentCounter.calls).toBeGreaterThan(0);
  });

  /**
   * THE LIVENESS GUARD.
   *
   * A self-advancing run must not ask forever. A tick that completes no area
   * and spends nothing is repeated only so many times before the run halts.
   */
  it("halts a run that stops making progress instead of asking forever", async () => {
    const created = await createRun({ enrichEmails: false, testBbox: LARGE_BOX });

    // A tick that does nothing at all: no tiles, no calls, nothing inserted.
    const inertTick = (async () => ({
      outcome: "paused-tile-limit",
      searchId: created.searchId,
      searchStatus: "running",
      stopReason: "tile_budget_reached",
      tiles: [],
      apiCalls: 0,
      apiCallsTotal: 0,
      callBudget: 150,
      resultsReceived: 0,
      leadsInserted: 0,
      duplicatesRejected: 0,
      placesRejected: 0,
      leadsFound: 0,
      targetLeads: 40,
      targetReached: false,
      preflight: null as never,
      coverage: { tilesRemaining: 99 } as never,
      error: null,
    })) as unknown as typeof import("@/server/search/run-controlled-tick").runControlledTick;

    const deps = { runTick: inertTick, runEnrichment: makeEnrichmentFake({ calls: 0 }) };

    let state = await stateModule.loadGenerationState({ runId: created.runId, userId });
    let advances = 0;

    while (state.status === "running" && state.canAdvance && advances < 50) {
      state = await orchestrator.advanceGenerationRun({ runId: created.runId, userId }, deps);
      advances += 1;
    }

    expect(state.status).toBe("stopped");
    expect(state.stopReason).toBe("no_progress");
    // It gave up promptly rather than grinding.
    expect(advances).toBeLessThanOrEqual(GENERATION_LIMITS.maxNoProgressAdvances + 1);
    // And it spent nothing doing so.
    expect(state.budget.used).toBe(0);
  });

  /**
   * NAVIGATING AWAY MUST NOT LOSE THE GENERATION.
   *
   * The dashboard finds the open run with exactly this query. Nothing about the
   * run lives in the browser, so the card can be rebuilt on any device.
   */
  it("leaves an active generation discoverable for the dashboard", async () => {
    const created = await createRun({ enrichEmails: true });

    const { data: active } = await db
      .from("generation_runs")
      .select("id, search_id, phase, created_at, searches!inner(niche, label)")
      .eq("status", "running")
      .eq("search_id", created.searchId)
      .maybeSingle();

    expect(active).not.toBeNull();
    expect(active!.id).toBe(created.runId);
    // The card needs the niche and location, and gets them from the search.
    expect((active as unknown as { searches: { niche: string } }).searches.niche).toContain(
      "Guided Fixture",
    );

    // And the full state rebuilds from persisted data alone.
    const rebuilt = await stateModule.loadGenerationState({ runId: created.runId, userId });
    expect(rebuilt.runId).toBe(created.runId);
    expect(rebuilt.status).toBe("running");
  });

  /**
   * DO NOT REPEATEDLY HAMMER FAILED WEBSITES.
   *
   * The automatic flow runs `new` mode only, so a site that already refused us
   * is never retried as a side effect of the lifecycle continuing. Retrying is
   * an explicit press, and is still capped at MAX_ATTEMPTS_PER_LEAD underneath.
   */
  it("never re-attempts a lead whose website already failed", async () => {
    const created = await createRun({ enrichEmails: true });
    const seenLeadIds: string[][] = [];

    const recordingEnrichment = (async (args: {
      userId: string;
      searchId?: string;
      limit?: number;
    }) => {
      const { data: candidates } = await db
        .from("leads")
        .select("id")
        .eq("search_id", args.searchId!)
        .eq("email_status", "not_enriched")
        .not("website", "is", null)
        .neq("website", "")
        .order("created_at")
        .limit(args.limit ?? 5);

      const ids = (candidates ?? []).map((lead) => lead.id);
      seenLeadIds.push(ids);

      // Every one of them fails, the way a bot-blocking host would.
      for (const id of ids) {
        await db
          .from("leads")
          .update({ email_status: "failed", email_checked_at: new Date().toISOString() })
          .eq("id", id);
        await db.from("lead_enrichment_attempts").insert({
          user_id: args.userId,
          lead_id: id,
          provider: "website",
          status: "failed",
          duration_ms: 3_600,
          cost_units: 0,
          raw: {},
        });
      }

      const { count: remaining } = await db
        .from("leads")
        .select("id", { count: "exact", head: true })
        .eq("search_id", args.searchId!)
        .eq("email_status", "not_enriched")
        .not("website", "is", null)
        .neq("website", "");

      return {
        dryRun: false,
        mode: "new",
        selected: ids.length,
        processed: ids.length,
        found: 0,
        notFound: 0,
        failed: ids.length,
        remaining: remaining ?? 0,
        scope: null as never,
        results: [],
      };
    }) as unknown as typeof import("@/server/enrichment/run-enrichment").runEnrichment;

    const deps = {
      runTick: makeTickFake({ asked: [] }),
      runEnrichment: recordingEnrichment,
    };

    let state = await stateModule.loadGenerationState({ runId: created.runId, userId });
    for (let i = 0; i < 40 && state.status === "running" && state.canAdvance; i += 1) {
      state = await orchestrator.advanceGenerationRun({ runId: created.runId, userId }, deps);
    }

    // The lifecycle finished rather than looping over the failures.
    expect(state.status).toBe("completed");
    expect(state.enrichment.failed).toBeGreaterThan(0);

    // NO LEAD WAS OFFERED TWICE. This is the property that keeps the automatic
    // flow from becoming a retry loop against someone else's web server.
    const all = seenLeadIds.flat();
    expect(new Set(all).size).toBe(all.length);

    // And exactly one attempt was recorded per lead.
    const { data: leadIds } = await db.from("leads").select("id").eq("search_id", created.searchId);
    const { data: attempts } = await db
      .from("lead_enrichment_attempts")
      .select("lead_id")
      .in(
        "lead_id",
        (leadIds ?? []).map((lead) => lead.id),
      );

    const perLead = new Map<string, number>();
    for (const attempt of attempts ?? []) {
      perLead.set(attempt.lead_id, (perLead.get(attempt.lead_id) ?? 0) + 1);
    }
    for (const count of perLead.values()) expect(count).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Lease contention — the production failure of 2026-08-23
  // -------------------------------------------------------------------------

  /**
   * THE REGRESSION TEST FOR generation 2d3aacec.
   *
   * Two advances overlapped, the second lost the race for the lease, and the
   * run was recorded `failed` while the first was still working -- it went on
   * to collect 357 leads the UI had already declared unreachable.
   *
   * Losing a race must leave the generation exactly as it was.
   */
  it("treats losing the race for the lease as transient, not as a failure", async () => {
    const created = await createRun({ enrichEmails: true, testBbox: LARGE_BOX });

    // Do one real slice first, so there is progress worth preserving.
    await orchestrator.advanceGenerationRun(
      { runId: created.runId, userId },
      { runTick: makeTickFake({ asked: [] }), runEnrichment: makeEnrichmentFake({ calls: 0 }) },
    );
    const before = await stateModule.loadGenerationState({ runId: created.runId, userId });
    expect(before.search.leadsFound).toBeGreaterThan(0);

    // Someone else is mid-slice: the search is running and holds a live lease.
    await db
      .from("searches")
      .update({
        status: "running",
        locked_by: "11111111-1111-1111-1111-111111111111",
        locked_at: new Date().toISOString(),
        heartbeat_at: new Date().toISOString(),
      })
      .eq("id", created.searchId);

    // The REAL claim path, not a fake -- this is what threw the plain Error.
    const contended = await orchestrator.advanceGenerationRun(
      { runId: created.runId, userId },
      { runEnrichment: makeEnrichmentFake({ calls: 0 }) },
    );

    expect(contended.status).toBe("running");
    expect(contended.stopReason).toBeNull();
    expect(contended.canAdvance).toBe(true);
    // Nothing collected was lost or disowned.
    expect(contended.search.leadsFound).toBe(before.search.leadsFound);

    // AND IT MUST NOT BURN THE LIVENESS BUDGET. A 50-second slice would
    // otherwise let a remounted client halt a healthy run in a couple of
    // seconds.
    const { data: row } = await db
      .from("generation_runs")
      .select("no_progress_ticks, status")
      .eq("id", created.runId)
      .single();
    expect(row!.no_progress_ticks).toBe(0);
    expect(row!.status).toBe("running");

    // Repeated contention still never fails the run.
    for (let i = 0; i < GENERATION_LIMITS.maxNoProgressAdvances + 2; i += 1) {
      await orchestrator.advanceGenerationRun(
        { runId: created.runId, userId },
        { runEnrichment: makeEnrichmentFake({ calls: 0 }) },
      );
    }
    const after = await stateModule.loadGenerationState({ runId: created.runId, userId });
    expect(after.status).toBe("running");
    expect(after.stopReason).toBeNull();

    // Release the lease so cleanup and later cases are unaffected.
    await db
      .from("searches")
      .update({ status: "paused", locked_by: null, locked_at: null })
      .eq("id", created.searchId);
  });

  it("resumes normally once the lease is free again", async () => {
    const created = await createRun({ enrichEmails: false, testBbox: LARGE_BOX });

    await db
      .from("searches")
      .update({
        status: "running",
        locked_by: "22222222-2222-2222-2222-222222222222",
        locked_at: new Date().toISOString(),
        heartbeat_at: new Date().toISOString(),
      })
      .eq("id", created.searchId);

    const blocked = await orchestrator.advanceGenerationRun(
      { runId: created.runId, userId },
      { runEnrichment: makeEnrichmentFake({ calls: 0 }) },
    );
    expect(blocked.status).toBe("running");

    // The other runner finishes and lets go.
    await db
      .from("searches")
      .update({ status: "paused", locked_by: null, locked_at: null })
      .eq("id", created.searchId);

    const resumed = await orchestrator.advanceGenerationRun(
      { runId: created.runId, userId },
      { runTick: makeTickFake({ asked: [] }), runEnrichment: makeEnrichmentFake({ calls: 0 }) },
    );

    // Straight back to work, with no intervention and no new approval.
    expect(resumed.status).toBe("running");
    expect(resumed.search.leadsFound).toBeGreaterThan(0);
  });

  /**
   * The OTHER reason the claim returns no row: the search cannot be driven at
   * all. That is genuinely terminal and must not become an infinite retry.
   */
  it("stops honestly when the search is no longer runnable", async () => {
    const created = await createRun({ enrichEmails: false, testBbox: LARGE_BOX });

    await db.from("searches").update({ status: "canceled" }).eq("id", created.searchId);

    const state = await orchestrator.advanceGenerationRun(
      { runId: created.runId, userId },
      { runEnrichment: makeEnrichmentFake({ calls: 0 }) },
    );

    expect(state.status).toBe("stopped");
    expect(state.stopReason).toBe("search_unavailable");
    expect(state.canAdvance).toBe(false);
    // Not dressed up as a crash.
    expect(state.title).toBe("Generation stopped");
  });

  it("resets the liveness counter when real progress happens", async () => {
    const created = await createRun({ enrichEmails: false });
    const deps = {
      runTick: makeTickFake({ asked: [] }),
      runEnrichment: makeEnrichmentFake({ calls: 0 }),
    };

    await orchestrator.advanceGenerationRun({ runId: created.runId, userId }, deps);

    const { data: run } = await db
      .from("generation_runs")
      .select("no_progress_ticks")
      .eq("id", created.runId)
      .single();

    // A productive slice leaves the counter at zero, so a slow run is never
    // mistaken for a stuck one.
    expect(run!.no_progress_ticks).toBe(0);
  });

  it("counts a continuation's ceiling from a fresh watermark", async () => {
    const created = await createRun({ enrichEmails: false, testBbox: LARGE_BOX });
    const deps = {
      runTick: makeTickFake({ asked: [], callsPerArea: GENERATION_LIMITS.worstCaseCallsPerArea }),
      runEnrichment: makeEnrichmentFake({ calls: 0 }),
    };

    let state = await stateModule.loadGenerationState({ runId: created.runId, userId });
    for (let i = 0; i < 20 && state.status === "running" && state.canAdvance; i += 1) {
      state = await orchestrator.advanceGenerationRun({ runId: created.runId, userId }, deps);
    }

    const spentByFirst = state.budget.searchCallsUsed;
    expect(spentByFirst).toBeGreaterThan(0);

    const next = await orchestrator.continueGenerationRun({
      searchId: created.searchId,
      userId,
      enrichEmails: false,
    });

    const fresh = await stateModule.loadGenerationState({ runId: next.runId, userId });

    // The previous approval's spending belongs to it, not to this one.
    expect(fresh.budget.used).toBe(0);
    expect(fresh.budget.remaining).toBe(GENERATION_LIMITS.maxGoogleCallsPerRun);
    expect(fresh.budget.searchCallsUsed).toBe(spentByFirst);
  });

  // -------------------------------------------------------------------------
  // Consent
  // -------------------------------------------------------------------------

  /**
   * THE CONSENT GATE.
   *
   * Without a recorded consent the orchestrator must not call the enrichment
   * service AT ALL -- not with a narrowed scope, not in dry-run. The counter
   * proves it was never reached.
   */
  it("never starts email discovery that was not consented to", async () => {
    const created = await createRun({ enrichEmails: false });
    const enrichmentCounter = { calls: 0 };

    const deps = {
      runTick: makeTickFake({ asked: [] }),
      runEnrichment: makeEnrichmentFake(enrichmentCounter),
    };

    let state = await stateModule.loadGenerationState({ runId: created.runId, userId });
    for (let i = 0; i < 20 && state.status === "running" && state.canAdvance; i += 1) {
      state = await orchestrator.advanceGenerationRun({ runId: created.runId, userId }, deps);
    }

    expect(enrichmentCounter.calls).toBe(0);
    expect(state.stopReason).toBe("enrichment_not_consented");
    expect(state.phase).toBe("ready");
    expect(state.enrichment.consented).toBe(false);
    // The leads are still there and still offer the option.
    expect(state.enrichment.remaining).toBeGreaterThan(0);

    const { data: attempts } = await db
      .from("lead_enrichment_attempts")
      .select("id")
      .in(
        "lead_id",
        (await db.from("leads").select("id").eq("search_id", created.searchId)).data!.map(
          (lead) => lead.id,
        ),
      );
    expect(attempts ?? []).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Stopping, resuming, reconstructing
  // -------------------------------------------------------------------------

  it("stops on request and keeps everything already collected", async () => {
    const created = await createRun({ enrichEmails: true, testBbox: LARGE_BOX });
    const deps = {
      runTick: makeTickFake({ asked: [] }),
      runEnrichment: makeEnrichmentFake({ calls: 0 }),
    };

    await orchestrator.advanceGenerationRun({ runId: created.runId, userId }, deps);
    const beforeStop = await stateModule.loadGenerationState({ runId: created.runId, userId });
    expect(beforeStop.search.leadsFound).toBeGreaterThan(0);

    const stopped = await orchestrator.stopGenerationRun({ runId: created.runId, userId });
    expect(stopped.status).toBe("stopped");
    expect(stopped.stopReason).toBe("stopped_by_user");
    expect(stopped.canAdvance).toBe(false);

    // Nothing was rolled back.
    expect(stopped.search.leadsFound).toBe(beforeStop.search.leadsFound);

    // And a further advance does nothing at all.
    const asked: number[] = [];
    const after = await orchestrator.advanceGenerationRun(
      { runId: created.runId, userId },
      { runTick: makeTickFake({ asked }), runEnrichment: makeEnrichmentFake({ calls: 0 }) },
    );
    expect(asked).toHaveLength(0);
    expect(after.search.leadsFound).toBe(beforeStop.search.leadsFound);
  });

  it("rebuilds the same state on a reopen, with elapsed time from persisted timestamps", async () => {
    const created = await createRun({ enrichEmails: true, testBbox: LARGE_BOX });
    const deps = {
      runTick: makeTickFake({ asked: [] }),
      runEnrichment: makeEnrichmentFake({ calls: 0 }),
    };

    await orchestrator.advanceGenerationRun({ runId: created.runId, userId }, deps);

    const { data: run } = await db
      .from("generation_runs")
      .select("created_at, search_started_at")
      .eq("id", created.runId)
      .single();

    // "Reopening" is simply reading again -- there is no client state to
    // restore, because there is none to lose.
    const fixedNow = Date.parse(run!.created_at) + 252_000;
    const reopened = await stateModule.loadGenerationState(
      { runId: created.runId, userId },
      { now: () => fixedNow },
    );

    expect(reopened.totalElapsedSeconds).toBe(252);
    expect(reopened.search.startedAt).toBe(run!.search_started_at);

    // Reading it a second time at the same instant gives the same answer: the
    // figures come from the database, not from anything accumulating.
    const again = await stateModule.loadGenerationState(
      { runId: created.runId, userId },
      { now: () => fixedNow },
    );
    expect(again.totalElapsedSeconds).toBe(reopened.totalElapsedSeconds);
    expect(again.search.leadsFound).toBe(reopened.search.leadsFound);
    expect(again.budget.used).toBe(reopened.budget.used);
  });

  it("never returns a negative elapsed time when the clock disagrees", async () => {
    const created = await createRun({ enrichEmails: true });

    const { data: run } = await db
      .from("generation_runs")
      .select("created_at")
      .eq("id", created.runId)
      .single();

    const state = await stateModule.loadGenerationState(
      { runId: created.runId, userId },
      { now: () => Date.parse(run!.created_at) - 10_000 },
    );

    expect(state.totalElapsedSeconds).toBe(0);
  });

  /**
   * THE DEFINING PRODUCT RULE, end to end.
   *
   * Target 2, dozens of leads, area still owed: the run keeps going and reports
   * the target as a metric that was exceeded, never as a completion.
   */
  it("keeps searching when the lead target is exceeded but area is still owed", async () => {
    const created = await createRun({
      enrichEmails: false,
      testBbox: LARGE_BOX,
      targetLeads: 2,
    });
    const deps = {
      runTick: makeTickFake({ asked: [] }),
      runEnrichment: makeEnrichmentFake({ calls: 0 }),
    };

    const state = await orchestrator.advanceGenerationRun({ runId: created.runId, userId }, deps);

    expect(state.search.leadsFound).toBeGreaterThan(state.search.targetLeads);
    expect(state.search.targetReached).toBe(true);
    expect(state.search.fullyCovered).toBe(false);
    expect(state.search.areasRemaining).toBeGreaterThan(0);

    // Still running, and still willing to advance.
    expect(state.status).toBe("running");
    expect(state.canAdvance).toBe(true);
    expect(state.stopReason).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Nothing real was touched
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Search area and request transparency
  // -------------------------------------------------------------------------

  /**
   * THE SELECTED AREA COMES FROM THE PERSISTED ROW.
   *
   * Not a label typed into the UI and not a coordinate invented for display:
   * the user has to be able to answer "which part of the city did it search?"
   * and be told the truth.
   */
  // -------------------------------------------------------------------------
  // The completion rule: what "finished" means for email discovery
  // -------------------------------------------------------------------------

  /**
   * COVERAGE COMPLETE IS NOT LIFECYCLE COMPLETE.
   *
   * A search whose whole area has been covered still has work to do while a
   * lead with a website has never been looked at. This is the rule that keeps
   * "Your Leads" off a run that has not finished.
   */
  it("is not complete while a lead with a website is still unchecked", async () => {
    const created = await createRun({ enrichEmails: true, testBbox: SMALL_BOX });

    // Search the whole area, but never let enrichment run.
    const searchOnly = {
      runTick: makeTickFake({ asked: [] }),
      runEnrichment: (async () => {
        throw new Error("enrichment must not run in this case");
      }) as never,
    };

    let state = await stateModule.loadGenerationState({ runId: created.runId, userId });
    for (let i = 0; i < 20 && state.phase === "searching"; i += 1) {
      state = await orchestrator.advanceGenerationRun({ runId: created.runId, userId }, searchOnly);
    }

    // Geography done...
    expect(state.search.fullyCovered).toBe(true);
    // ...but the run is NOT ready, and says so.
    expect(state.phase).toBe("enriching");
    expect(state.status).toBe("running");
    expect(state.lifecycleComplete).toBe(false);
    expect(state.title).not.toMatch(/ready/i);
    expect(state.enrichment.remaining).toBeGreaterThan(0);
    expect(state.canAdvance).toBe(true);
  });

  /**
   * The batch loop runs itself to exhaustion. The fake processes a small,
   * bounded slice each time -- exactly as the real service does -- so reaching
   * zero requires several rounds with no button in between.
   */
  it("works through every eligible lead in bounded batches, unattended", async () => {
    const created = await createRun({ enrichEmails: true, testBbox: LARGE_BOX });

    const batchSizes: number[] = [];
    const deps = {
      runTick: makeTickFake({ asked: [] }),
      runEnrichment: makeEnrichmentFake({ calls: 0 }, batchSizes),
    };

    let state = await stateModule.loadGenerationState({ runId: created.runId, userId });
    for (let i = 0; i < 200 && state.status === "running" && state.canAdvance; i += 1) {
      state = await orchestrator.advanceGenerationRun({ runId: created.runId, userId }, deps);
    }

    // Several batches, each within the per-advance cap.
    expect(batchSizes.length).toBeGreaterThan(2);
    for (const size of batchSizes) {
      expect(size).toBeLessThanOrEqual(GENERATION_LIMITS.enrichmentLeadsPerAdvance);
    }

    // Every lead with a website reached a terminal state.
    const { count: stillPending } = await db
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("search_id", created.searchId)
      .eq("email_status", "not_enriched")
      .not("website", "is", null)
      .neq("website", "");
    expect(stillPending).toBe(0);

    // And only then is it ready.
    expect(state.lifecycleComplete).toBe(true);
    expect(state.title).toBe("Your leads are ready");
    expect(state.stopReason).toBe("generation_complete");
  });

  /**
   * THE REGRESSION FOR THE 93.
   *
   * A lead with no website can never be checked -- Google returns no email at
   * any tier, so the site is the only bridge to one. Those leads must not hold
   * the lifecycle open, and must not be counted as outstanding.
   */
  it("does not let website-less leads block completion", async () => {
    const created = await createRun({ enrichEmails: true, testBbox: SMALL_BOX });
    const deps = {
      runTick: makeTickFake({ asked: [] }),
      runEnrichment: makeEnrichmentFake({ calls: 0 }),
    };

    // One slice of searching, then strip the websites off half the leads --
    // the shape Google really returns.
    await orchestrator.advanceGenerationRun({ runId: created.runId, userId }, deps);
    const { data: leads } = await db.from("leads").select("id").eq("search_id", created.searchId);
    const half = (leads ?? []).slice(0, Math.floor((leads ?? []).length / 2)).map((l) => l.id);
    await db.from("leads").update({ website: null }).in("id", half);

    let state = await stateModule.loadGenerationState({ runId: created.runId, userId });
    for (let i = 0; i < 60 && state.status === "running" && state.canAdvance; i += 1) {
      state = await orchestrator.advanceGenerationRun({ runId: created.runId, userId }, deps);
    }

    // Finished, with the website-less leads still `not_enriched` in the table.
    expect(state.lifecycleComplete).toBe(true);
    expect(state.enrichment.leadsWithoutWebsite).toBe(half.length);

    const { count: untouched } = await db
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("search_id", created.searchId)
      .eq("email_status", "not_enriched");
    expect(untouched).toBe(half.length);

    // They are NOT reported as outstanding work.
    expect(state.enrichment.remaining).toBe(0);
  });

  it("treats found, not_found and failed alike as finished", async () => {
    const created = await createRun({ enrichEmails: true, testBbox: SMALL_BOX });

    // A fake that produces all three terminal outcomes.
    const mixed = (async (args: { userId: string; searchId?: string; limit?: number }) => {
      const { data: candidates } = await db
        .from("leads")
        .select("id")
        .eq("search_id", args.searchId!)
        .eq("email_status", "not_enriched")
        .not("website", "is", null)
        .neq("website", "")
        .order("created_at")
        .limit(args.limit ?? 5);

      const ids = (candidates ?? []).map((c) => c.id);
      const outcomes = ["found", "not_found", "failed"] as const;
      for (const [index, id] of ids.entries()) {
        await db
          .from("leads")
          .update({
            email_status: outcomes[index % 3],
            email: index % 3 === 0 ? `x${index}@example.invalid` : null,
            email_checked_at: new Date().toISOString(),
          })
          .eq("id", id);
      }

      const { count: remaining } = await db
        .from("leads")
        .select("id", { count: "exact", head: true })
        .eq("search_id", args.searchId!)
        .eq("email_status", "not_enriched")
        .not("website", "is", null)
        .neq("website", "");

      return {
        dryRun: false,
        mode: "new",
        selected: ids.length,
        processed: ids.length,
        found: 0,
        notFound: 0,
        failed: 0,
        remaining: remaining ?? 0,
        scope: null as never,
        results: [],
      };
    }) as unknown as typeof import("@/server/enrichment/run-enrichment").runEnrichment;

    const deps = { runTick: makeTickFake({ asked: [] }), runEnrichment: mixed };

    let state = await stateModule.loadGenerationState({ runId: created.runId, userId });
    for (let i = 0; i < 60 && state.status === "running" && state.canAdvance; i += 1) {
      state = await orchestrator.advanceGenerationRun({ runId: created.runId, userId }, deps);
    }

    // A run containing failures is still a finished run.
    expect(state.lifecycleComplete).toBe(true);
    expect(state.enrichment.failed).toBeGreaterThan(0);
    expect(state.enrichment.remaining).toBe(0);
  });

  it("does not let a remount cut enrichment short", async () => {
    const created = await createRun({ enrichEmails: true, testBbox: LARGE_BOX });
    const deps = {
      runTick: makeTickFake({ asked: [] }),
      runEnrichment: makeEnrichmentFake({ calls: 0 }),
    };

    let state = await stateModule.loadGenerationState({ runId: created.runId, userId });
    for (let i = 0; i < 60 && state.phase !== "enriching"; i += 1) {
      state = await orchestrator.advanceGenerationRun({ runId: created.runId, userId }, deps);
    }
    // Part-way through the email phase.
    state = await orchestrator.advanceGenerationRun({ runId: created.runId, userId }, deps);
    expect(state.enrichment.remaining).toBeGreaterThan(0);

    // The user navigates away and comes back: the state is simply re-read.
    const reopened = await stateModule.loadGenerationState({ runId: created.runId, userId });
    expect(reopened.status).toBe("running");
    expect(reopened.canAdvance).toBe(true);
    expect(reopened.lifecycleComplete).toBe(false);
    expect(reopened.phase).toBe("enriching");

    // And it picks up exactly where it left off.
    let resumed = reopened;
    for (let i = 0; i < 200 && resumed.status === "running" && resumed.canAdvance; i += 1) {
      resumed = await orchestrator.advanceGenerationRun({ runId: created.runId, userId }, deps);
    }
    expect(resumed.lifecycleComplete).toBe(true);
  });

  it("never counts a productive email batch as no progress", async () => {
    const created = await createRun({ enrichEmails: true, testBbox: LARGE_BOX });
    const deps = {
      runTick: makeTickFake({ asked: [] }),
      runEnrichment: makeEnrichmentFake({ calls: 0 }),
    };

    let state = await stateModule.loadGenerationState({ runId: created.runId, userId });
    for (let i = 0; i < 200 && state.status === "running" && state.canAdvance; i += 1) {
      state = await orchestrator.advanceGenerationRun({ runId: created.runId, userId }, deps);

      const { data: row } = await db
        .from("generation_runs")
        .select("no_progress_ticks")
        .eq("id", created.runId)
        .single();
      // Real work happened every round, so the liveness guard stays at zero.
      expect(row!.no_progress_ticks).toBe(0);
    }

    expect(state.stopReason).toBe("generation_complete");
  });

  it("reports the search area from the stored rectangle, not from a label", async () => {
    const created = await createRun({ enrichEmails: false, testBbox: SMALL_BOX });

    const state = await stateModule.loadGenerationState({ runId: created.runId, userId });

    // Straight from `searches`, which `createSearch` wrote from the resolved box.
    const { data: search } = await db
      .from("searches")
      .select(
        "label, area_total_km2, area_covered_km2, coverage_pct, min_lat, min_lng, max_lat, max_lng",
      )
      .eq("id", created.searchId)
      .single();

    expect(state.area.label).toBe(search!.label);
    expect(state.area.totalKm2).toBe(search!.area_total_km2);
    expect(state.area.searchedKm2).toBe(search!.area_covered_km2);
    expect(state.area.coveragePct).toBe(search!.coverage_pct);

    // The exact rectangle, to the value stored.
    expect(state.area.bounds).toEqual({
      north: search!.max_lat,
      south: search!.min_lat,
      east: search!.max_lng,
      west: search!.min_lng,
    });
    // And it is the box that was actually asked for.
    expect(state.area.bounds.north).toBe(SMALL_BOX.maxLat);
    expect(state.area.bounds.west).toBe(SMALL_BOX.minLng);

    // Nothing searched yet: all of it is still owed, and the arithmetic adds up.
    expect(state.area.searchedKm2).toBe(0);
    expect(state.area.remainingKm2).toBeCloseTo(state.area.totalKm2, 6);
    expect(state.area.fullyCovered).toBe(false);
  });

  it("reports 100% coverage and no remaining area once the whole box is searched", async () => {
    const created = await createRun({ enrichEmails: false, testBbox: SMALL_BOX });
    const deps = {
      runTick: makeTickFake({ asked: [] }),
      runEnrichment: makeEnrichmentFake({ calls: 0 }),
    };

    let state = await stateModule.loadGenerationState({ runId: created.runId, userId });
    for (let i = 0; i < 20 && state.status === "running" && state.canAdvance; i += 1) {
      state = await orchestrator.advanceGenerationRun({ runId: created.runId, userId }, deps);
    }

    expect(state.area.coveragePct).toBe(100);
    expect(state.area.fullyCovered).toBe(true);
    expect(state.area.remainingKm2).toBeCloseTo(0, 6);
    expect(state.area.searchedKm2).toBeCloseTo(state.area.totalKm2, 6);
  });

  /**
   * GOOGLE AND WEBSITE CHECKS ARE DIFFERENT THINGS.
   *
   * The header used to read "API 188 / 950", which said neither whose API nor
   * against what. These keep the categories apart and keep the denominators
   * honest.
   */
  it("counts Google calls and website checks separately", async () => {
    const created = await createRun({ enrichEmails: true, testBbox: SMALL_BOX });
    const deps = {
      runTick: makeTickFake({ asked: [] }),
      runEnrichment: makeEnrichmentFake({ calls: 0 }),
    };

    let state = await stateModule.loadGenerationState({ runId: created.runId, userId });
    for (let i = 0; i < 30 && state.status === "running" && state.canAdvance; i += 1) {
      state = await orchestrator.advanceGenerationRun({ runId: created.runId, userId }, deps);
    }

    const { data: search } = await db
      .from("searches")
      .select("api_calls_run")
      .eq("id", created.searchId)
      .single();

    // Google: this search's own billable calls, against the per-search ceiling.
    expect(state.requests.googlePlacesThisSearch).toBe(search!.api_calls_run);
    expect(state.requests.googleSearchBudget).toBe(SEARCH_LIMITS.maxCallsPerSearch);

    // The MONTHLY denominator is the full free allowance, never the internal
    // protected figure that produced "/ 950".
    expect(state.requests.googleMonthlyLimit).toBe(1_000);
    expect(state.requests.googleMonthlyUsed).toBeLessThanOrEqual(state.requests.googleMonthlyLimit);

    // Website checks are counted from recorded attempts, and are a DIFFERENT
    // number from the Google calls.
    const { count: attempts } = await db
      .from("lead_enrichment_attempts")
      .select("id, leads!inner(search_id)", { count: "exact", head: true })
      .eq("leads.search_id", created.searchId);
    expect(state.requests.websitesChecked).toBe(attempts ?? 0);
    expect(state.requests.websitesChecked).toBeGreaterThan(0);

    // The categories that do not exist stay at zero.
    expect(state.requests.geocoding).toBe(0);
    expect(state.requests.thirdPartyEmail).toBe(0);
  });

  it("leaves the month's Google allowance exactly as it found it", async () => {
    const { data: counters } = await db.from("api_usage_counters").select("*").order("sku");
    expect(counters).toEqual(countersBefore);
  });

  it("leaves every pre-existing search and lead untouched", async () => {
    const { data: searches } = await db
      .from("searches")
      .select("id, status, leads_found, api_calls_run, coverage_pct, stop_reason")
      .not("id", "in", `(${createdSearchIds.join(",")})`)
      .order("id");
    expect(searches).toEqual(searchesBefore);

    const { data: leads } = await db
      .from("leads")
      .select("id, email_status")
      .not("search_id", "in", `(${createdSearchIds.join(",")})`)
      .order("id");
    expect(leads).toEqual(leadsBefore);
  });
});
