import "server-only";

import type { CreateSearchValues } from "@/lib/schemas/search";
import type { GenerationState, GenerationStopReason } from "@/lib/generate/types";
import { getSupabaseAdminClient } from "@/server/db/admin";
import { runEnrichment as runEnrichmentService } from "@/server/enrichment/run-enrichment";
import { QuotaBlockedError } from "@/server/quota/quota-service";
import { ClaimError } from "@/server/search/claim";
import { createSearch, type CreateSearchResult } from "@/server/search/create-search";
import { logSearchEvent } from "@/server/search/events";
import { runPreflight, SearchBlockedError, type PreflightResult } from "@/server/search/preflight";
import { runControlledTick, type ControlledTickResult } from "@/server/search/run-controlled-tick";

import { areasAllowedThisAdvance, callsUsedByRun, GENERATION_LIMITS } from "./limits";
import {
  buildGenerationState,
  GenerationNotFoundError,
  loadRun,
  type GenerationRunRow,
} from "./state";

/**
 * The one-button flow's orchestration layer.
 *
 * ---------------------------------------------------------------------------
 * THIS MODULE COORDINATES. IT DOES NOT IMPLEMENT.
 *
 * Every unit of real work here is a call into a service that already existed
 * and is already tested: `createSearch`, `runControlledTick`, `runEnrichment`.
 * There is no second search loop, no second quota check, no second enrichment
 * policy and no second definition of when a search is complete. What this file
 * adds is the part the MVP genuinely lacked -- a record of one approval, a
 * phase machine that walks Searching -> Finding emails -> Ready, and a ceiling
 * on what one press may spend.
 *
 * It is also the ONLY place allowed to touch both `@/server/search/**` and
 * `@/server/enrichment/**`. The ESLint boundary that keeps email discovery out
 * of the Places loop is narrowed to exempt this directory alone.
 * ---------------------------------------------------------------------------
 *
 * THE BROWSER IS NOT THE WORKER. It calls `advanceGenerationRun` and renders
 * what comes back; it never reaches Google or a business website, never decides
 * a budget, and never holds a fact the database does not. Closing the tab stops
 * the ASKING, and the run stays exactly where Postgres says it is -- resumable,
 * with its remaining geography still visibly owed. The UI says so rather than
 * implying the work continues on its own.
 */

/** Injection points, so a test can advance a run without spending anything. */
export type AdvanceDependencies = {
  runTick?: typeof runControlledTick;
  runEnrichment?: typeof runEnrichmentService;
  /**
   * Passed to `runEnrichment` for a LIVE run. `runEnrichment` throws rather
   * than guessing one, so omitting it cannot accidentally reach the network.
   */
  enrichmentFetch?: typeof globalThis.fetch;
  now?: () => number;
};

type AdminDb = ReturnType<typeof getSupabaseAdminClient>;

function nowIso(now: () => number): string {
  return new Date(now()).toISOString();
}

// ---------------------------------------------------------------------------
// Creating an approval
// ---------------------------------------------------------------------------

export type CreateGenerationInput = CreateSearchValues & {
  /**
   * Whether the user approved this application fetching pages from the leads'
   * own websites. Recorded as a TIMESTAMP, not a boolean, so the row says when
   * consent was given rather than merely that it was.
   */
  enrichEmails: boolean;
};

export type CreateGenerationResult = {
  runId: string;
  searchId: string;
  search: CreateSearchResult;
  preflight: PreflightResult;
};

/**
 * Creates the search, its full seed grid, and the approval that governs it.
 *
 * COSTS NOTHING. Planning is free and only searching bills, so the whole grid
 * and the whole approval exist before a single Google request is authorised.
 */
