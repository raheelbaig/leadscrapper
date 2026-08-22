import "server-only";

/**
 * When a search is allowed to call itself finished.
 *
 * This is the product's central rule, so it lives in its own module and is
 * tested on its own rather than being three lines buried in a 900-line runner.
 *
 * THE LEAD TARGET IS A MINIMUM DESIRED BENCHMARK. It is not a termination
 * condition. A search that wanted 40 leads and has found 87 with tiles still
 * pending has exceeded its benchmark and is NOT finished; it keeps working. The
 * only terminal success is complete geographic coverage.
 *
 * The Phase 3B behaviour this replaces produced a search that reported
 * `completed / target_reached` having searched 83% of its rectangle. Every
 * decision made from that lead list inherited the claim that the area had been
 * done. That is the failure mode these functions exist to make impossible.
 */

export type TickOutcome =
  | "completed"
  | "paused-tile-limit"
  | "paused-call-budget"
  | "paused-time-limit"
  | "paused-quota"
  | "paused-tile-error"
  | "paused-by-user"
  | "canceled"
  | "failed"
  | "nothing-to-do";

/**
 * Why this tick stopped.
 *
 * `target_reached` is deliberately ABSENT and must stay absent. The safety
 * envelope greps the whole source tree for that identifier.
 *
 * `stopped_at_target` is not a reintroduction of it. It exists only for
 * searches created before 2026-08-22, whose frozen `grid_config` still carries
 * the old policy, and it maps to `paused` -- never to `completed` -- because
 * the geography those runs skipped is genuinely still owed.
 */
export type TickStopReason =
  | "coverage_complete"
  | "tile_budget_reached"
  | "call_budget_reached"
  | "tick_slice_expired"
  | "quota_exhausted"
  | "tile_error"
  | "fatal_api_error"
  | "lease_lost"
  | "paused_by_user"
  | "canceled"
  | "stopped_at_target";

export type SearchTerminalStatus = "completed" | "paused" | "failed" | "canceled";

/**
 * The status written to `searches.status` when the tick releases its lease.
 *
 * `coverage_complete` is the ONLY reason that yields `completed`. Every other
 * ending leaves geography owed, and a search with geography owed is paused --
 * however many leads it found.
 */
export function finalStatus(stop: TickStopReason): SearchTerminalStatus {
  if (stop === "fatal_api_error") return "failed";
  if (stop === "canceled") return "canceled";
  if (stop === "coverage_complete") return "completed";
  return "paused";
}

/** The shape the UI reports, one step more specific than the status. */
export function finalOutcome(stop: TickStopReason, tilesProcessed: number): TickOutcome {
  switch (stop) {
    case "coverage_complete":
      return tilesProcessed === 0 ? "nothing-to-do" : "completed";
    case "quota_exhausted":
      return "paused-quota";
    case "call_budget_reached":
      return "paused-call-budget";
    case "tile_budget_reached":
    case "lease_lost":
      return "paused-tile-limit";
    case "tick_slice_expired":
      return "paused-time-limit";
    case "tile_error":
      return "paused-tile-error";
    case "paused_by_user":
    case "stopped_at_target":
      return "paused-by-user";
    case "canceled":
      return "canceled";
    case "fatal_api_error":
      return "failed";
  }
}

/**
 * Whether the tile loop should keep going.
 *
 * Extracted so the ordering of the guards is testable without a database. The
 * order matters: a run that has lost its lease or been cancelled must stop
 * before it spends anything, and the per-SEARCH budget is checked before the
 * per-tick one because it is cumulative across every resume.
 *
 * There is no clause here for the lead target. That is the point.
 */
export function nextStopReason(state: {
  /** Frozen policy from `grid_config`; true only for pre-2026-08-22 rows. */
  stopOnTargetReached: boolean;
  leadsFound: number;
  targetLeads: number;
  /** Live status re-read from the row each iteration. */
  status: string;
  callsRemainingInSearch: number;
  callsThisTick: number;
  maxCallsPerTick: number;
  tilesThisTick: number;
  maxTilesPerTick: number;
  elapsedMs: number;
  maxTickMs: number;
}): TickStopReason | null {
  if (state.stopOnTargetReached && state.leadsFound >= state.targetLeads) {
    return "stopped_at_target";
  }
  if (state.status === "paused") return "paused_by_user";
  if (state.status === "canceled") return "canceled";
  if (state.callsRemainingInSearch <= 0) return "call_budget_reached";
  if (state.callsThisTick >= state.maxCallsPerTick) return "call_budget_reached";
  if (state.tilesThisTick >= state.maxTilesPerTick) return "tile_budget_reached";
  if (state.elapsedMs >= state.maxTickMs) return "tick_slice_expired";

  return null;
}
