import "server-only";

import { randomUUID } from "node:crypto";

import { RESULT_CEILING } from "@/lib/constants";
import type { Json } from "@/lib/database.types";
import type { BoundingBox } from "@/lib/geo/bbox";
import { getSupabaseAdminClient } from "@/server/db/admin";
import { mapPlaces } from "@/server/places/lead-mapper";

import { claimSearchById } from "./claim";
import { logSearchEvent } from "./events";
import { PHASE_3A_LIMITS } from "./limits";
import { runPreflight, SearchBlockedError, type PreflightResult } from "./preflight";
import { fetchTilePage, type FetchTilePageOptions } from "./tile-runner";

/**
 * ONE bounded, manually triggered tick of the real pipeline.
 *
 * This is the Phase 3A runner: claim -> one tile -> one page -> map -> dedupe
 * insert -> classify -> release. It is deliberately not the full worker. There
 * is no pagination to pages 2 and 3, no subdivision, and no loop over tiles;
 * those arrive in Phase 3B once this path is known to work against the real API.
 *
 * The order of the first two steps matters and is not an accident:
 *
 *   1. PRE-FLIGHT, before anything is claimed or mutated. A run blocked by the
 *      pricing gate must leave no lease to expire, no tile in `in_progress`,
 *      and no status to clean up -- it simply never started.
 *   2. CLAIM, which is the mutual-exclusion primitive. Two runners holding the
 *      same search is the only way this design could bill Google twice for one
 *      tile, so nothing after this point runs without the lease.
 *
 * Everything that matters is persisted as it happens. A tick that dies at any
 * point loses at most the single in-flight page, and the tile returns to
 * `pending` on the next run rather than being recorded as covered.
 */

export type TickOutcome =
  | "completed"
  | "paused-page-limit"
  | "paused-quota"
  | "failed"
  | "nothing-to-do";

export type ControlledTickResult = {
  outcome: TickOutcome;
  searchId: string;
  tileId: string | null;
  tileLabel: string | null;
  tileState: string | null;
  searchStatus: string;
  /** Billable Google calls made by this tick. */
  apiCalls: number;
  /** Places in the Google response. */
  resultsReceived: number;
  /** Rows the database accepted as genuinely new. */
  leadsInserted: number;
  /** Rows the unique constraint rejected as already present. */
  duplicatesRejected: number;
  /** Places dropped before insert, e.g. no displayName. */
  placesRejected: number;
  nextPageTokenPresent: boolean;
  preflight: PreflightResult;
  error: string | null;
};

export type RunControlledTickOptions = FetchTilePageOptions & {
  /** Overrides the worker identity; defaults to a fresh uuid per tick. */
  workerId?: string;
  leaseSeconds?: number;
};

type AdminDb = ReturnType<typeof getSupabaseAdminClient>;