export async function createGenerationRun(
  input: CreateGenerationInput,
  context: { userId: string },
  options: { db?: AdminDb; now?: () => number } = {},
): Promise<CreateGenerationResult> {
  const db = options.db ?? getSupabaseAdminClient();
  const now = options.now ?? Date.now;

  const search = await createSearch(input, { userId: context.userId });

  const run = await insertRun(db, {
    userId: context.userId,
    searchId: search.searchId,
    // A brand-new search has spent nothing, but the watermark is read rather
    // than assumed -- the derivation must hold for a continuation too.
    apiCallsAtStart: 0,
    enrichEmails: input.enrichEmails,
    now,
  });

  // Quoted against the GENERATION ceiling, not the per-search budget, because
  // 30 is the number this press is authorising. The per-search and monthly
  // limits sit outside it and are reported separately by the UI.
  const preflight = await runPreflight({
    tiles: search.grid.tileCount,
    callBudget: GENERATION_LIMITS.maxGoogleCallsPerRun,
    callsAlreadySpent: 0,
  });

  await logSearchEvent(db, {
    searchId: search.searchId,
    level: "info",
    code: "generation_run_created",
    message:
      `Guided generation approved: at most ${GENERATION_LIMITS.maxGoogleCallsPerRun} Google call(s) ` +
      `for this run. Email discovery ${input.enrichEmails ? "consented" : "NOT consented"}. ` +
      `Nothing has been requested from Google.`,
    meta: {
      generation_run_id: run.id,
      call_ceiling: run.call_ceiling,
      enrichment_consented: input.enrichEmails,
      api_calls_made: 0,
    },
  });

  return { runId: run.id, searchId: search.searchId, search, preflight };
}

/**
 * A NEW approval over an existing search.
 *
 * This is what "Continue Generation" does, and it is deliberately a new row
 * rather than a raised ceiling: the previous approval was for 30 calls and it
 * was honoured. Continuing is a fresh decision with a fresh watermark, so the
 * next 30 are counted from where the last run stopped.
 */
export async function continueGenerationRun(
  args: { searchId: string; userId: string; enrichEmails: boolean },
  options: { db?: AdminDb; now?: () => number } = {},
): Promise<{ runId: string; preflight: PreflightResult }> {
  const db = options.db ?? getSupabaseAdminClient();
  const now = options.now ?? Date.now;

  const { data: search, error } = await db
    .from("searches")
    .select("id, api_calls_run, tiles_pending, status")
    .eq("id", args.searchId)
    .eq("user_id", args.userId)
    .maybeSingle();

  if (error) throw new Error(`Could not load the search: ${error.message}`);
  if (!search) throw new GenerationNotFoundError("That search could not be found.");

  const run = await insertRun(db, {
    userId: args.userId,
    searchId: args.searchId,
    // The watermark moves forward. Calls the previous approval spent belong to
    // it, not to this one.
    apiCallsAtStart: search.api_calls_run,
    enrichEmails: args.enrichEmails,
    now,
  });

  const preflight = await runPreflight({
    tiles: Math.max(search.tiles_pending, 1),
    callBudget: GENERATION_LIMITS.maxGoogleCallsPerRun,
    callsAlreadySpent: 0,
  });

  await logSearchEvent(db, {
    searchId: args.searchId,
    level: "info",
    code: "generation_run_continued",
    message:
      `A new generation approval was granted: at most ${GENERATION_LIMITS.maxGoogleCallsPerRun} ` +
      `further Google call(s). ${search.api_calls_run} call(s) already spent on this search are ` +
      `not counted against it.`,
    meta: {
      generation_run_id: run.id,
      api_calls_at_start: search.api_calls_run,
      call_ceiling: run.call_ceiling,
      api_calls_made: 0,
    },
  });

  return { runId: run.id, preflight };
}

async function insertRun(
  db: AdminDb,
  args: {
    userId: string;
    searchId: string;
    apiCallsAtStart: number;
    enrichEmails: boolean;
    now: () => number;
  },
): Promise<GenerationRunRow> {
  const { data, error } = await db
    .from("generation_runs")
    .insert({
      user_id: args.userId,
      search_id: args.searchId,
      status: "running",
      phase: "searching",
      // Read from the server constant. The request body is never consulted:
      // a ceiling the browser could set is not a ceiling.
      call_ceiling: GENERATION_LIMITS.maxGoogleCallsPerRun,
      api_calls_at_start: args.apiCallsAtStart,
      enrichment_consented_at: args.enrichEmails ? nowIso(args.now) : null,
    })
    .select("*")
    .single();

  if (error) {
    // The partial unique index refuses a second live approval for one search.
    if (error.code === "23505") {
      throw new GenerationConflictError(
        "This search already has a generation in progress. Open it rather than starting another.",
      );
    }
    throw new Error(`Could not create the generation run: ${error.message}`);
  }

  return data;
}

