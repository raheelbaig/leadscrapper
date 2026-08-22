import type { EtaEstimate } from "./eta";

/**
 * The wire shape of a generation run's progress.
 *
 * Lives in `src/lib/` rather than `src/server/` because the processing and
 * results screens render it and the ESLint boundary forbids client code from
 * importing `@/server/*`. It is a DESCRIPTION of server state, never a source
 * of it: every field is computed on the server, from Postgres, on each request.
 * Nothing the browser holds is authoritative, which is what makes a refresh,
 * a reopened tab, or a different device show the same run.
 */

export type GenerationPhase = "searching" | "enriching" | "ready";
export type GenerationStatus = "running" | "stopped" | "completed" | "failed";

export type GenerationSearchProgress = {
  leadsFound: number;
  /** A MINIMUM benchmark. Never a completion condition. */
  targetLeads: number;
  /** Reported as a metric. Exceeding it is a result, not a reason to stop. */
  targetReached: boolean;
  coveragePct: number;
  areasSearched: number;
  areasTotal: number;
  areasRemaining: number;
  areaOwedKm2: number;
  /** THE completion criterion. */
  fullyCovered: boolean;
  searchStatus: string;
  /**
   * Persisted phase boundaries, passed through so the browser can tick a live
   * clock from a server timestamp instead of counting seconds of its own.
   */
  startedAt: string | null;
  completedAt: string | null;
  elapsedSeconds: number;
  eta: EtaEstimate;
};

export type GenerationEnrichmentProgress = {
  /** Leads that have a website at all -- the only bridge to an email address. */
  leadsWithWebsite: number;
  leadsWithoutWebsite: number;
  found: number;
  notFound: number;
  failed: number;
  /** Leads with a website that have never been looked at. */
  remaining: number;
  checked: number;
  /** False means this run may not make a single external request. */
  consented: boolean;
  /** Worst-case number of requests to other people's servers still to come. */
  maxExternalRequestsRemaining: number;
  startedAt: string | null;
  completedAt: string | null;
  elapsedSeconds: number;
  eta: EtaEstimate;
};

/**
 * The spending envelope of ONE approval.
 *
 * Three ceilings, narrowest first. `ceiling` is what the user actually
 * approved; the other two are the pre-existing limits it sits inside and can
 * never exceed.
 */
export type GenerationBudget = {
  /** Google calls this approval permits. */
  ceiling: number;
  /** Derived: `searches.api_calls_run` minus the watermark taken at approval. */
  used: number;
  remaining: number;
  /**
   * Worst case for one more area. The run stops while `remaining` is below it,
   * which is what makes the ceiling a guarantee rather than a target.
   */
  reserveForOneArea: number;
  exhausted: boolean;
  /** The per-search ceiling this approval sits inside. */
  searchCallsUsed: number;
  searchCallBudget: number;
  /** The protected monthly free allowance, from the existing quota service. */
  quotaRemaining: number;
  quotaUsed: number;
  quotaFreeLimit: number;
};

export type GenerationState = {
  runId: string;
  searchId: string;
  status: GenerationStatus;
  phase: GenerationPhase;
  /** The orchestrator's vocabulary, not the search's. */
  stopReason: string | null;
  lastError: string | null;

  niche: string;
  locationLabel: string;

  createdAt: string;
  completedAt: string | null;
  totalElapsedSeconds: number;

  /** True while there is more work the client may ask the server to do. */
  canAdvance: boolean;
  /** Plain-English reason the run is not advancing. */
  blockedReason: string | null;
  /** The friendly current-step line, e.g. "Searching local businesses...". */
  headline: string;

  search: GenerationSearchProgress;
  enrichment: GenerationEnrichmentProgress;
  budget: GenerationBudget;
};

/**
 * Why a generation run ended.
 *
 * Deliberately its OWN vocabulary, separate from `TickStopReason`. One
 * describes an approval, the other describes geography, and the bug this
 * product exists to avoid is exactly what happens when the two are conflated:
 * a search that covered 83% of its area reporting itself complete because a
 * different budget was satisfied.
 *
 * Note what is absent, here as everywhere: any reason involving the lead
 * target.
 */
export type GenerationStopReason =
  /** Every leaf area accounted for AND email discovery finished. The only success. */
  | "generation_complete"
  /** This approval's Google-call ceiling is spent. A new approval continues it. */
  | "generation_call_ceiling"
  /** The user pressed Stop. */
  | "stopped_by_user"
  /** The search paused with geography owed for a reason of its own. */
  | "search_paused"
  /** The pre-flight or quota refused the run. Nothing was spent. */
  | "blocked"
  /** Leads collected, but email discovery was never consented to. */
  | "enrichment_not_consented"
  | "failed";
