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

/**
 * The rectangle that was actually searched, in the user's terms.
 *
 * Every figure comes from the persisted search row -- `area_total_km2`,
 * `area_covered_km2` and the four bbox columns written when the grid was laid
 * down. Nothing here is a label typed by hand or a coordinate invented for
 * display, which is what lets the page answer "which part of Houston did it
 * actually search?" truthfully.
 */
export type GenerationArea = {
  /** The resolved location label, e.g. "Houston, Texas, United States". */
  label: string;
  totalKm2: number;
  searchedKm2: number;
  remainingKm2: number;
  coveragePct: number;
  fullyCovered: boolean;
  /** The exact persisted rectangle. */
  bounds: { north: number; south: number; east: number; west: number };
};

/**
 * Outbound requests, separated by who actually received them.
 *
 * THE HEADER USED TO SAY "API 188 / 950", which conflated three unrelated
 * things: it mixed the monthly Google counter with an internal protected
 * allowance, and said nothing at all about the hundreds of ordinary HTTP
 * requests email discovery makes to business websites. These fields keep the
 * categories apart so no figure can be mistaken for another.
 *
 * Supabase, Storage, Realtime and traffic between this application's own routes
 * are NOT counted anywhere here. They are not product API usage and never
 * appear in `api_call_log`.
 */
export type GenerationRequests = {
  /** Billable Google Places calls made by THIS search. */
  googlePlacesThisSearch: number;
  /** The per-search ceiling those sit inside. */
  googleSearchBudget: number;
  /** The month's Google total, across every search. */
  googleMonthlyUsed: number;
  /** The full free monthly allowance -- not the internal protected figure. */
  googleMonthlyLimit: number;
  /**
   * Business websites checked for a contact address, counted from recorded
   * enrichment attempts. One attempt is one business looked at; the number of
   * individual HTTP requests behind it is not persisted, so it is not claimed.
   */
  websitesChecked: number;
  /** Geocoding requests ever recorded. Structurally zero: the providers are off. */
  geocoding: number;
  /** Requests to a paid email-lookup provider. Structurally zero: none exists. */
  thirdPartyEmail: number;
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
  /** The page heading. Only ever "Your leads are ready" when truly complete. */
  title: string;
  /** What the user is told is happening. Computed on the server. */
  displayState: GenerationDisplayState;
  /** The three-step flow, ready to render. */
  steps: GenerationStep[];
  /** True once the whole lifecycle finished successfully. Gates the export CTA. */
  lifecycleComplete: boolean;

  search: GenerationSearchProgress;
  enrichment: GenerationEnrichmentProgress;
  budget: GenerationBudget;
  area: GenerationArea;
  requests: GenerationRequests;
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
 * target. Also absent since the lifecycle change is any reason that means
 * "this slice ended" -- a slice ending is not an ending, it is the loop.
 */
export type GenerationStopReason =
  /** Coverage complete AND email discovery exhausted. The only success. */
  | "generation_complete"
  /**
   * A HARD limit stopped it: the per-search call budget, or the protected
   * monthly allowance. Not a failure and not something to press through -- the
   * money guard did its job, and the UI says so plainly.
   */
  | "safety_limit_reached"
  /** The user pressed Stop. */
  | "stopped_by_user"
  /** The pre-flight refused before anything was spent. */
  | "blocked"
  /** Leads collected, but email discovery was never consented to. */
  | "enrichment_not_consented"
  /** The self-advancing loop stopped changing anything. See `maxNoProgressAdvances`. */
  | "no_progress"
  /**
   * The search can no longer be driven by this run -- it finished, was
   * cancelled, or is otherwise not runnable. Distinct from losing a race for
   * the lease, which is transient and never ends a generation.
   */
  | "search_unavailable"
  | "failed";

/**
 * What the user is told is happening, derived on the server from the run's
 * status, phase and remaining work.
 *
 * The UI renders this and never computes it. That is what stops the results
 * page from saying "ready" over an incomplete run: readiness is a server
 * conclusion about coverage and email discovery, not a client guess about
 * whether a request is in flight.
 */
export type GenerationDisplayState =
  | "searching"
  | "finding-emails"
  | "preparing"
  | "ready"
  | "paused-for-safety"
  | "stopped"
  | "failed";

export type GenerationStepId = "search" | "emails" | "results";

export type GenerationStep = {
  id: GenerationStepId;
  label: string;
  state: "done" | "active" | "pending" | "blocked";
};
