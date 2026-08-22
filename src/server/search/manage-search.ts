import "server-only";

import { DEFAULT_GRID_CONFIG } from "@/lib/constants";
import type { Json } from "@/lib/database.types";
import { getSupabaseAdminClient } from "@/server/db/admin";

import { logSearchEvent } from "./events";

/**
 * Lifecycle control for a search: pause, resume, cancel, delete, and the one
 * amendment the frozen `grid_config` is allowed to receive.
 *
 * None of these makes a Google request. They move a row between states and
 * record why; the spending decisions all live behind the pre-flight and the
 * quota guard, which these functions never touch.
 *
 * PAUSE AND CANCEL ARE COOPERATIVE. A tick may be mid-flight holding the lease,
 * and killing it would leave a tile `in_progress` and a lease to expire. So
 * these functions only write the status, and the running tick notices it
 * between tiles and stops cleanly. A tick that has already finished sees
 * nothing and the status simply stands.
 *
 * Ownership is checked explicitly on every call: the service-role client
 * bypasses RLS, so `user_id` is part of every predicate rather than assumed.
 */

type AdminDb = ReturnType<typeof getSupabaseAdminClient>;

export type SearchAction = "pause" | "resume" | "cancel";

export class SearchActionError extends Error {
  readonly status: number;

  constructor(message: string, status = 409) {
    super(message);
    this.name = "SearchActionError";
    this.status = status;
  }
}

export type SearchActionResult = {
  searchId: string;
  action: SearchAction | "delete" | "amend-stop-policy";
  previousStatus: string;
  status: string;
  message: string;
};

