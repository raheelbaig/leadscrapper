import "server-only";

import { randomUUID } from "node:crypto";

import { DEFAULT_GRID_CONFIG } from "@/lib/constants";
import type { Json } from "@/lib/database.types";
import { buildCoverageReport, type CoverageReport, type CoverageTile } from "@/lib/coverage-report";
import { bboxHeightKm, bboxWidthKm, type BoundingBox } from "@/lib/geo/bbox";
import type { TileState } from "@/lib/tile-states";
import { getSupabaseAdminClient } from "@/server/db/admin";
import type { PlacesApiError } from "@/server/places/errors";
import { mapPlaces } from "@/server/places/lead-mapper";

import { claimSearchById } from "./claim";
import { classifyTile, type TileClassification } from "./classify-tile";
import {
  finalOutcome,
  finalStatus,
  nextStopReason,
  type SearchTerminalStatus,
  type TickOutcome,
  type TickStopReason,
} from "./completion";
import { logSearchEvent } from "./events";
import { SEARCH_LIMITS } from "./limits";
import { runPreflight, SearchBlockedError, type PreflightResult } from "./preflight";
import { paginateTile, type PaginateTileOptions } from "./tile-runner";

/**
 * ONE bounded tick of the real pipeline.
 *
 * A tick walks a grid: claim -> for each tile, pages 1..3 with the mandated
 * token delay -> map -> dedupe insert -> classify R1-R5 -> subdivide if
 * saturated -> release.
 *
 * COMPLETION IS GEOGRAPHIC. The lead target is a minimum desired benchmark and
 * does not end a search: a run that wanted 40 leads and has found 87 keeps
 * working through its pending tiles, and finishes `completed` only when every
 * leaf tile is accounted for. Coverage and the lead target are separate
 * concepts and are never conflated here, in the UI, or in the export.
 * `targetReached` is reported as a metric on every result and is not a stop
 * reason.
 *
 * The same function serves the manual Run button and the background worker;
 * the worker differs only in passing a shorter wall-clock slice, which the
 * option clamps allow it to lower and not to raise.
 *
 * The order of the first two steps matters and is not an accident:
 *
 *   1. PRE-FLIGHT, before anything is claimed or mutated. A run blocked by the
 *      pricing gate, the call budget or the free allowance must leave no lease
 *      to expire, no tile in `in_progress`, and no status to clean up -- it
 *      simply never started.
 *   2. CLAIM, which is the mutual-exclusion primitive. Two runners holding the
 *      same search is the only way this design could bill Google twice for one
 *      tile, so nothing after this point runs without the lease.
 *
 * FOUR independent budgets stop the loop, and whichever binds first wins:
 * tiles per tick, calls per tick, calls per SEARCH (cumulative across every
 * resume), and wall-clock. The per-search call budget is the one that matters:
 * with subdivision in play, geometry alone no longer bounds what a run can
 * spend, so a fixed number has to.
 *
 * Everything that matters is persisted as it happens -- after every PAGE, not
 * every tile. A tick that dies at any point loses at most the single in-flight
 * page, and the tile returns to `pending` on the next run rather than being
 * recorded as covered.
 *
 * Two columns are deliberately NOT written here. `search_tiles.api_calls` and
 * `searches.api_calls_run` are owned by `record_api_call()`, which increments
 * them inside the same statement that appends the audit row; writing them from
 * here as well would double-count every call. `unique_new_count` is likewise
 * owned by `insert_leads_dedup`.
 */

export type { TickOutcome, TickStopReason } from "./completion";

/** What one tile did, for the run summary and the toast. */
export type TileRunSummary = {
  tileId: string;
  tileLabel: string;
  state: TileState;
  rule: string | null;
  reason: string;
  pagesFetched: number;
  resultsReceived: number;
  leadsInserted: number;
  duplicatesRejected: number;
  placesRejected: number;
  apiCalls: number;
  tokenRemaining: boolean;
  childrenCreated: number;
};