export class GenerationConflictError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = "GenerationConflictError";
  }
}

// ---------------------------------------------------------------------------
// Advancing
// ---------------------------------------------------------------------------

/**
 * ONE unit of work, chosen by the server.
 *
 * The client asks "please continue" and nothing more: it does not say which
 * phase, how many areas, how many leads, or what budget applies. Every one of
 * those is decided here from the run row and the database, which is what makes
 * the 30-call ceiling a server-side guarantee rather than a client-side
 * courtesy.
 */
export async function advanceGenerationRun(
  args: { runId: string; userId: string },
  deps: AdvanceDependencies & { db?: AdminDb } = {},
): Promise<GenerationState> {
  const db = deps.db ?? getSupabaseAdminClient();
  const now = deps.now ?? Date.now;

  const run = await loadRun(db, args);

  // Not running: nothing to do, and saying so is the whole answer. A stopped
  // run is a normal outcome, not an error.
  if (run.status !== "running") {
    return buildGenerationState(db, run, now);
  }

  if (run.phase === "ready") {
    const finished = await finishRun(db, run, "generation_complete", now);
    return buildGenerationState(db, finished, now);
  }

  if (run.phase === "searching") {
    return advanceSearchPhase(db, run, deps, now);
  }

  return advanceEnrichmentPhase(db, run, deps, now);
}

async function advanceSearchPhase(
  db: AdminDb,
  run: GenerationRunRow,
  deps: AdvanceDependencies,
  now: () => number,
): Promise<GenerationState> {
  const runTick = deps.runTick ?? runControlledTick;

  const { data: search, error } = await db
    .from("searches")
    .select("api_calls_run, tiles_pending")
    .eq("id", run.search_id)
    .maybeSingle();

  if (error) throw new Error(`Could not load the search: ${error.message}`);
  if (!search) throw new GenerationNotFoundError("The search behind this run no longer exists.");

  // Geography accounted for: hand over to email discovery.
  if (search.tiles_pending === 0) {
    const moved = await enterEnrichmentPhase(db, run, now);
    return buildGenerationState(db, moved, now);
  }

  // THE CEILING, enforced before anything is authorised.
  const ceiling = await stopIfCeilingReached(db, run, search.api_calls_run, now);
  if (ceiling) return buildGenerationState(db, ceiling, now);

  const areas = areasAllowedThisAdvance(
    run.call_ceiling -
      callsUsedByRun({
        searchApiCallsRun: search.api_calls_run,
        apiCallsAtStart: run.api_calls_at_start,
      }),
  );

  if (!run.search_started_at) {
    await patchRun(db, run.id, { search_started_at: nowIso(now) });
  }

  let tick: ControlledTickResult;
  try {
    // The ONLY option passed is a LOWER area cap. Every other limit is the
    // tick runner's own, and `Math.min(option ?? CAP, CAP)` means this can
    // narrow the slice and never widen it.
    tick = await runTick(
      { searchId: run.search_id, userId: run.user_id },
      { maxTilesPerTick: areas },
    );
  } catch (error) {
    return handleAdvanceError(db, run, error, now);
  }

  // Re-read rather than reuse: the tick just wrote `search_started_at` through
  // a different path, and the state below must describe the row as it now is.
  let refreshed = await loadRun(db, { runId: run.id, userId: run.user_id });

  // THE LIVENESS GUARD.
  //
  // A slice that completed no area and spent no call changed nothing, and
  // repeating it will change nothing either. Counting those is what stops a
  // self-advancing run from asking forever; any real progress resets it.
  const madeProgress = tick.apiCalls > 0 || tick.tiles.length > 0;
  const stalled = await trackProgress(db, refreshed, madeProgress, now);
  if (stalled) return buildGenerationState(db, stalled, now);
  refreshed = await loadRun(db, { runId: run.id, userId: run.user_id });

  // Coverage complete is the ONLY ending that hands over to email discovery.
  // Every other stop leaves geography owed, and beginning to fetch other
  // people's websites as a side effect of a search failing is not something a
  // person approved.
  if (tick.coverage.tilesRemaining === 0 || tick.stopReason === "coverage_complete") {
    const moved = await enterEnrichmentPhase(db, refreshed, now);
    return buildGenerationState(db, moved, now);
  }

  const terminal = SEARCH_STOP_TO_GENERATION[tick.stopReason];
  if (terminal) {
    const stopped = await finishRun(db, refreshed, terminal, now, {
      status: terminal === "failed" ? "failed" : "stopped",
      lastError: tick.error,
    });
    return buildGenerationState(db, stopped, now);
  }

  // `tile_budget_reached` and `tick_slice_expired` mean only that this slice
  // ended -- unless what is left of the approval cannot pay for another area.
  //
  // Checked HERE rather than left for the next advance to discover, so the
  // state this call returns is already the final one. Otherwise a run whose
  // allowance had just run out would report itself as still running while also
  // reporting that it could not continue, and the client would stop asking
  // without the database ever recording why.
  const { data: afterTick } = await db
    .from("searches")
    .select("api_calls_run, tiles_pending")
    .eq("id", run.search_id)
    .maybeSingle();

  if (afterTick && afterTick.tiles_pending > 0) {
    const ceilingAfter = await stopIfCeilingReached(db, refreshed, afterTick.api_calls_run, now);
    if (ceilingAfter) return buildGenerationState(db, ceilingAfter, now);
  }

  return buildGenerationState(db, refreshed, now);
}

