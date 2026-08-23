import "server-only";

import { PLACES_FIELD_MASK } from "@/lib/constants";
import { buildCoverageReport, type CoverageTile } from "@/lib/coverage-report";
import { WORST_CASE_LEAD_MS, WORST_CASE_TILE_MS } from "@/lib/generate/calibration";
import { elapsedSeconds, estimateRemaining } from "@/lib/generate/eta";
import type {
  GenerationBudget,
  GenerationDisplayState,
  GenerationEnrichmentProgress,
  GenerationSearchProgress,
  GenerationState,
  GenerationStep,
} from "@/lib/generate/types";
import type { TileState } from "@/lib/tile-states";
import type { Database } from "@/lib/database.types";
import { getSupabaseAdminClient } from "@/server/db/admin";
import { CONTACT_PATHS } from "@/server/enrichment/providers/website-provider";
import * as pricing from "@/server/pricing/pricing-service";
import { getQuotaSnapshot } from "@/server/quota/quota-service";
import { SEARCH_LIMITS } from "@/server/search/limits";

import { areasAllowedThisAdvance, callsUsedByRun, GENERATION_LIMITS } from "./limits";

/**
 * Everything the guided flow shows, read from Postgres on every request.
 *
 * NOT ONE COUNTABLE FIGURE IS STORED IN `generation_runs`. Leads come from
 * `leads`, coverage from `search_tiles` through the same `buildCoverageReport`
 * the tick runner and the export use, API usage from `searches.api_calls_run`
 * and the quota service, email outcomes from `leads.email_status` and
 * `lead_enrichment_attempts`. The run row contributes only phase, consent, the
 * approval ceiling and the timestamps -- the facts that exist nowhere else.
 *
 * That is what makes a refresh, a reopened tab, or a different device show the
 * same run: there is no client state to lose, because there is no client state.
 */

export type GenerationRunRow = Database["public"]["Tables"]["generation_runs"]["Row"];

type AdminDb = ReturnType<typeof getSupabaseAdminClient>;

/**
 * Requests one lead's own website can cost: robots.txt, the homepage, and the
 * three contact paths the provider tries. Derived from the provider's own list
 * so that adding a path cannot silently make the quoted worst case wrong.
 */
export const MAX_EXTERNAL_REQUESTS_PER_LEAD = 1 + 1 + CONTACT_PATHS.length;

export class GenerationNotFoundError extends Error {
  readonly status = 404;
  constructor(message = "That generation run could not be found.") {
    super(message);
    this.name = "GenerationNotFoundError";
  }
}

/** Loads a run and proves it belongs to the caller. */
export async function loadRun(
  db: AdminDb,
  args: { runId: string; userId: string },
): Promise<GenerationRunRow> {
  const { data, error } = await db
    .from("generation_runs")
    .select("*")
    .eq("id", args.runId)
    .eq("user_id", args.userId)
    .maybeSingle();

  if (error) throw new Error(`Could not load the generation run: ${error.message}`);
  if (!data) throw new GenerationNotFoundError();
  return data;
}