export type ControlledTickResult = {
  outcome: TickOutcome;
  searchId: string;
  searchStatus: string;
  stopReason: TickStopReason;
  tiles: TileRunSummary[];
  /** Billable Google calls made by this tick. */
  apiCalls: number;
  /** Billable calls this search has now made, cumulative across resumes. */
  apiCallsTotal: number;
  callBudget: number;
  resultsReceived: number;
  leadsInserted: number;
  duplicatesRejected: number;
  placesRejected: number;
  leadsFound: number;
  targetLeads: number;
  targetReached: boolean;
  preflight: PreflightResult;
  coverage: CoverageReport;
  error: string | null;
};

export type RunControlledTickOptions = PaginateTileOptions & {
  /** Overrides the worker identity; defaults to a fresh uuid per tick. */
  workerId?: string;
  leaseSeconds?: number;
  /** Never widens the phase cap -- both are clamped by it. */
  maxTilesPerTick?: number;
  /**
   * Wall-clock slice for this tick.
   *
   * Clamped like every other option, so the background worker can hand itself a
   * SHORTER slice than the manual route takes but can never hand itself a
   * longer one.
   */
  maxTickMs?: number;
  /** Injected in tests. Defaults to `Date.now`. */
  now?: () => number;
};

type AdminDb = ReturnType<typeof getSupabaseAdminClient>;

/** States that still owe work and are picked up by a resume. */
const RESUMABLE: TileState[] = ["failed", "skipped_quota"];

function readGridConfig(raw: Json | null) {
  const source =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

  const num = (key: string, fallback: number) =>
    typeof source[key] === "number" ? (source[key] as number) : fallback;
  const bool = (key: string, fallback: boolean) =>
    typeof source[key] === "boolean" ? (source[key] as boolean) : fallback;

  return {
    // Clamped again on the way out. The row was capped at creation, but a row
    // written by an earlier phase must not be able to widen this one.
    maxSubdivisionDepth: Math.min(
      num("maxSubdivisionDepth", DEFAULT_GRID_CONFIG.maxSubdivisionDepth),
      SEARCH_LIMITS.maxSubdivisionDepth,
    ),
    minTileEdgeKm: num("minTileEdgeKm", DEFAULT_GRID_CONFIG.minTileEdgeKm),
    saturationRatio: num("saturationRatio", DEFAULT_GRID_CONFIG.saturationRatio),
    stopOnTargetReached: bool("stopOnTargetReached", DEFAULT_GRID_CONFIG.stopOnTargetReached),
  };
}

