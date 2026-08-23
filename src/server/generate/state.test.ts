import { describe, expect, it } from "vitest";

import { estimateRemaining } from "@/lib/generate/eta";
import type {
  GenerationBudget,
  GenerationEnrichmentProgress,
  GenerationSearchProgress,
  GenerationStepId,
} from "@/lib/generate/types";

import { GENERATION_LIMITS } from "./limits";
import { describeRun, type GenerationRunRow } from "./state";

/**
 * The lifecycle machine, pinned against plain objects.
 *
 * `describeRun` decides three things: whether there is more work to ask for,
 * what the user is told is happening, and what the page is titled. It is free
 * of I/O precisely so those decisions can be checked without a database, a
 * network, or a clock.
 *
 * The heading is the important one. "Your leads are ready" over a run that
 * searched 23% of its area is the failure this whole file exists to prevent.
 */

const idleEta = estimateRemaining({
  durationsMs: [],
  remainingUnits: 0,
  worstCaseMsPerUnit: 1_000,
});

function searchProgress(over: Partial<GenerationSearchProgress> = {}): GenerationSearchProgress {
  return {
    leadsFound: 12,
    targetLeads: 40,
    targetReached: false,
    coveragePct: 50,
    areasSearched: 3,
    areasTotal: 6,
    areasRemaining: 3,
    areaOwedKm2: 120,
    fullyCovered: false,
    searchStatus: "running",
    startedAt: "2026-08-23T12:00:00.000Z",
    completedAt: null,
    elapsedSeconds: 42,
    eta: idleEta,
    ...over,
  };
}

function enrichment(
  over: Partial<GenerationEnrichmentProgress> = {},
): GenerationEnrichmentProgress {
  return {
    leadsWithWebsite: 20,
    leadsWithoutWebsite: 4,
    found: 5,
    notFound: 2,
    failed: 1,
    remaining: 12,
    checked: 8,
    consented: true,
    maxExternalRequestsRemaining: 60,
    startedAt: null,
    completedAt: null,
    elapsedSeconds: 0,
    eta: idleEta,
    ...over,
  };
}

function budget(over: Partial<GenerationBudget> = {}): GenerationBudget {
  return {
    ceiling: GENERATION_LIMITS.maxGoogleCallsPerRun,
    used: 6,
    remaining: 144,
    reserveForOneArea: GENERATION_LIMITS.worstCaseCallsPerArea,
    exhausted: false,
    searchCallsUsed: 6,
    searchCallBudget: 150,
    quotaRemaining: 930,
    quotaUsed: 20,
    quotaFreeLimit: 1_000,
    ...over,
  };
}

type RunShape = Pick<
  GenerationRunRow,
  "status" | "phase" | "stop_reason" | "enrichment_consented_at"
>;

function run(over: Partial<RunShape> = {}): RunShape {
  return {
    status: "running",
    phase: "searching",
    stop_reason: null,
    enrichment_consented_at: "2026-08-23T12:00:00.000Z",
    ...over,
  };
}

function describe_(
  over: {
    run?: Partial<RunShape>;
    search?: Partial<GenerationSearchProgress>;
    enrichment?: Partial<GenerationEnrichmentProgress>;
    budget?: Partial<GenerationBudget>;
  } = {},
) {
  return describeRun({
    run: run(over.run),
    search: searchProgress(over.search),
    enrichment: enrichment(over.enrichment),
    budget: budget(over.budget),
  });
}

/** The state of one step in the rendered flow. */
function step(result: ReturnType<typeof describeRun>, id: GenerationStepId) {
  return result.steps.find((s) => s.id === id)!.state;
}

// ---------------------------------------------------------------------------
// The heading: the thing that was wrong before
// ---------------------------------------------------------------------------