/**
 * Ends the run if the approval cannot pay for one more area at its worst case.
 *
 * Note the test is not `remaining <= 0`. An area can cost up to
 * `worstCaseCallsPerArea` calls and the tick runner checks its budgets BETWEEN
 * areas, so starting one with fewer than that left could overshoot the number
 * the user approved. The run therefore stops with up to eight calls unspent,
 * and the UI says exactly that rather than pretending the ceiling was reached
 * precisely -- "stopped at 24 of 30, because one more area could cost 9" is
 * honest, and "spent 33 of 30" is not.
 *
 * Returns the updated row when it stopped the run, or null when there is room
 * to continue.
 */
/**
 * Counts consecutive advances that changed nothing, and halts once too many
 * have passed.
 *
 * Bounded rather than infinite because the orchestrator now drives itself. The
 * counter lives on the run row because the decision spans advances -- each one
 * is a separate request and has no memory of the last.
 *
 * Returns the halted row, or null when the run may continue.
 */
async function trackProgress(
  db: AdminDb,
  run: GenerationRunRow,
  madeProgress: boolean,
  now: () => number,
): Promise<GenerationRunRow | null> {
  if (madeProgress) {
    if (run.no_progress_ticks !== 0) await patchRun(db, run.id, { no_progress_ticks: 0 });
    return null;
  }

  const attempts = run.no_progress_ticks + 1;
  if (attempts < GENERATION_LIMITS.maxNoProgressAdvances) {
    await patchRun(db, run.id, { no_progress_ticks: attempts });
    return null;
  }

  const halted = await finishRun(db, run, "no_progress", now, {
    status: "stopped",
    lastError: `The generation made no progress across ${attempts} consecutive attempts.`,
  });

  await logSearchEvent(db, {
    searchId: run.search_id,
    level: "error",
    code: "generation_no_progress",
    message:
      `Generation halted after ${attempts} consecutive slices that completed no area and spent ` +
      `no Google call. Stopping is safer than continuing to ask.`,
    meta: { generation_run_id: run.id, attempts, api_calls_made: 0 },
  });

  return halted;
}

