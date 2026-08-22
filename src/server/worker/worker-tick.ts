import "server-only";

import { getSupabaseAdminClient } from "@/server/db/admin";
import { getServerEnv } from "@/server/config/env";
import { SEARCH_LIMITS } from "@/server/search/limits";
import { SearchBlockedError } from "@/server/search/preflight";
import { runControlledTick, type ControlledTickResult } from "@/server/search/run-controlled-tick";

/**
 * The durable worker.
 *
 * THE BROWSER IS NEVER THE WORKER. Closing the tab stops nothing and opening
 * one starts nothing; a search runs because pg_cron poked this endpoint or
 * because a person pressed Run. Both paths call exactly the same
 * `runControlledTick`, so there is no second implementation of the tick that
 * could drift from the first.
 *
 * What differs for the worker is only the SLICE: it hands itself a shorter
 * wall-clock budget (`WORKER_SLICE_MS`, 25s by default) than the manual route
 * takes, because pg_net's HTTP call has its own timeout and a tick that outlives
 * it would be reported as failed while still running. Every option it passes is
 * clamped by `SEARCH_LIMITS` on the way in, so the worker can lower a limit and
 * can never raise one.
 *
 * ---------------------------------------------------------------------------
 * THIS IS OFF.
 *
 * `private.worker_config.enabled` is false, and `worker_url` and
 * `worker_secret` are unset. `dispatch_worker_tick()` returns immediately
 * without making an HTTP call while any of those is true, so the three cron
 * jobs that exist run and do nothing.
 *
 * Nothing in this application turns it on. `private` is unreachable through
 * PostgREST, so the switch cannot be flipped by any application path at all --
 * enabling it is a deliberate SQL statement run by the owner. See
 * docs/worker-activation.md.
 * ---------------------------------------------------------------------------
 */

export type WorkerTickResult = {
  /** Null when there was nothing runnable -- the common, idle case. */
  searchId: string | null;
  outcome: string;
  stopReason: string | null;
  tilesProcessed: number;
  apiCalls: number;
  leadsInserted: number;
  durationMs: number;
  /** Set when the run was refused by the pre-flight rather than failing. */
  blocked: string | null;
};

const IDLE: Omit<WorkerTickResult, "durationMs"> = {
  searchId: null,
  outcome: "idle",
  stopReason: null,
  tilesProcessed: 0,
  apiCalls: 0,
  leadsInserted: 0,
  blocked: null,
};

/**
 * The next search owed work.
 *
 * Deliberately a SELECT, not `claim_search_job`. `runControlledTick` owns the
 * lease protocol end to end -- it claims, heartbeats and releases -- and having
 * the worker claim first would mean two different functions holding opinions
 * about the same lease. Losing a race here is harmless: the claim inside the
 * tick is the atomic guard, and it simply returns no row.
 *
 * `queued` before `running` by `queued_at` mirrors `claim_search_job`'s
 * ordering so the two agree about what "next" means.
 */
async function findRunnableSearch(
  db: ReturnType<typeof getSupabaseAdminClient>,
  leaseSeconds: number,
): Promise<{ id: string; user_id: string } | null> {
  const staleBefore = new Date(Date.now() - leaseSeconds * 1000).toISOString();

  const { data, error } = await db
    .from("searches")
    .select("id, user_id, status, locked_at, heartbeat_at, queued_at")
    .in("status", ["queued", "running"])
    .or(`locked_at.is.null,heartbeat_at.is.null,heartbeat_at.lt.${staleBefore}`)
    .order("queued_at", { ascending: true, nullsFirst: false })
    .limit(1);

  if (error) throw new Error(`Could not look for runnable searches: ${error.message}`);

  const row = data?.[0];
  return row ? { id: row.id, user_id: row.user_id } : null;
}

export async function runWorkerTick(
  options: { now?: () => number } = {},
): Promise<WorkerTickResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const env = getServerEnv();
  const db = getSupabaseAdminClient();

  const candidate = await findRunnableSearch(db, env.WORKER_LEASE_SECONDS);

  if (!candidate) {
    return { ...IDLE, durationMs: now() - startedAt };
  }

  let result: ControlledTickResult;
  try {
    result = await runControlledTick(
      { searchId: candidate.id, userId: candidate.user_id },
      {
        leaseSeconds: env.WORKER_LEASE_SECONDS,
        // Both clamped by SEARCH_LIMITS inside the runner. The worker's job is
        // to take a SMALLER bite than the manual route, never a larger one.
        maxTilesPerTick: Math.min(env.WORKER_MAX_TILES_PER_TICK, SEARCH_LIMITS.maxTilesPerTick),
        maxTickMs: Math.min(env.WORKER_SLICE_MS, SEARCH_LIMITS.maxTickMs),
      },
    );
  } catch (error) {
    // A blocked pre-flight is a REFUSAL, not a failure: the pricing gate, the
    // call budget or the free allowance said no, and nothing was spent, leased
    // or mutated. The worker must not treat it as an error to retry hard --
    // the next cron tick will find the same answer until a person changes
    // something.
    if (error instanceof SearchBlockedError) {
      return {
        searchId: candidate.id,
        outcome: "blocked",
        stopReason: null,
        tilesProcessed: 0,
        apiCalls: 0,
        leadsInserted: 0,
        durationMs: now() - startedAt,
        blocked: error.block.code,
      };
    }

    throw error;
  }

  return {
    searchId: result.searchId,
    outcome: result.outcome,
    stopReason: result.stopReason,
    tilesProcessed: result.tiles.length,
    apiCalls: result.apiCalls,
    leadsInserted: result.leadsInserted,
    durationMs: now() - startedAt,
    blocked: null,
  };
}