describe("the page heading", () => {
  /**
   * THE BUG THIS REPLACES.
   *
   * The previous build showed "Your leads so far are ready" above a run that
   * had searched a fraction of its area and stopped at a call ceiling. Every
   * incomplete state now says what actually happened instead.
   */
  it("never says the leads are ready while the lifecycle is unfinished", () => {
    const incomplete = [
      describe_(),
      describe_({ run: { phase: "enriching" }, search: { areasRemaining: 0 } }),
      describe_({ run: { status: "stopped", stop_reason: "safety_limit_reached" } }),
      describe_({ run: { status: "stopped", stop_reason: "stopped_by_user" } }),
      describe_({ run: { status: "failed", stop_reason: "failed" } }),
      describe_({ run: { status: "stopped", stop_reason: "no_progress" } }),
    ];

    for (const result of incomplete) {
      expect(result.title).not.toMatch(/ready/i);
      expect(result.lifecycleComplete).toBe(false);
    }
  });

  it("never says 'so far'", () => {
    // The specific wording that was misleading. Gone from every state.
    const all = [
      describe_(),
      describe_({ run: { status: "stopped", stop_reason: "safety_limit_reached" } }),
      describe_({ run: { status: "stopped", stop_reason: "stopped_by_user" } }),
      describe_({
        run: { status: "completed", phase: "ready", stop_reason: "generation_complete" },
      }),
    ];

    for (const result of all) {
      expect(result.title).not.toMatch(/so far/i);
      expect(result.headline).not.toMatch(/so far/i);
    }
  });

  it("says the leads are ready only when the lifecycle actually completed", () => {
    const result = describe_({
      run: { status: "completed", phase: "ready", stop_reason: "generation_complete" },
      search: { areasRemaining: 0, fullyCovered: true, coveragePct: 100 },
      enrichment: { remaining: 0, checked: 20 },
    });

    expect(result.title).toBe("Your leads are ready");
    expect(result.lifecycleComplete).toBe(true);
    expect(result.canAdvance).toBe(false);
  });

  it("titles a safety stop honestly", () => {
    const result = describe_({
      run: { status: "stopped", stop_reason: "safety_limit_reached" },
      search: { areasRemaining: 40, coveragePct: 23, fullyCovered: false },
      budget: { used: 150, remaining: 0, exhausted: true },
    });

    expect(result.title).toBe("Generation paused for safety");
    expect(result.displayState).toBe("paused-for-safety");
    expect(result.blockedReason).toMatch(/safety limit was reached/i);
    expect(result.canAdvance).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The lifecycle advances itself
// ---------------------------------------------------------------------------

describe("automatic advancement", () => {
  it("keeps going while there is area left", () => {
    const result = describe_();
    expect(result.canAdvance).toBe(true);
    expect(result.displayState).toBe("searching");
    expect(result.headline).toBe("Searching local businesses...");
  });

  /**
   * THE DEFINING PRODUCT RULE.
   *
   * Target 15, 117 leads, 23% coverage: not finished. The target must take no
   * part in this decision at all.
   */
  it("keeps going when the target is exceeded but the area is not covered", () => {
    const result = describe_({
      search: {
        leadsFound: 117,
        targetLeads: 15,
        targetReached: true,
        coveragePct: 23,
        areasRemaining: 40,
        fullyCovered: false,
      },
    });

    expect(result.canAdvance).toBe(true);
    expect(result.displayState).toBe("searching");
    expect(result.lifecycleComplete).toBe(false);
    expect(result.title).not.toMatch(/ready/i);
  });

  it("moves itself into email discovery once the area is covered", () => {
    const searchDone = describe_({ search: { areasRemaining: 0, fullyCovered: true } });
    expect(searchDone.canAdvance).toBe(true);
    expect(searchDone.headline).toBe("Finishing the search...");

    const enriching = describe_({
      run: { phase: "enriching" },
      search: { areasRemaining: 0, fullyCovered: true },
      enrichment: { remaining: 12 },
    });
    expect(enriching.canAdvance).toBe(true);
    expect(enriching.displayState).toBe("finding-emails");
    expect(enriching.headline).toBe("Checking public business websites...");
  });

  it("keeps advancing through email batches until none remain", () => {
    const midway = describe_({
      run: { phase: "enriching" },
      search: { areasRemaining: 0, fullyCovered: true },
      enrichment: { remaining: 3 },
    });
    expect(midway.canAdvance).toBe(true);

    const done = describe_({
      run: { phase: "enriching" },
      search: { areasRemaining: 0, fullyCovered: true },
      enrichment: { remaining: 0, checked: 20 },
    });
    // Still advancing: the next advance is what closes the run out.
    expect(done.canAdvance).toBe(true);
    expect(done.displayState).toBe("preparing");
    expect(done.headline).toBe("Preparing your results...");
  });

  /**
   * A hard limit reached mid-flight must STILL advance, because the next
   * advance is what writes the stop to the database. Returning `canAdvance:
   * false` here would leave the run marked running forever while also claiming
   * it cannot continue.
   */
  it("still advances once when a hard limit is reached, so the stop gets recorded", () => {
    const result = describe_({
      search: { areasRemaining: 40 },
      budget: { used: 150, remaining: 0, exhausted: true },
    });

    expect(result.canAdvance).toBe(true);
    expect(result.displayState).toBe("paused-for-safety");
  });

  it("never advances a run that has already ended", () => {
    for (const stop of ["safety_limit_reached", "stopped_by_user", "no_progress"] as const) {
      expect(describe_({ run: { status: "stopped", stop_reason: stop } }).canAdvance).toBe(false);
    }
    expect(describe_({ run: { status: "failed" } }).canAdvance).toBe(false);
    expect(describe_({ run: { status: "completed", phase: "ready" } }).canAdvance).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

describe("email consent", () => {
  /**
   * Without consent the run closes out rather than checking websites. It still
   * ADVANCES -- to write that ending down -- but the enrichment phase itself is
   * gated separately in the orchestrator, which is what actually prevents the
   * request.
   */
  it("closes the run out rather than checking websites", () => {
    const result = describe_({
      run: { phase: "enriching", enrichment_consented_at: null },
      search: { areasRemaining: 0, fullyCovered: true },
      enrichment: { remaining: 40, consented: false },
    });

    expect(result.displayState).toBe("preparing");
    expect(result.headline).toBe("Preparing your results...");
  });

  it("marks the email step as not done when consent was never given", () => {
    const result = describe_({
      run: {
        status: "completed",
        phase: "ready",
        stop_reason: "enrichment_not_consented",
        enrichment_consented_at: null,
      },
      search: { areasRemaining: 0, fullyCovered: true },
      enrichment: { remaining: 40, consented: false },
    });

    expect(step(result, "emails")).toBe("blocked");
    expect(result.headline).toMatch(/not part of this generation/i);
  });
});

// ---------------------------------------------------------------------------
// The three-step flow
// ---------------------------------------------------------------------------

describe("the three-step flow", () => {
  it("marks searching active and the rest waiting at the start", () => {
    const result = describe_();
    expect(step(result, "search")).toBe("active");
    expect(step(result, "emails")).toBe("pending");
    expect(step(result, "results")).toBe("pending");
  });

  it("ticks searching off once email discovery begins", () => {
    const result = describe_({
      run: { phase: "enriching" },
      search: { areasRemaining: 0, fullyCovered: true },
      enrichment: { remaining: 12 },
    });

    expect(step(result, "search")).toBe("done");
    expect(step(result, "emails")).toBe("active");
    expect(step(result, "results")).toBe("pending");
  });

  it("ticks emails off while the results are prepared", () => {
    const result = describe_({
      run: { phase: "enriching" },
      search: { areasRemaining: 0, fullyCovered: true },
      enrichment: { remaining: 0, checked: 20 },
    });

    expect(step(result, "search")).toBe("done");
    expect(step(result, "emails")).toBe("done");
    expect(step(result, "results")).toBe("active");
  });

  it("shows all three complete only when the lifecycle is", () => {
    const result = describe_({
      run: { status: "completed", phase: "ready", stop_reason: "generation_complete" },
      search: { areasRemaining: 0, fullyCovered: true },
      enrichment: { remaining: 0 },
    });

    expect(result.steps.map((s) => s.state)).toEqual(["done", "done", "done"]);
  });

  it("never shows a completed step after a safety stop mid-search", () => {
    const result = describe_({
      run: { status: "stopped", stop_reason: "safety_limit_reached" },
      search: { areasRemaining: 40, fullyCovered: false },
    });

    // The search never finished, so nothing downstream of it may look finished.
    expect(step(result, "search")).toBe("blocked");
    expect(step(result, "emails")).toBe("blocked");
    expect(step(result, "results")).toBe("blocked");
  });
});

// ---------------------------------------------------------------------------
// Terminal wording
// ---------------------------------------------------------------------------

describe("terminal wording", () => {
  it("calls a user stop a stop, not an error", () => {
    const result = describe_({ run: { status: "stopped", stop_reason: "stopped_by_user" } });

    expect(result.title).toBe("Generation stopped");
    expect(result.displayState).toBe("stopped");
    expect(result.blockedReason).toBe("You stopped this generation.");
  });

  it("reports a stalled run as a failure rather than leaving it ambiguous", () => {
    const result = describe_({ run: { status: "stopped", stop_reason: "no_progress" } });

    expect(result.displayState).toBe("failed");
    expect(result.blockedReason).toMatch(/stopped making progress/i);
  });

  it("reports a refused start without implying anything was spent", () => {
    const result = describe_({ run: { status: "stopped", stop_reason: "blocked" } });

    expect(result.displayState).toBe("paused-for-safety");
    expect(result.blockedReason).toMatch(/nothing was requested and nothing was spent/i);
  });
});
