import "server-only";

import { PLACES_FIELD_MASK } from "@/lib/constants";
import { buildCoverageReport, type CoverageTile } from "@/lib/coverage-report";
import { WORST_CASE_LEAD_MS, WORST_CASE_TILE_MS } from "@/lib/generate/calibration";
import { elapsedSeconds, estimateRemaining } from "@/lib/generate/eta";
import type {
  GenerationBudget,
  GenerationEnrichmentProgress,
  GenerationSearchProgress,
  GenerationState,
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

  const { canAdvance, blockedReason, headline } = describeRun({
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
    canAdvance,
    blockedReason,
    headline,
    search: searchProgress,
    enrichment: enrichmentProgress,
    budget,
  };
}

/**
 * Whether there is more work to ask for, and what to call what is happening.
 *
 * Kept separate and free of I/O so the transitions can be tested against plain
 * objects. Every string here is the one a normal user reads -- no tile ids, no
 * RPC names, no stop-reason identifiers.
 */
export function describeRun(input: {
  run: Pick<GenerationRunRow, "status" | "phase" | "stop_reason" | "enrichment_consented_at">;
  search: GenerationSearchProgress;
  enrichment: GenerationEnrichmentProgress;
  budget: GenerationBudget;
}): { canAdvance: boolean; blockedReason: string | null; headline: string } {
  const { run, search, enrichment, budget } = input;

  if (run.status === "completed") {
    return { canAdvance: false, blockedReason: null, headline: "Your leads are ready." };
  }
  if (run.status === "failed") {
    return {
      canAdvance: false,
      blockedReason: "Something went wrong during this generation.",
      headline: "This generation could not be finished.",
    };
  }
  if (run.status === "stopped") {
    return {
      canAdvance: false,
      blockedReason:
        run.stop_reason === "generation_call_ceiling"
          ? "This generation reached its current safety limit."
          : "This generation was stopped.",
      headline: "Your leads so far are ready.",
    };
  }

  if (run.phase === "ready") {
    return { canAdvance: false, blockedReason: null, headline: "Your leads are ready." };
  }

  if (run.phase === "searching") {
    if (search.areasRemaining === 0) {
      // Nothing left to search: the next advance performs the phase change.
      return { canAdvance: true, blockedReason: null, headline: "Finishing the search..." };
    }
    if (budget.exhausted) {
      return {
        canAdvance: false,
        blockedReason: "This generation reached its current safety limit.",
        headline: "Paused at this generation's safety limit.",
      };
    }
    return { canAdvance: true, blockedReason: null, headline: "Searching local businesses..." };
  }

  // Email discovery.
  if (!enrichment.consented) {
    return {
      canAdvance: false,
      blockedReason: "Email discovery was not approved for this generation.",
      headline: "Your leads are ready. Email discovery is available.",
    };
  }
  if (enrichment.remaining === 0) {
    return { canAdvance: true, blockedReason: null, headline: "Finishing up..." };
  }
  return {
    canAdvance: true,
    blockedReason: null,
    headline: "Checking public business websites...",
  };
}