async function loadOwned(db: AdminDb, searchId: string, userId: string) {
  const { data, error } = await db
    .from("searches")
    .select("id, status, label, niche, grid_config, leads_found, target_leads, tiles_pending")
    .eq("id", searchId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw new Error(`Could not load the search: ${error.message}`);
  if (!data) throw new SearchActionError("Search not found.", 404);

  return data;
}

/** Statuses a search can no longer be moved out of. */
const TERMINAL: readonly string[] = ["completed", "canceled"];

export async function applySearchAction(
  args: { searchId: string; userId: string; action: SearchAction },
  db: AdminDb = getSupabaseAdminClient(),
): Promise<SearchActionResult> {
  const search = await loadOwned(db, args.searchId, args.userId);
  const previousStatus = search.status;

  switch (args.action) {
    case "pause": {
      if (!["queued", "running"].includes(previousStatus)) {
        throw new SearchActionError(
          `Only a queued or running search can be paused. This one is ${previousStatus}.`,
        );
      }

      // The lease is deliberately NOT cleared. If a tick holds it, that tick
      // owns the release; clearing it here would let a second runner start
      // while the first is still mid-request, which is the one thing that could
      // bill Google twice for a tile.
      await db
        .from("searches")
        .update({ status: "paused", stop_reason: "paused_by_user", status_text: null })
        .eq("id", args.searchId)
        .eq("user_id", args.userId);

      await logSearchEvent(db, {
        searchId: args.searchId,
        level: "info",
        code: "search_paused",
        message:
          "Paused by the user. Any tick in flight stops between tiles; the pending geography is untouched and resumes on the next run.",
        meta: { previous_status: previousStatus, api_calls_made: 0 },
      });

      return {
        searchId: args.searchId,
        action: "pause",
        previousStatus,
        status: "paused",
        message: "Search paused. Nothing was lost — press Run to continue where it stopped.",
      };
    }

    case "resume": {
      if (!["paused", "failed", "draft"].includes(previousStatus)) {
        throw new SearchActionError(
          `Only a paused, failed or draft search can be resumed. This one is ${previousStatus}.`,
        );
      }

      // Resume makes the search RUNNABLE. It does not run it: spending is
      // always a separate, explicit act.
      await db
        .from("searches")
        .update({
          status: "queued",
          queued_at: new Date().toISOString(),
          stop_reason: null,
          last_error: null,
        })
        .eq("id", args.searchId)
        .eq("user_id", args.userId);

      await logSearchEvent(db, {
        searchId: args.searchId,
        level: "info",
        code: "search_resumed",
        message: "Returned to the queue. No Google request has been made by this action.",
        meta: { previous_status: previousStatus, api_calls_made: 0 },
      });

      return {
        searchId: args.searchId,
        action: "resume",
        previousStatus,
        status: "queued",
        message: "Search queued. Press Run to continue searching the remaining tiles.",
      };
    }

    case "cancel": {
      if (TERMINAL.includes(previousStatus)) {
        throw new SearchActionError(`This search is already ${previousStatus}.`);
      }

      // Pending tiles are left PENDING rather than rewritten to some cancelled
      // state. The tile rows are the record of what the area needed; a cancel
      // abandons the run, it does not pretend the geography was accounted for.
      // The coverage report therefore keeps reporting the gap honestly.
      await db
        .from("searches")
        .update({
          status: "canceled",
          stop_reason: "canceled_by_user",
          status_text: null,
          finished_at: new Date().toISOString(),
        })
        .eq("id", args.searchId)
        .eq("user_id", args.userId);

      await logSearchEvent(db, {
        searchId: args.searchId,
        level: "warn",
        code: "search_canceled",
        message:
          `Canceled by the user with ${search.tiles_pending} tile(s) still pending. ` +
          "The leads already collected are kept; the unsearched area stays visible as a gap.",
        meta: {
          previous_status: previousStatus,
          tiles_pending: search.tiles_pending,
          leads_found: search.leads_found,
          api_calls_made: 0,
        },
      });

      return {
        searchId: args.searchId,
        action: "cancel",
        previousStatus,
        status: "canceled",
        message: "Search canceled. Collected leads are kept.",
      };
    }
  }
}

/**
 * The ONE amendment a frozen `grid_config` may receive.
 *
 * `grid_config` is frozen at creation because it describes the geometry every
 * cost estimate was made from, and rewriting geometry under a half-searched
 * grid would invalidate both. The stop POLICY is not geometry: as of
 * 2026-08-22 the lead target is a benchmark rather than a termination
 * condition, and searches created before that date carry
 * `stopOnTargetReached: true` in a row that can no longer be re-created.
 *
 * Honouring those rows literally would strand them -- they would stop at the
 * target forever with tiles still owed. Rewriting them automatically would
 * silently rewrite history. So this exists instead: an explicit, user-triggered
 * amendment that changes exactly one boolean, leaves the geometry and every
 * collected lead untouched, and appends an event saying it happened.
 *
 * It is never called from a migration, a tick, or any automatic path.
 */
export async function amendStopPolicy(
  args: { searchId: string; userId: string },
  db: AdminDb = getSupabaseAdminClient(),
): Promise<SearchActionResult> {
  const search = await loadOwned(db, args.searchId, args.userId);

  const raw =
    search.grid_config &&
    typeof search.grid_config === "object" &&
    !Array.isArray(search.grid_config)
      ? (search.grid_config as Record<string, unknown>)
      : {};

  const previous = typeof raw.stopOnTargetReached === "boolean" ? raw.stopOnTargetReached : true;

  if (previous === false) {
    throw new SearchActionError(
      "This search already runs to full coverage; the lead target does not stop it.",
      422,
    );
  }

  // Exactly one key changes. Everything else in the frozen config is copied
  // through untouched, including the geometry the tiles were laid out from.
  const amended: Record<string, unknown> = {
    ...raw,
    stopOnTargetReached: false,
    stopPolicyAmendedAt: new Date().toISOString(),
  };

  const { error } = await db
    .from("searches")
    .update({ grid_config: amended as Json })
    .eq("id", args.searchId)
    .eq("user_id", args.userId);

  if (error) throw new Error(`Could not amend the stop policy: ${error.message}`);

  await logSearchEvent(db, {
    searchId: args.searchId,
    level: "info",
    code: "stop_policy_amended",
    message:
      "Stop policy amended: the lead target no longer ends this search. It now runs until the " +
      "requested area is fully covered or another terminal condition occurs. Geometry and " +
      "collected leads are unchanged.",
    meta: {
      previous_stop_on_target_reached: previous,
      stop_on_target_reached: false,
      leads_found: search.leads_found,
      target_leads: search.target_leads,
      tiles_pending: search.tiles_pending,
      default_stop_on_target_reached: DEFAULT_GRID_CONFIG.stopOnTargetReached,
      api_calls_made: 0,
    },
  });

  return {
    searchId: args.searchId,
    action: "amend-stop-policy",
    previousStatus: search.status,
    status: search.status,
    message:
      "This search will now continue to full coverage. Press Run to search the remaining tiles.",
  };
}

/**
 * Hard-deletes a search.
 *
 * Cascades to `search_tiles`, `tile_events`, `search_events` and `leads`. It
 * deliberately does NOT cascade to `api_call_log`, `api_usage_counters`,
 * `places_seen` or `exports` -- those keep a null `search_id` instead, because
 * the billing record of a call that was really made must outlive the row that
 * caused it. Deleting a search never makes the month's usage look smaller.
 */
export async function deleteSearch(
  args: { searchId: string; userId: string },
  db: AdminDb = getSupabaseAdminClient(),
): Promise<{ searchId: string; label: string; leadsDeleted: number }> {
  const search = await loadOwned(db, args.searchId, args.userId);

  if (search.status === "running") {
    throw new SearchActionError(
      "This search is running. Pause or cancel it first — deleting it mid-tick would strand the worker lease.",
    );
  }

  const { count } = await db
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("search_id", args.searchId);

  const { error } = await db
    .from("searches")
    .delete()
    .eq("id", args.searchId)
    .eq("user_id", args.userId);

  if (error) throw new Error(`Could not delete the search: ${error.message}`);

  return { searchId: args.searchId, label: search.label, leadsDeleted: count ?? 0 };
}