async function stopIfCeilingReached(
  db: AdminDb,
  run: GenerationRunRow,
  searchApiCallsRun: number,
  now: () => number,
): Promise<GenerationRunRow | null> {
  const used = callsUsedByRun({
    searchApiCallsRun,
    apiCallsAtStart: run.api_calls_at_start,
  });
  const remaining = Math.max(run.call_ceiling - used, 0);

  if (areasAllowedThisAdvance(remaining) > 0) return null;

  const stopped = await finishRun(db, run, "safety_limit_reached", now, { status: "stopped" });

  await logSearchEvent(db, {
    searchId: run.search_id,
    level: "warn",
    code: "generation_safety_limit",
    message:
      `Generation paused for safety: ${used} of ${run.call_ceiling} permitted Google call(s) ` +
      `used, ${remaining} left — fewer than the ${GENERATION_LIMITS.worstCaseCallsPerArea} one ` +
      `more area could cost. The remaining area is still owed and still recorded.`,
    meta: {
      generation_run_id: run.id,
      calls_used: used,
      call_ceiling: run.call_ceiling,
      api_calls_made: 0,
    },
  });

  return stopped;
}

/**
 * How a tick's ending maps onto the LIFECYCLE's ending.
 *
 * ABSENT FROM THIS TABLE IS EVERY ENDING THAT IS NOT ONE. A slice that hit its
 * tile cap, ran out of wall clock, lost a race for the lease, or failed a
 * single area is not a finished generation -- it is the loop. Mapping any of
 * those to a stop is what made the previous build ask the user to press
 * "Continue" three times for one city.
 *
 * Specifically NOT terminal, and the reasoning for each:
 *
 *   tile_budget_reached  - the slice filled up. More slices follow.
 *   tick_slice_expired   - the slice ran out of time. More slices follow.
 *   tile_error           - the tile returns to pending and is retried by the
 *                          next slice. Every retry is a real billable request,
 *                          so the per-search budget bounds this; a tile that
 *                          fails without spending is caught by the no-progress
 *                          guard instead.
 *   lease_lost           - another runner holds it. Transient by nature, and
 *                          the no-progress guard bounds it if it is not.
 *
 * What IS terminal is only the money running out, the user stopping, or Google
 * refusing in a way that will not fix itself.
 */
const SEARCH_STOP_TO_GENERATION: Partial<Record<string, GenerationStopReason>> = {
  // The two hard spending limits. Not failures -- the guard did its job.
  call_budget_reached: "safety_limit_reached",
  quota_exhausted: "safety_limit_reached",
  // Only reachable by a search created before the target stopped being a
  // termination condition. Its frozen policy is honoured rather than rewritten.
  stopped_at_target: "safety_limit_reached",
  paused_by_user: "stopped_by_user",
  canceled: "stopped_by_user",
  fatal_api_error: "failed",
};

async function advanceEnrichmentPhase(
  db: AdminDb,
  run: GenerationRunRow,
  deps: AdvanceDependencies,
  now: () => number,
): Promise<GenerationState> {
  const runEnrichment = deps.runEnrichment ?? runEnrichmentService;

  // THE CONSENT GATE. Reaching a business's web server without this is the one
  // thing this table exists to make impossible, so the check is here, at the
  // only place that can start a live run, rather than in the UI.
  if (!run.enrichment_consented_at) {
    const finished = await finishRun(db, run, "enrichment_not_consented", now, {
      status: "completed",
      phase: "ready",
    });
    return buildGenerationState(db, finished, now);
  }

  if (!run.enrichment_started_at) {
    await patchRun(db, run.id, { enrichment_started_at: nowIso(now) });
  }

  let result;
  try {
    result = await runEnrichment({
      userId: run.user_id,
      // "new" ONLY, and this is a deliberate reading of the brief.
      //
      // The batch can reach a lead that has never been looked at and nothing
      // else. A `found` address can never be overwritten, and a lead whose site
      // already refused us is NOT retried automatically -- "do not repeatedly
      // hammer failed websites" and an automatic retry loop are the same thing
      // seen from the small business's server log. Retrying stays an explicit
      // press on the results page, still capped at MAX_ATTEMPTS_PER_LEAD.
      //
      // This is also what makes the loop terminate: a processed lead leaves
      // `not_enriched` whatever the outcome, so the eligible set only shrinks.
      mode: "new",
      searchId: run.search_id,
      limit: GENERATION_LIMITS.enrichmentLeadsPerAdvance,
      // A LIVE run, which is what the user consented to. `runEnrichment` refuses
      // a live run without an explicit fetch implementation, so this cannot
      // silently fall back to a network-capable default.
      dryRun: false,
      fetchImpl: deps.enrichmentFetch ?? globalThis.fetch,
    });
  } catch (error) {
    // A batch that throws must end the run rather than be retried forever by
    // the self-advancing loop.
    return handleAdvanceError(db, run, error, now);
  }

  const refreshed = await loadRun(db, { runId: run.id, userId: run.user_id });

  // COMPLETION IS CHECKED FIRST, before the liveness guard. The batch that
  // finishes the job is very often an empty one -- nothing left to select,
  // nothing processed -- and testing for a stall before testing for completion
  // would score the successful ending as a failure to progress.
  if (result.remaining === 0) {
    const finished = await finishRun(db, refreshed, "generation_complete", now, {
      status: "completed",
      phase: "ready",
      enrichmentCompletedAt: nowIso(now),
    });
    return buildGenerationState(db, finished, now);
  }

  // The same liveness guard the search phase uses. Leads remain eligible but
  // this batch processed none of them, and repeating it cannot change that.
  const stalled = await trackProgress(db, refreshed, result.processed > 0, now);
  if (stalled) return buildGenerationState(db, stalled, now);

  return buildGenerationState(db, refreshed, now);
}