export async function runControlledTick(
  args: { searchId: string; userId: string },
  options: RunControlledTickOptions = {},
): Promise<ControlledTickResult> {
  const db = getSupabaseAdminClient();
  const workerId = options.workerId ?? randomUUID();
  const leaseSeconds = options.leaseSeconds ?? 90;
  const now = options.now ?? Date.now;

  // -----------------------------------------------------------------------
  // 0. The search must exist and must belong to the caller. The service-role
  //    client bypasses RLS, so ownership is checked explicitly here.
  // -----------------------------------------------------------------------
  const { data: search, error: loadError } = await db
    .from("searches")
    .select("*")
    .eq("id", args.searchId)
    .eq("user_id", args.userId)
    .maybeSingle();

  if (loadError) throw new Error(`Could not load the search: ${loadError.message}`);
  if (!search) throw new Error("Search not found.");

  const gridConfig = readGridConfig(search.grid_config);

  // Every one of these is clamped by the phase cap, so an option cannot widen
  // it -- and the API route passes no options at all.
  const maxAttempts = Math.min(
    options.maxAttempts ?? SEARCH_LIMITS.maxAttemptsPerPage,
    SEARCH_LIMITS.maxAttemptsPerPage,
  );
  const maxPages = Math.min(
    options.maxPages ?? SEARCH_LIMITS.maxPagesPerTile,
    SEARCH_LIMITS.maxPagesPerTile,
  );
  const maxTiles = Math.min(
    options.maxTilesPerTick ?? SEARCH_LIMITS.maxTilesPerTick,
    SEARCH_LIMITS.maxTilesPerTick,
  );
  const maxTickMs = Math.min(options.maxTickMs ?? SEARCH_LIMITS.maxTickMs, SEARCH_LIMITS.maxTickMs);

  const callBudget = SEARCH_LIMITS.maxCallsPerSearch;
  const callsAlreadySpent = search.api_calls_run;

  // -----------------------------------------------------------------------
  // 1. PRE-FLIGHT. Before the lease, before any mutation.
  // -----------------------------------------------------------------------
  // It is told exactly what this tick will do -- how many tiles it may take,
  // how many pages, how many attempts, and how much of the budget is left --
  // so the estimate describes this run rather than a hypothetical one.
  const { count: owedTiles } = await db
    .from("search_tiles")
    .select("id", { count: "exact", head: true })
    .eq("search_id", args.searchId)
    .in("state", ["pending", ...RESUMABLE]);

  const tilesThisTick = Math.min(owedTiles ?? 0, maxTiles);

  const preflight = await runPreflight({
    db,
    tiles: Math.max(tilesThisTick, 1),
    pagesPerTile: maxPages,
    attemptsPerPage: maxAttempts,
    maxSubdivisionDepth: gridConfig.maxSubdivisionDepth,
    callBudget,
    callsAlreadySpent,
  });

  if (!preflight.allowed) {
    await logSearchEvent(db, {
      searchId: args.searchId,
      level: "warn",
      code: `blocked_${preflight.blocked!.code.replace(/-/g, "_")}`,
      message: `${preflight.blocked!.title} — ${preflight.blocked!.message}`,
      meta: {
        action: preflight.blocked!.action,
        pricing_version: preflight.pricing.version,
        pricing_verified: preflight.pricing.verified,
        quota_remaining: preflight.quota.remaining,
        call_budget_remaining: preflight.estimate.callBudgetRemaining,
        api_calls_made: 0,
      },
    });

    throw new SearchBlockedError(preflight);
  }

  // -----------------------------------------------------------------------
  // 2. Make the search claimable, then claim it.
  // -----------------------------------------------------------------------
  // `failed` is included deliberately. The tile state machine has an explicit
  // ('failed' -> 'pending', 'retry on resume') transition, so pressing Run on a
  // failed search means "try again" -- otherwise a single transient API error
  // would strand the search permanently with no way back.
  if (search.status === "draft" || search.status === "paused" || search.status === "failed") {
    await db
      .from("searches")
      .update({ status: "queued", queued_at: new Date().toISOString() })
      .eq("id", args.searchId);
  }

  const claimedRow = await claimSearchById(db, {
    searchId: args.searchId,
    workerId,
    leaseSeconds,
  });

  if (!claimedRow) {
    // Someone else holds a live lease, or the search is not runnable. Never
    // proceed without the lease -- that is the double-billing guard.
    throw new Error(
      "This search is already running, or is not in a runnable state. Wait for the current run to finish.",
    );
  }

  const startedAt = now();
  const tiles: TileRunSummary[] = [];

  let callsThisTick = 0;
  let leadsFound = search.leads_found;
  let stop: TickStopReason = "coverage_complete";
  let fatalError: PlacesApiError | null = null;

  try {
    // A dead process cannot have completed a tile. Any tile left `in_progress`
    // by an interrupted run goes back to `pending`, and its page token is
    // dropped because tokens expire -- the tile restarts at page 1.
    await db.rpc("recover_stalled_tiles", { p_search: args.searchId });

    // Retryable leftovers from an earlier run. Both transitions are declared
    // legal in tile_state_transitions ('retry on resume'), and both represent
    // work still OWED rather than coverage already achieved -- leaving them
    // alone would let the run report "nothing to do" over an unsearched tile.
    const { data: retried } = await db
      .from("search_tiles")
      .update({ state: "pending", last_reason: "retry on resume", next_page_token: null })
      .eq("search_id", args.searchId)
      .in("state", RESUMABLE)
      .select("id");

    if (retried && retried.length > 0) {
      await logSearchEvent(db, {
        searchId: args.searchId,
        level: "info",
        code: "tiles_retried",
        message: `${retried.length} tile(s) returned to pending for retry.`,
        meta: { count: retried.length },
      });
    }

    // -------------------------------------------------------------------
    // 3. The tile loop.
    // -------------------------------------------------------------------
    for (;;) {
      // Pause and cancel are cooperative: the tick re-reads its own status
      // every iteration rather than being killed mid-request, so it always
      // stops between tiles with the lease released and nothing in flight.
      const { data: control } = await db
        .from("searches")
        .select("status")
        .eq("id", args.searchId)
        .maybeSingle();

      // Every budget in one place, in a fixed order, tested without a database.
      // Note what is NOT among them: the lead target. It is a minimum desired
      // benchmark and cannot end a run.
      //
      // `stopOnTargetReached` is honoured only for a search created before
      // 2026-08-22, whose frozen `grid_config` still carries the old policy.
      // That row's definition is respected rather than silently rewritten --
      // but it PAUSES rather than completing, because its geography is
      // genuinely still owed, and "Continue to full coverage" is how a person
      // amends it.
      const reason = nextStopReason({
        stopOnTargetReached: gridConfig.stopOnTargetReached,
        leadsFound,
        targetLeads: search.target_leads,
        status: control?.status ?? "running",
        callsRemainingInSearch: callBudget - (callsAlreadySpent + callsThisTick),
        callsThisTick,
        maxCallsPerTick: SEARCH_LIMITS.maxCallsPerTick,
        tilesThisTick: tiles.length,
        maxTilesPerTick: maxTiles,
        elapsedMs: now() - startedAt,
        maxTickMs,
      });

      if (reason) {
        stop = reason;
        break;
      }

      const { data: tile } = await db
        .from("search_tiles")
        .select("*")
        .eq("search_id", args.searchId)
        .eq("state", "pending")
        .order("path", { ascending: true })
        .limit(1)
        .maybeSingle();

      if (!tile) {
        stop = "coverage_complete";
        break;
      }

      // The lease is what authorises a Google request. If it was stolen or
      // released while we worked, stop before spending anything more.
      const { data: leaseHeld } = await db.rpc("heartbeat_job", {
        p_search: args.searchId,
        p_worker: workerId,
        p_status_text: `${tile.label}: requesting page 1…`,
        p_current_tile: tile.id,
        p_current_page: 1,
      });

      if (leaseHeld === false) {
        stop = "lease_lost";
        break;
      }

      const summary = await runOneTile({
        db,
        search: {
          id: args.searchId,
          sku: search.search_sku,
          queryText: search.query_text,
        },
        tile,
        gridConfig,
        workerId,
        options: { ...options, db, maxAttempts, maxPages },
      });

      tiles.push(summary.summary);
      callsThisTick += summary.summary.apiCalls;

      await db.rpc("recompute_search_progress", { p_search: args.searchId });

      const { data: progress } = await db
        .from("searches")
        .select("leads_found")
        .eq("id", args.searchId)
        .maybeSingle();

      leadsFound = progress?.leads_found ?? leadsFound;

      if (summary.quotaDenied) {
        stop = "quota_exhausted";
        break;
      }

      if (summary.fatal) {
        // A non-retryable error that reached Google -- a bad key, a rejected
        // field mask -- is a configuration fault, not a tile fault. It will
        // reproduce on every remaining tile, so abandoning the whole tick is
        // what stops the budget being spent collecting identical rejections.
        fatalError = summary.fatal;
        stop = "fatal_api_error";
        break;
      }
    }

    // -------------------------------------------------------------------
    // 4. Report honestly, then release the lease.
    // -------------------------------------------------------------------
    await db.rpc("recompute_search_progress", { p_search: args.searchId });
    await db.rpc("verify_search_coverage", { p_search: args.searchId });

    const coverage = await loadCoverage(db, args.searchId, search.target_leads);

    // "No pending tiles left" is not the same as "the area was covered". A
    // failed or quota-skipped tile leaves the loop with nothing pending while
    // the geography is still owed, so the reason has to come from what the
    // grid actually looks like rather than from why the loop exited.
    if (stop === "coverage_complete" && coverage.owed.tiles > 0) {
      stop =
        coverage.byState.failed.tiles > 0
          ? "tile_error"
          : coverage.byState.skipped_quota.tiles > 0
            ? "quota_exhausted"
            : "tile_budget_reached";
    }

    const status = finalStatus(stop);
    const outcome = finalOutcome(stop, tiles.length);

    await logSearchEvent(db, {
      searchId: args.searchId,
      level: coverage.fullyCovered ? "info" : "warn",
      code: "coverage_report",
      message: coverage.summary,
      meta: {
        stop_reason: stop,
        tiles_this_tick: tiles.length,
        api_calls_made: callsThisTick,
        api_calls_total: callsAlreadySpent + callsThisTick,
        call_budget: callBudget,
        leads_found: coverage.leadsFound,
        target: coverage.target,
        coverage_pct: Number(coverage.coveragePct.toFixed(2)),
        area_unsearched_km2: Number(coverage.owed.areaKm2.toFixed(3)),
        area_permanent_gap_km2: Number(coverage.permanentGap.areaKm2.toFixed(3)),
        tiles_remaining: coverage.tilesRemaining,
        fully_covered: coverage.fullyCovered,
      },
    });

    const lastError = fatalError ? fatalError.logMessage : null;
    await finish(db, args.searchId, workerId, status, stop, lastError);

    const totals = tiles.reduce(
      (acc, tile) => ({
        results: acc.results + tile.resultsReceived,
        inserted: acc.inserted + tile.leadsInserted,
        duplicates: acc.duplicates + tile.duplicatesRejected,
        rejected: acc.rejected + tile.placesRejected,
      }),
      { results: 0, inserted: 0, duplicates: 0, rejected: 0 },
    );

    return {
      outcome,
      searchId: args.searchId,
      searchStatus: status,
      stopReason: stop,
      tiles,
      apiCalls: callsThisTick,
      apiCallsTotal: callsAlreadySpent + callsThisTick,
      callBudget,
      resultsReceived: totals.results,
      leadsInserted: totals.inserted,
      duplicatesRejected: totals.duplicates,
      placesRejected: totals.rejected,
      leadsFound: coverage.leadsFound,
      targetLeads: coverage.target,
      targetReached: coverage.targetReached,
      preflight,
      coverage,
      error: lastError,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await logSearchEvent(db, {
      searchId: args.searchId,
      level: "error",
      code: "tick_failed",
      message: `The controlled run stopped: ${message}`,
      meta: { api_calls_made: callsThisTick },
    });

    // Always release the lease. A held lease would block every later attempt
    // until it expired, and any tile left `in_progress` is returned to pending
    // by recover_stalled_tiles on the next run.
    await finish(db, args.searchId, workerId, "failed", "tick_error", message);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// One tile: pages 1..3, persisted per page, then classified.
// ---------------------------------------------------------------------------

type TileRow = {
  id: string;
  label: string;
  depth: number;
  /** Generated column; typed nullable by the generator, never null in practice. */
  edge_km: number | null;
  attempts: number;
  min_lat: number;
  min_lng: number;
  max_lat: number;
  max_lng: number;
};

async function runOneTile(input: {
  db: AdminDb;
  search: { id: string; sku: string; queryText: string };
  tile: TileRow;
  gridConfig: ReturnType<typeof readGridConfig>;
  workerId: string;
  options: PaginateTileOptions;
}): Promise<{
  summary: TileRunSummary;
  quotaDenied: boolean;
  fatal: PlacesApiError | null;
}> {
  const { db, search, tile, gridConfig, workerId, options } = input;

  const bbox: BoundingBox = {
    minLat: tile.min_lat,
    minLng: tile.min_lng,
    maxLat: tile.max_lat,
    maxLng: tile.max_lng,
  };

  // `edge_km` is `greatest(rect_width_km, rect_height_km)` as a generated
  // column. The fallback recomputes exactly that from the rectangle, so a null
  // from the type generator can never silently become an edge of 0 -- which
  // would send every saturated tile to `saturated_floor` as a permanent gap.
  const edgeKm = tile.edge_km ?? Math.max(bboxWidthKm(bbox), bboxHeightKm(bbox));

  // pending -> in_progress. The transition trigger rejects anything illegal,
  // and the event trigger writes the tile_events row for free.
  //
  // The per-pass counters are RESET here, and that is load-bearing. Page tokens
  // expire, so an interrupted tile always restarts at page 1 -- and if
  // `results_count` carried over, a tile that returned 40 results, died, and
  // returned the same 40 again would read as R = 80 and subdivide an area that
  // was never saturated. `api_calls` is not reset: those calls really were
  // spent, and it is owned by record_api_call anyway.
  //
  // The `state = pending` predicate makes this a compare-and-swap, and the
  // result is CHECKED rather than assumed. The search lease should already make
  // a lost race impossible, but "should" is not the standard for the statement
  // that stands between here and a billable request: if this tile was not won,
  // nothing may be spent on it.
  const { data: claimed, error: claimError } = await db
    .from("search_tiles")
    .update({
      state: "in_progress",
      last_reason: "claimed by controlled tick",
      started_at: new Date().toISOString(),
      attempts: tile.attempts + 1,
      results_count: 0,
      pages_fetched: 0,
      token_after_last: false,
      next_page_token: null,
      completed_at: null,
    })
    .eq("id", tile.id)
    .eq("state", "pending")
    .select("id");

  if (claimError) {
    throw new Error(`Could not claim ${tile.label}: ${claimError.message}`);
  }

  if (!claimed || claimed.length === 0) {
    throw new Error(
      `${tile.label} was no longer pending when the tick tried to claim it. ` +
        "Refusing to search a tile this run does not own.",
    );
  }

  await logSearchEvent(db, {
    searchId: search.id,
    level: "info",
    code: "tile_started",
    message: `${tile.label}: requesting page 1 for “${search.queryText}”`,
    meta: { tile_id: tile.id, bbox, page: 1, depth: tile.depth },
  });

  let resultsReceived = 0;
  let leadsInserted = 0;
  let duplicatesRejected = 0;
  let placesRejected = 0;

  const pageResult = await paginateTile(
    {
      sku: search.sku,
      searchId: search.id,
      tileId: tile.id,
      textQuery: search.queryText,
      bbox,
    },
    {
      ...options,
      onPage: async (page) => {
        // ---- insert, before the next page is requested -------------------
        // Deduplication is the database's unique constraint on
        // (search_id, place_id) -- never an in-memory Set, which would not
        // survive a crash, a resume, or two ticks running back to back.
        const mapped = mapPlaces(page.response.places, {
          tileLabel: tile.label,
          queryText: search.queryText,
        });

        placesRejected += mapped.rejected.length;

        if (mapped.leads.length > 0) {
          const { data: insertResult, error: insertError } = await db.rpc("insert_leads_dedup", {
            p_search: search.id,
            p_tile: tile.id,
            p_leads: mapped.leads as unknown as Json,
          });

          if (insertError) {
            throw new Error(`insert_leads_dedup failed: ${insertError.message}`);
          }

          const row = Array.isArray(insertResult) ? insertResult[0] : null;
          const inserted = row?.inserted ?? 0;
          leadsInserted += inserted;
          duplicatesRejected += Math.max(mapped.leads.length - inserted, 0);
        }

        resultsReceived = page.cumulativeResults;

        // ---- persist the tile's progress ---------------------------------
        // `next_page_token` stays null on purpose. Tokens expire in about a
        // minute, so a stored one would be stale by the next run and would make
        // the tile restart from a token Google has forgotten. `token_after_last`
        // records that more results EXIST, which is what classification and the
        // coverage report actually need.
        await db
          .from("search_tiles")
          .update({
            results_count: page.cumulativeResults,
            pages_fetched: page.cumulativePages,
            token_after_last: page.tokenPresent,
            next_page_token: null,
          })
          .eq("id", tile.id);

        await db.rpc("heartbeat_job", {
          p_search: search.id,
          p_worker: workerId,
          p_status_text: `${tile.label}: page ${page.pageIndex + 1} of ${SEARCH_LIMITS.maxPagesPerTile}`,
          p_current_tile: tile.id,
          p_current_page: page.pageIndex + 1,
        });

        await logSearchEvent(db, {
          searchId: search.id,
          level: "info",
          code: "page_fetched",
          message:
            `${tile.label} page ${page.pageIndex + 1}: ${page.response.places.length} result(s)` +
            (page.tokenPresent ? ", another page is available" : ", no further pages"),
          meta: {
            tile_id: tile.id,
            page: page.pageIndex + 1,
            results: page.response.places.length,
            cumulative_results: page.cumulativeResults,
            next_page_token_present: page.tokenPresent,
            http_status: page.httpStatus,
            duration_ms: page.durationMs,
            attempts: page.attempts,
            api_calls_made: page.callsMade,
          },
        });
      },
    },
  );

  const base = {
    tileId: tile.id,
    tileLabel: tile.label,
    pagesFetched: pageResult.pagesFetched,
    resultsReceived,
    leadsInserted,
    duplicatesRejected,
    placesRejected,
    apiCalls: pageResult.callsMade,
    tokenRemaining: pageResult.tokenRemaining,
    childrenCreated: 0,
  };

  // ---- quota denied ------------------------------------------------------
  if (pageResult.outcome === "quota-denied") {
    const reason =
      pageResult.pagesFetched === 0
        ? "budget guard denied the reservation before page 1"
        : `budget guard denied the reservation before page ${pageResult.pagesFetched + 1}; pages ${pageResult.pagesFetched + 1}+ are still owed`;

    await db
      .from("search_tiles")
      .update({
        state: "skipped_quota",
        last_reason: reason,
        completed_at: new Date().toISOString(),
      })
      .eq("id", tile.id);

    await logSearchEvent(db, {
      searchId: search.id,
      level: "warn",
      code: "quota_denied",
      message: `FREE PLAN LIMIT REACHED — ${tile.label} was not completed. ${pageResult.quota?.remaining ?? 0} call(s) remain in ${pageResult.quota?.period ?? "this period"}.`,
      meta: {
        tile_id: tile.id,
        remaining: pageResult.quota?.remaining ?? 0,
        pages_fetched: pageResult.pagesFetched,
        api_calls_made: pageResult.callsMade,
      },
    });

    return {
      summary: { ...base, state: "skipped_quota", rule: null, reason },
      quotaDenied: true,
      fatal: null,
    };
  }

  // ---- R1: an API error after bounded retries ----------------------------
  if (pageResult.outcome === "error" && pageResult.error) {
    const error = pageResult.error;
    const reason = `R1: ${error.logMessage}`.slice(0, 500);

    await db
      .from("search_tiles")
      .update({
        state: "failed",
        last_reason: reason,
        last_error: error.logMessage.slice(0, 500),
        completed_at: new Date().toISOString(),
      })
      .eq("id", tile.id);

    // Not retryable AND it reached Google: a bad key, a rejected field mask, a
    // disabled API. Every remaining tile would fail identically.
    const fatal = !error.retryable && error.reachedGoogle ? error : null;

    await logSearchEvent(db, {
      searchId: search.id,
      level: "error",
      code: fatal ? "tile_failed_fatal" : "tile_failed",
      message:
        `${tile.label}: ${error.logMessage}` +
        (fatal ? " — this will not fix itself, so the run stopped here." : " — retried on resume."),
      meta: {
        tile_id: tile.id,
        http_status: error.status,
        google_status: error.googleStatus,
        kind: error.kind,
        retryable: error.retryable,
        pages_fetched: pageResult.pagesFetched,
        api_calls_made: pageResult.callsMade,
      },
    });

    return { summary: { ...base, state: "failed", rule: "R1", reason }, quotaDenied: false, fatal };
  }

  // ---- R2 / R3 / R4a / R4b ----------------------------------------------
  const classification: TileClassification = classifyTile({
    resultsCount: pageResult.resultsCount,
    tokenRemaining: pageResult.tokenRemaining,
    pagesFetched: pageResult.pagesFetched,
    depth: tile.depth,
    edgeKm,
    maxSubdivisionDepth: gridConfig.maxSubdivisionDepth,
    minTileEdgeKm: gridConfig.minTileEdgeKm,
    saturationRatio: gridConfig.saturationRatio,
  });

  let childrenCreated = 0;

  if (classification.state === "subdivided") {
    // The RPC performs the in_progress -> subdivided transition ITSELF, so the
    // state is not touched here. Doing it the other way round would leave four
    // children overlapping a tile that is still a live leaf -- exactly what
    // verify_search_coverage flags as a broken grid.
    const { data: children, error: splitError } = await db.rpc("create_child_tiles", {
      p_tile: tile.id,
      p_reason: classification.reason,
    });

    if (splitError) {
      throw new Error(`create_child_tiles failed for ${tile.label}: ${splitError.message}`);
    }

    childrenCreated = typeof children === "number" ? children : 0;

    if (childrenCreated !== 4) {
      // The RPC is all-or-nothing and already raises on this; asserting here as
      // well means a future change to it cannot quietly leave a gap in the grid.
      throw new Error(
        `create_child_tiles returned ${childrenCreated} children for ${tile.label}, expected 4.`,
      );
    }
  } else {
    await db
      .from("search_tiles")
      .update({
        state: classification.state,
        last_reason: classification.reason,
        completed_at: new Date().toISOString(),
      })
      .eq("id", tile.id);
  }

  await logSearchEvent(db, {
    searchId: search.id,
    level: classification.state === "saturated_floor" ? "warn" : "info",
    code: `tile_${classification.state}`,
    message:
      `${tile.label}: ${pageResult.resultsCount} result(s) over ${pageResult.pagesFetched} page(s), ` +
      `${leadsInserted} new lead(s)` +
      (duplicatesRejected > 0
        ? `, ${duplicatesRejected} duplicate(s) rejected by the database`
        : "") +
      `. ${classification.reason}`,
    meta: {
      tile_id: tile.id,
      rule: classification.rule,
      results_count: pageResult.resultsCount,
      pages_fetched: pageResult.pagesFetched,
      inserted: leadsInserted,
      duplicates_rejected: duplicatesRejected,
      places_rejected: placesRejected,
      next_page_token_present: pageResult.tokenRemaining,
      saturated: classification.saturated,
      children_created: childrenCreated,
      depth: tile.depth,
      api_calls_made: pageResult.callsMade,
      http_status: pageResult.lastHttpStatus,
    },
  });

  return {
    summary: {
      ...base,
      state: classification.state,
      rule: classification.rule,
      reason: classification.reason,
      childrenCreated,
    },
    quotaDenied: false,
    fatal: null,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadCoverage(
  db: AdminDb,
  searchId: string,
  target: number,
): Promise<CoverageReport> {
  const [{ data: tiles }, { data: search }] = await Promise.all([
    db.from("search_tiles").select("label, state, area_km2, depth").eq("search_id", searchId),
    db.from("searches").select("leads_found").eq("id", searchId).maybeSingle(),
  ]);

  return buildCoverageReport({
    tiles: (tiles ?? []).map((tile): CoverageTile => ({
      label: tile.label,
      state: tile.state as CoverageTile["state"],
      // Generated column, nullable only in the generated types.
      area_km2: tile.area_km2 ?? 0,
      depth: tile.depth,
    })),
    target,
    leadsFound: search?.leads_found ?? 0,
  });
}

async function finish(
  db: AdminDb,
  searchId: string,
  workerId: string,
  status: SearchTerminalStatus,
  stopReason: string,
  lastError: string | null,
): Promise<void> {
  await db.rpc("recompute_search_progress", { p_search: searchId });
  await db.rpc("release_job", {
    p_search: searchId,
    p_worker: workerId,
    p_status: status,
    p_stop_reason: stopReason,
    p_last_error: lastError ?? undefined,
  });
}