export async function runControlledTick(
  args: { searchId: string; userId: string },
  options: RunControlledTickOptions = {},
): Promise<ControlledTickResult> {
  const db = getSupabaseAdminClient();
  const workerId = options.workerId ?? randomUUID();
  const leaseSeconds = options.leaseSeconds ?? 90;

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

  // -----------------------------------------------------------------------
  // 1. PRE-FLIGHT. Before the lease, before any mutation.
  // -----------------------------------------------------------------------
  const preflight = await runPreflight({ db });

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
        api_calls_made: 0,
      },
    });

    throw new SearchBlockedError(preflight);
  }

  // -----------------------------------------------------------------------
  // 2. Make the search claimable, then claim it.
  // -----------------------------------------------------------------------
  if (search.status === "draft" || search.status === "paused") {
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

  const base: ControlledTickResult = {
    outcome: "nothing-to-do",
    searchId: args.searchId,
    tileId: null,
    tileLabel: null,
    tileState: null,
    searchStatus: "running",
    apiCalls: 0,
    resultsReceived: 0,
    leadsInserted: 0,
    duplicatesRejected: 0,
    placesRejected: 0,
    nextPageTokenPresent: false,
    preflight,
    error: null,
  };

  try {
    // A dead process cannot have completed a tile. Any tile left `in_progress`
    // by an interrupted run goes back to `pending`, and its page token is
    // dropped because tokens expire -- the tile restarts at page 1.
    await db.rpc("recover_stalled_tiles", { p_search: args.searchId });

    const { data: tile } = await db
      .from("search_tiles")
      .select("*")
      .eq("search_id", args.searchId)
      .eq("state", "pending")
      .order("path", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (!tile) {
      await finish(db, args.searchId, workerId, "completed", "coverage_complete", null);
      await logSearchEvent(db, {
        searchId: args.searchId,
        level: "info",
        code: "nothing_to_do",
        message: "No pending tiles remain.",
      });
      return { ...base, outcome: "nothing-to-do", searchStatus: "completed" };
    }

    const bbox: BoundingBox = {
      minLat: tile.min_lat,
      minLng: tile.min_lng,
      maxLat: tile.max_lat,
      maxLng: tile.max_lng,
    };

    // pending -> in_progress. The transition trigger rejects anything illegal,
    // and the event trigger writes the tile_events row for free.
    await db
      .from("search_tiles")
      .update({
        state: "in_progress",
        last_reason: "claimed by controlled tick",
        started_at: new Date().toISOString(),
        attempts: tile.attempts + 1,
      })
      .eq("id", tile.id)
      .eq("state", "pending");

    await db.rpc("heartbeat_job", {
      p_search: args.searchId,
      p_worker: workerId,
      p_status_text: "Fetching Google Places…",
      p_current_tile: tile.id,
      p_current_page: 1,
    });

    await logSearchEvent(db, {
      searchId: args.searchId,
      level: "info",
      code: "tile_started",
      message: `${tile.label}: requesting page 1 for “${search.query_text}”`,
      meta: { tile_id: tile.id, bbox, page: 1 },
    });

    // -------------------------------------------------------------------
    // 3. The billable step. Reserve -> request -> record, per attempt.
    // -------------------------------------------------------------------
    const page = await fetchTilePage(
      {
        sku: search.search_sku,
        searchId: args.searchId,
        tileId: tile.id,
        textQuery: search.query_text,
        bbox,
        pageIndex: 0,
      },
      { ...options, db },
    );

    if (page.kind === "quota-denied") {
      await db
        .from("search_tiles")
        .update({
          state: "skipped_quota",
          last_reason: "budget guard denied the reservation",
          api_calls: tile.api_calls + page.callsMade,
          completed_at: new Date().toISOString(),
        })
        .eq("id", tile.id);

      await logSearchEvent(db, {
        searchId: args.searchId,
        level: "warn",
        code: "quota_denied",
        message: `FREE PLAN LIMIT REACHED — ${tile.label} was not searched. ${page.remaining} calls remain in ${page.period}.`,
        meta: { tile_id: tile.id, remaining: page.remaining, api_calls_made: page.callsMade },
      });

      await finish(db, args.searchId, workerId, "paused", "quota_exhausted", null);
      return {
        ...base,
        outcome: "paused-quota",
        tileId: tile.id,
        tileLabel: tile.label,
        tileState: "skipped_quota",
        searchStatus: "paused",
        apiCalls: page.callsMade,
      };
    }

    if (page.kind === "error") {
      // R1: an API error after bounded retries. The tile is `failed`, which is
      // NOT terminal -- it returns to pending on resume, so the area is still
      // owed work rather than being silently written off.
      await db
        .from("search_tiles")
        .update({
          state: "failed",
          last_reason: page.error.logMessage.slice(0, 500),
          last_error: page.error.logMessage.slice(0, 500),
          api_calls: tile.api_calls + page.callsMade,
          pages_fetched: tile.pages_fetched,
          completed_at: new Date().toISOString(),
        })
        .eq("id", tile.id);

      await logSearchEvent(db, {
        searchId: args.searchId,
        level: "error",
        code: "tile_failed",
        message: `${tile.label}: ${page.error.logMessage}`,
        meta: {
          tile_id: tile.id,
          http_status: page.error.status,
          google_status: page.error.googleStatus,
          kind: page.error.kind,
          retryable: page.error.retryable,
          attempts: page.attempts,
          api_calls_made: page.callsMade,
        },
      });

      await finish(db, args.searchId, workerId, "failed", "tile_error", page.error.logMessage);
      return {
        ...base,
        outcome: "failed",
        tileId: tile.id,
        tileLabel: tile.label,
        tileState: "failed",
        searchStatus: "failed",
        apiCalls: page.callsMade,
        error: page.error.logMessage,
      };
    }

    // -------------------------------------------------------------------
    // 4. Map and insert. Deduplication is the database's unique constraint on
    //    (search_id, place_id) -- never an in-memory Set, which would not
    //    survive a crash, a resume, or two ticks running back to back.
    // -------------------------------------------------------------------
    const places = page.response.places;
    const mapped = mapPlaces(places, { tileLabel: tile.label, queryText: search.query_text });

    let inserted = 0;
    let received = 0;

    if (mapped.leads.length > 0) {
      const { data: insertResult, error: insertError } = await db.rpc("insert_leads_dedup", {
        p_search: args.searchId,
        p_tile: tile.id,
        p_leads: mapped.leads as unknown as Json,
      });

      if (insertError) {
        throw new Error(`insert_leads_dedup failed: ${insertError.message}`);
      }

      const row = Array.isArray(insertResult) ? insertResult[0] : null;
      inserted = row?.inserted ?? 0;
      received = row?.received ?? mapped.leads.length;
    }

    const duplicatesRejected = Math.max(mapped.leads.length - inserted, 0);
    const hasToken = Boolean(page.response.nextPageToken);

    if (mapped.rejected.length > 0) {
      await logSearchEvent(db, {
        searchId: args.searchId,
        level: "warn",
        code: "places_rejected",
        message: `${mapped.rejected.length} place(s) had no usable name and were not stored.`,
        meta: { tile_id: tile.id, rejected: mapped.rejected },
      });
    }

    // -------------------------------------------------------------------
    // 5. Classify the tile.
    //
    // Phase 3A can reach only three of the five outcomes, because it fetches a
    // single page and cannot subdivide:
    //
    //   R2  zero results        -> empty          (verified coverage)
    //   R3  results, no token   -> covered        (Google had nothing more)
    //   --  results + a token   -> back to PENDING
    //
    // That last case is the honest one. A tile with a page token has more
    // results waiting, so it is NOT covered; and it is not `saturated_floor`
    // either, because that state means a permanent gap at the size floor and
    // this is neither permanent nor at the floor. Returning it to `pending`
    // keeps the coverage debt visible and lets Phase 3B pick it up exactly
    // where this run stopped.
    // -------------------------------------------------------------------
    const resultsCount = places.length;
    const saturated = resultsCount >= RESULT_CEILING;

    let nextState: "empty" | "covered" | "pending";
    let reason: string;

    if (resultsCount === 0) {
      nextState = "empty";
      reason = "R2: verified empty — Google returned no places for this rectangle";
    } else if (!hasToken) {
      nextState = "covered";
      reason = "R3: covered — Google returned no further page token";
    } else {
      nextState = "pending";
      reason = `Phase 3A single-page limit: a page token remains, so ${saturated ? "the tile is saturated and " : ""}pages 2-3 are still owed`;
    }

    await db
      .from("search_tiles")
      .update({
        state: nextState,
        last_reason: reason,
        results_count: resultsCount,
        pages_fetched: tile.pages_fetched + 1,
        token_after_last: hasToken,
        // Tokens expire quickly. Storing one that will be stale by the next run
        // would make the tile restart from a token Google has forgotten, so the
        // tile restarts at page 1 instead.
        next_page_token: null,
        api_calls: tile.api_calls + page.callsMade,
        completed_at: nextState === "pending" ? null : new Date().toISOString(),
        started_at: nextState === "pending" ? null : tile.started_at,
      })
      .eq("id", tile.id);

    await db.rpc("recompute_search_progress", { p_search: args.searchId });

    await logSearchEvent(db, {
      searchId: args.searchId,
      level: "info",
      code: `tile_${nextState}`,
      message:
        `${tile.label}: ${resultsCount} result(s), ${inserted} new lead(s)` +
        (duplicatesRejected > 0 ? `, ${duplicatesRejected} duplicate(s) rejected by the database` : "") +
        `. ${reason}`,
      meta: {
        tile_id: tile.id,
        results_count: resultsCount,
        received,
        inserted,
        duplicates_rejected: duplicatesRejected,
        next_page_token_present: hasToken,
        api_calls_made: page.callsMade,
        http_status: page.httpStatus,
        duration_ms: page.durationMs,
        pages_fetched: tile.pages_fetched + 1,
        max_pages_this_phase: PHASE_3A_LIMITS.maxPagesPerTile,
      },
    });

    // -------------------------------------------------------------------
    // 6. Decide how the run ends, then release the lease.
    // -------------------------------------------------------------------
    const { data: progress } = await db
      .from("searches")
      .select("leads_found, target_leads, tiles_pending")
      .eq("id", args.searchId)
      .maybeSingle();

    const leadsFound = progress?.leads_found ?? inserted;
    const targetReached = leadsFound >= (progress?.target_leads ?? search.target_leads);
    const pendingRemain = (progress?.tiles_pending ?? 0) > 0;

    let outcome: TickOutcome;
    let status: "completed" | "paused";
    let stopReason: string;

    if (targetReached) {
      outcome = "completed";
      status = "completed";
      stopReason = "target_reached";
    } else if (pendingRemain) {
      // Not a failure: the phase's own page limit stopped it, and the report
      // has to say exactly that rather than implying the area is exhausted.
      outcome = "paused-page-limit";
      status = "paused";
      stopReason = "phase_3a_single_page_limit";
    } else {
      outcome = "completed";
      status = "completed";
      stopReason = "coverage_complete";
    }

    await db.rpc("verify_search_coverage", { p_search: args.searchId });
    await finish(db, args.searchId, workerId, status, stopReason, null);

    return {
      ...base,
      outcome,
      tileId: tile.id,
      tileLabel: tile.label,
      tileState: nextState,
      searchStatus: status,
      apiCalls: page.callsMade,
      resultsReceived: resultsCount,
      leadsInserted: inserted,
      duplicatesRejected,
      placesRejected: mapped.rejected.length,
      nextPageTokenPresent: hasToken,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await logSearchEvent(db, {
      searchId: args.searchId,
      level: "error",
      code: "tick_failed",
      message: `The controlled run stopped: ${message}`,
    });

    // Always release the lease. A held lease would block every later attempt
    // until it expired, and the tile is returned to pending by
    // recover_stalled_tiles on the next run.
    await finish(db, args.searchId, workerId, "failed", "tick_error", message);
    throw error;
  }
}

async function finish(
  db: AdminDb,
  searchId: string,
  workerId: string,
  status: "completed" | "paused" | "failed",
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