/** The newest run for a search, whatever its status. */
export async function findLatestRunForSearch(
  db: AdminDb,
  args: { searchId: string; userId: string },
): Promise<GenerationRunRow | null> {
  const { data, error } = await db
    .from("generation_runs")
    .select("*")
    .eq("search_id", args.searchId)
    .eq("user_id", args.userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Could not load the generation run: ${error.message}`);
  return data;
}

export type LoadGenerationStateOptions = {
  db?: AdminDb;
  /** Injected in tests. Defaults to `Date.now`. */
  now?: () => number;
};

export async function loadGenerationState(
  args: { runId: string; userId: string },
  options: LoadGenerationStateOptions = {},
): Promise<GenerationState> {
  const db = options.db ?? getSupabaseAdminClient();
  const now = options.now ?? Date.now;

  const run = await loadRun(db, args);
  return buildGenerationState(db, run, now);
}

export async function buildGenerationState(
  db: AdminDb,
  run: GenerationRunRow,
  now: () => number = Date.now,
): Promise<GenerationState> {
  const nowMs = now();

  const { data: search, error: searchError } = await db
    .from("searches")
    .select("*")
    .eq("id", run.search_id)
    .maybeSingle();

  if (searchError) throw new Error(`Could not load the search: ${searchError.message}`);
  if (!search) throw new GenerationNotFoundError("The search behind this run no longer exists.");

  const [{ data: tileRows }, { data: leadRows }, { data: attemptRows }, quota] = await Promise.all([
    db
      .from("search_tiles")
      .select("label, state, area_km2, depth, started_at, completed_at")
      .eq("search_id", run.search_id)
      .order("path"),
    db
      .from("leads")
      .select("website, email_status")
      .eq("search_id", run.search_id)
      .eq("user_id", run.user_id),
    // This run's OWN enrichment measurements. Scoped by the phase timestamp so
    // that a second approval over the same search estimates from what it has
    // actually seen rather than from an earlier run's luck.
    run.enrichment_started_at
      ? db
          .from("lead_enrichment_attempts")
          .select("duration_ms, created_at, leads!inner(search_id)")
          .eq("leads.search_id", run.search_id)
          .eq("user_id", run.user_id)
          .gte("created_at", run.enrichment_started_at)
          .order("created_at", { ascending: true })
      : Promise.resolve({ data: [] as { duration_ms: number | null; created_at: string }[] }),
    getQuotaSnapshot(pricing.classify(PLACES_FIELD_MASK).sku, { db }),
  ]);

  const tiles = tileRows ?? [];
  const leads = leadRows ?? [];
  const attempts = (attemptRows ?? []) as { duration_ms: number | null; created_at: string }[];

  // The SAME function the tick runner writes to the activity log and the export
  // writes to the Coverage worksheet, so the three cannot tell different
  // stories about what was searched.
  const coverage = buildCoverageReport({
    tiles: tiles.map((tile): CoverageTile => ({
      label: tile.label,
      state: tile.state as TileState,
      area_km2: tile.area_km2 ?? 0,
      depth: tile.depth,
    })),
    target: search.target_leads,
    leadsFound: search.leads_found,
  });

  // ---------------------------------------------------------------------
  // Search progress and its ETA.
  // ---------------------------------------------------------------------
  const tileDurations = tiles.map((tile) =>
    tile.started_at && tile.completed_at
      ? Date.parse(tile.completed_at) - Date.parse(tile.started_at)
      : null,
  );

  const lastTileCompletedAt = tiles
    .map((tile) => (tile.completed_at ? Date.parse(tile.completed_at) : Number.NaN))
    .filter((value) => Number.isFinite(value))
    .reduce((max, value) => Math.max(max, value), Number.NEGATIVE_INFINITY);

  const searchProgress: GenerationSearchProgress = {
    leadsFound: search.leads_found,
    targetLeads: search.target_leads,
    targetReached: coverage.targetReached,
    coveragePct: search.coverage_pct,
    areasSearched: coverage.tilesCompleted,
    areasTotal: coverage.leafTiles,
    areasRemaining: coverage.tilesRemaining,
    areaOwedKm2: coverage.owed.areaKm2,
    fullyCovered: coverage.fullyCovered,
    searchStatus: search.status,
    startedAt: run.search_started_at,
    completedAt: run.search_completed_at,
    elapsedSeconds: elapsedSeconds(run.search_started_at, run.search_completed_at, nowMs),
    eta: estimateRemaining({
      durationsMs: tileDurations,
      remainingUnits: coverage.tilesRemaining,
      worstCaseMsPerUnit: WORST_CASE_TILE_MS,
      msSinceLastUnit:
        run.phase === "searching" && Number.isFinite(lastTileCompletedAt)
          ? nowMs - lastTileCompletedAt
          : undefined,
    }),
  };

  // ---------------------------------------------------------------------
  // Email discovery progress and its ETA.
  // ---------------------------------------------------------------------
  const hasWebsite = (lead: { website: string | null }) =>
    typeof lead.website === "string" && lead.website.trim() !== "";

  const withWebsite = leads.filter(hasWebsite);
  const countStatus = (status: string) =>
    withWebsite.filter((lead) => lead.email_status === status).length;

  const enrichmentRemaining = countStatus("not_enriched");
  const enrichmentFound =
    countStatus("found") + countStatus("verified") + countStatus("unverified");

  const lastAttemptAt = attempts
    .map((attempt) => Date.parse(attempt.created_at))
    .filter((value) => Number.isFinite(value))
    .reduce((max, value) => Math.max(max, value), Number.NEGATIVE_INFINITY);

  const enrichmentProgress: GenerationEnrichmentProgress = {
    leadsWithWebsite: withWebsite.length,
    leadsWithoutWebsite: leads.length - withWebsite.length,
    found: enrichmentFound,
    notFound: countStatus("not_found"),
    failed: countStatus("failed"),
    remaining: enrichmentRemaining,
    checked: withWebsite.length - enrichmentRemaining,
    consented: run.enrichment_consented_at !== null,
    maxExternalRequestsRemaining: enrichmentRemaining * MAX_EXTERNAL_REQUESTS_PER_LEAD,
    startedAt: run.enrichment_started_at,
    completedAt: run.enrichment_completed_at,
    elapsedSeconds: elapsedSeconds(run.enrichment_started_at, run.enrichment_completed_at, nowMs),
    eta: estimateRemaining({
      durationsMs: attempts.map((attempt) => attempt.duration_ms),
      remainingUnits: enrichmentRemaining,
      worstCaseMsPerUnit: WORST_CASE_LEAD_MS,
      msSinceLastUnit:
        run.phase === "enriching" && Number.isFinite(lastAttemptAt)
          ? nowMs - lastAttemptAt
          : undefined,
    }),
  };

  // ---------------------------------------------------------------------
  // The approval's spending envelope.
  // ---------------------------------------------------------------------
  const used = callsUsedByRun({
    searchApiCallsRun: search.api_calls_run,
    apiCallsAtStart: run.api_calls_at_start,
  });
  const remaining = Math.max(run.call_ceiling - used, 0);

  const budget: GenerationBudget = {
    ceiling: run.call_ceiling,
    used,
    remaining,
    reserveForOneArea: GENERATION_LIMITS.worstCaseCallsPerArea,
    exhausted: areasAllowedThisAdvance(remaining) === 0,
    searchCallsUsed: search.api_calls_run,
    searchCallBudget: SEARCH_LIMITS.maxCallsPerSearch,
    quotaRemaining: quota.remaining,
    quotaUsed: quota.used,
    quotaFreeLimit: quota.freeLimit,
  };

  const described = describeRun({
    run,
    search: searchProgress,
    enrichment: enrichmentProgress,
    budget,
  });

  return {
    runId: run.id,
    searchId: run.search_id,
    status: run.status,
    phase: run.phase,
    stopReason: run.stop_reason,
    lastError: run.last_error,
    niche: search.niche,
    locationLabel: search.label,
    createdAt: run.created_at,
    completedAt: run.completed_at,
    totalElapsedSeconds: elapsedSeconds(run.created_at, run.completed_at, nowMs),
    canAdvance: described.canAdvance,
    blockedReason: described.blockedReason,
    headline: described.headline,
    title: described.title,
    displayState: described.displayState,
    steps: described.steps,
    lifecycleComplete: described.lifecycleComplete,
    search: searchProgress,
    enrichment: enrichmentProgress,
    budget,
  };
}

/**
 * Whether there is more work to ask for, and what the user is told about it.
 *
 * Kept free of I/O so the transitions can be tested against plain objects.
 * Every string here is the one a normal user reads -- no tile ids, no RPC
 * names, no stop-reason identifiers.
 *
 * THE PAGE HEADING IS DECIDED HERE, on the server, from coverage and email
 * progress. That is what makes "Your leads are ready" impossible to render over
 * an incomplete run: readiness is a conclusion about the work, not a guess
 * about whether a request happens to be in flight.
 */
export function describeRun(input: {
  run: Pick<GenerationRunRow, "status" | "phase" | "stop_reason" | "enrichment_consented_at">;
  search: GenerationSearchProgress;
  enrichment: GenerationEnrichmentProgress;
  budget: GenerationBudget;
}): {
  canAdvance: boolean;
  blockedReason: string | null;
  headline: string;
  title: string;
  displayState: GenerationDisplayState;
  steps: GenerationStep[];
  lifecycleComplete: boolean;
} {
  const { run, search, enrichment, budget } = input;

  const decide = (
    displayState: GenerationDisplayState,
    canAdvance: boolean,
    headline: string,
    blockedReason: string | null = null,
  ) => ({
    canAdvance,
    blockedReason,
    headline,
    title: TITLES[displayState],
    displayState,
    steps: buildSteps({
      displayState,
      emailsConsented: enrichment.consented,
      // Derived from the WORK, not from the display state. A halted run is not
      // in the "searching" state any more, but that must never be read as the
      // search having finished -- which is exactly the mistake that would tick
      // a green check next to an area that was never searched.
      searchCompleted: search.areasRemaining === 0,
      emailsCompleted: enrichment.consented && enrichment.remaining === 0,
    }),
    lifecycleComplete: displayState === "ready",
  });

  // ---- terminal states, in the order that matters ----------------------
  if (run.status === "failed") {
    return decide(
      "failed",
      false,
      "This generation could not be finished.",
      "Something went wrong and the generation could not continue.",
    );
  }

  if (run.status === "stopped") {
    // `generation_call_ceiling` is the RETIRED reason from the 30-call gate.
    // One real run carries it -- the production test that prompted this
    // redesign, which stopped at 22 calls with 23% of its area searched. It
    // meant precisely "a spending limit stopped this", so it is read as the
    // safety stop it was rather than shown as a bare "stopped".
    if (
      run.stop_reason === "safety_limit_reached" ||
      run.stop_reason === "generation_call_ceiling"
    ) {
      return decide(
        "paused-for-safety",
        false,
        "Paused before reaching the free-usage limit.",
        "Your search safety limit was reached before the selected area was fully searched.",
      );
    }
    if (run.stop_reason === "no_progress") {
      return decide(
        "failed",
        false,
        "This generation stopped making progress.",
        "The generation stopped making progress and was halted rather than left running.",
      );
    }
    if (run.stop_reason === "blocked") {
      return decide(
        "paused-for-safety",
        false,
        "This generation could not start.",
        "The generation was not permitted to start. Nothing was requested and nothing was spent.",
      );
    }
    return decide("stopped", false, "Generation stopped.", "You stopped this generation.");
  }

  if (run.status === "completed") {
    // Consent was never given, so email discovery is genuinely still available.
    // The leads ARE ready; the heading says so and the sub-line is honest about
    // what was not done rather than quietly implying it was.
    if (run.stop_reason === "enrichment_not_consented" && enrichment.remaining > 0) {
      return decide(
        "ready",
        false,
        "Your leads are ready. Email discovery was not part of this generation.",
      );
    }
    return decide("ready", false, "Your leads are ready.");
  }

  // ---- running ---------------------------------------------------------
  if (run.phase === "ready") {
    return decide("preparing", true, "Preparing your results...");
  }

  if (run.phase === "searching") {
    // A hard limit reached mid-flight. Note it STILL ADVANCES: the next advance
    // is what writes the stop to the database. Returning `canAdvance: false`
    // here would leave the run marked running forever while also saying it
    // cannot go on, and the client would stop asking without the reason ever
    // being recorded.
    if (budget.exhausted && search.areasRemaining > 0) {
      return decide("paused-for-safety", true, "Paused before reaching the free-usage limit.");
    }
    if (search.areasRemaining === 0) {
      return decide("searching", true, "Finishing the search...");
    }
    return decide("searching", true, "Searching local businesses...");
  }

  // ---- email discovery -------------------------------------------------
  // No consent, or nothing left to check: either way the next advance closes
  // the run out. Both are "preparing your results" from the user's side.
  if (!enrichment.consented || enrichment.remaining === 0) {
    return decide("preparing", true, "Preparing your results...");
  }

  return decide("finding-emails", true, "Checking public business websites...");
}

/** The page heading for each state. Exactly one of them says "ready". */
const TITLES: Record<GenerationDisplayState, string> = {
  searching: "Generating your leads",
  "finding-emails": "Generating your leads",
  preparing: "Generating your leads",
  ready: "Your leads are ready",
  "paused-for-safety": "Generation paused for safety",
  stopped: "Generation stopped",
  failed: "Generation could not be finished",
};

/**
 * The three-step flow the processing screen renders.
 *
 * A STEP IS ONLY `done` WHEN THE WORK IS DONE. Completion is taken from the
 * work itself -- areas owed, leads still to check -- and never inferred from
 * the display state, because a halted run has left the "searching" state
 * without having finished searching. Inferring it would put a green check next
 * to an area that was never searched, which is the same class of lie as
 * "your leads are ready" over 23% coverage.
 *
 * `blocked` is used rather than `pending` for work that will not now happen, so
 * a stopped run never looks like it is still waiting its turn.
 */
function buildSteps(input: {
  displayState: GenerationDisplayState;
  emailsConsented: boolean;
  searchCompleted: boolean;
  emailsCompleted: boolean;
}): GenerationStep[] {
  const { displayState, emailsConsented, searchCompleted, emailsCompleted } = input;

  const halted =
    displayState === "paused-for-safety" || displayState === "stopped" || displayState === "failed";

  return [
    {
      id: "search",
      label: "Searching businesses",
      state: searchCompleted ? "done" : halted ? "blocked" : "active",
    },
    {
      id: "emails",
      label: "Finding business emails",
      state: !emailsConsented
        ? "blocked"
        : emailsCompleted
          ? "done"
          : halted
            ? "blocked"
            : searchCompleted
              ? "active"
              : "pending",
    },
    {
      id: "results",
      label: "Preparing your results",
      state:
        displayState === "ready"
          ? "done"
          : halted
            ? "blocked"
            : searchCompleted && emailsCompleted
              ? "active"
              : "pending",
    },
  ];
}