/**
 * Search phase over. Whether email discovery follows is decided by the CONSENT
 * RECORD and by whether there is anything with a website left to look at.
 */
async function enterEnrichmentPhase(
  db: AdminDb,
  run: GenerationRunRow,
  now: () => number,
): Promise<GenerationRunRow> {
  const stamp = nowIso(now);

  if (!run.enrichment_consented_at) {
    return finishRun(db, run, "enrichment_not_consented", now, {
      status: "completed",
      phase: "ready",
      searchCompletedAt: run.search_completed_at ?? stamp,
    });
  }

  const { count } = await db
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("search_id", run.search_id)
    .eq("user_id", run.user_id)
    .eq("email_status", "not_enriched")
    .not("website", "is", null)
    .neq("website", "");

  if ((count ?? 0) === 0) {
    return finishRun(db, run, "generation_complete", now, {
      status: "completed",
      phase: "ready",
      searchCompletedAt: run.search_completed_at ?? stamp,
    });
  }

  return patchRun(db, run.id, {
    phase: "enriching",
    search_completed_at: run.search_completed_at ?? stamp,
    enrichment_started_at: run.enrichment_started_at ?? stamp,
  });
}

/**
 * The lease was not granted. Decide whether that means "wait" or "stop".
 *
 * `claim_search_job_by_id` returns no row for two reasons that look identical
 * to the caller and mean opposite things:
 *
 *   A LIVE LEASE IS HELD -- another slice is working RIGHT NOW. Losing this
 *   race is not a failure and not even a delay in the work: the search is
 *   progressing under the other lease. The correct response is to leave the run
 *   exactly as it is and let the client ask again. Crucially it must NOT count
 *   as a no-progress advance -- a 50-second slice would otherwise let a
 *   remounted client burn the entire liveness budget in a couple of seconds and
 *   halt a perfectly healthy run.
 *
 *   THE SEARCH IS NOT RUNNABLE -- its status is not `queued` or `running`, so
 *   no amount of asking will change anything. That IS terminal, and gets an
 *   honest reason rather than a retry loop.
 *
 * One SELECT distinguishes them, and it is worth it: getting this wrong is what
 * recorded a 357-lead run as unrecoverable while it was still collecting leads.
 */
async function handleClaimFailure(
  db: AdminDb,
  run: GenerationRunRow,
  now: () => number,
): Promise<GenerationState> {
  const { data: search } = await db
    .from("searches")
    .select("status, locked_by, heartbeat_at")
    .eq("id", run.search_id)
    .maybeSingle();

  const runnable = search?.status === "queued" || search?.status === "running";
  const leaseHeld = Boolean(search?.locked_by);

  if (runnable && leaseHeld) {
    // Someone is working. Nothing to record, nothing to count, nothing to stop.
    return buildGenerationState(db, run, now);
  }

  // Not runnable: the search finished, was cancelled, or is in a state this run
  // cannot drive. Ending honestly beats asking forever.
  const stopped = await finishRun(db, run, "search_unavailable", now, {
    status: "stopped",
    lastError: `The search is ${search?.status ?? "unavailable"} and cannot be continued by this generation.`,
  });

  return buildGenerationState(db, stopped, now);
}

async function handleAdvanceError(
  db: AdminDb,
  run: GenerationRunRow,
  error: unknown,
  now: () => number,
): Promise<GenerationState> {
  // A refusal, not a failure: the pre-flight or the quota guard declined before
  // any Google request was made, any lease was taken, or any tile was touched.
  if (error instanceof SearchBlockedError || error instanceof QuotaBlockedError) {
    const message =
      error instanceof SearchBlockedError ? error.block.message : "The run was not permitted.";
    const stopped = await finishRun(db, run, "blocked", now, {
      status: "stopped",
      lastError: message,
    });
    return buildGenerationState(db, stopped, now);
  }

  // The lease could not be taken. `claim_search_job_by_id` returns no row for
  // two very different reasons, and telling them apart is the whole fix for the
  // production failure of 2026-08-23.
  if (error instanceof ClaimError) {
    return handleClaimFailure(db, run, now);
  }

  const message = error instanceof Error ? error.message : String(error);
  const failed = await finishRun(db, run, "failed", now, { status: "failed", lastError: message });
  return buildGenerationState(db, failed, now);
}

// ---------------------------------------------------------------------------
// Stopping
// ---------------------------------------------------------------------------

/**
 * The user pressed Stop.
 *
 * Ends the APPROVAL, which is what stops further advances. A tick already in
 * flight finishes on its own -- it is bounded to a single short slice and
 * releases its lease on every terminal path -- rather than being killed
 * mid-request, which is the same cooperative shape pause and cancel already
 * use.
 */
export async function stopGenerationRun(
  args: { runId: string; userId: string },
  options: { db?: AdminDb; now?: () => number } = {},
): Promise<GenerationState> {
  const db = options.db ?? getSupabaseAdminClient();
  const now = options.now ?? Date.now;

  const run = await loadRun(db, args);
  if (run.status !== "running") {
    return buildGenerationState(db, run, now);
  }

  const stopped = await finishRun(db, run, "stopped_by_user", now, { status: "stopped" });

  await logSearchEvent(db, {
    searchId: run.search_id,
    level: "info",
    code: "generation_stopped",
    message: "The user stopped this generation. Remaining work is still owed and still visible.",
    meta: { generation_run_id: run.id, api_calls_made: 0 },
  });

  return buildGenerationState(db, stopped, now);
}

// ---------------------------------------------------------------------------
// Row writes
// ---------------------------------------------------------------------------

async function patchRun(
  db: AdminDb,
  runId: string,
  patch: Partial<GenerationRunRow>,
): Promise<GenerationRunRow> {
  const { data, error } = await db
    .from("generation_runs")
    .update(patch)
    .eq("id", runId)
    .select("*")
    .single();

  if (error) throw new Error(`Could not update the generation run: ${error.message}`);
  return data;
}

async function finishRun(
  db: AdminDb,
  run: GenerationRunRow,
  reason: GenerationStopReason,
  now: () => number,
  extra: {
    status?: GenerationRunRow["status"];
    phase?: GenerationRunRow["phase"];
    lastError?: string | null;
    searchCompletedAt?: string;
    enrichmentCompletedAt?: string;
  } = {},
): Promise<GenerationRunRow> {
  const stamp = nowIso(now);

  return patchRun(db, run.id, {
    status: extra.status ?? "completed",
    phase: extra.phase ?? run.phase,
    stop_reason: reason,
    last_error: extra.lastError ?? run.last_error,
    completed_at: run.completed_at ?? stamp,
    search_completed_at: extra.searchCompletedAt ?? run.search_completed_at,
    enrichment_completed_at: extra.enrichmentCompletedAt ?? run.enrichment_completed_at,
  });
}
