import { describe, expect, it } from "vitest";

import { estimateRemaining } from "@/lib/generate/eta";
import type {
  GenerationBudget,
  GenerationEnrichmentProgress,
  GenerationSearchProgress,
} from "@/lib/generate/types";

import { GENERATION_LIMITS } from "./limits";
import { describeRun, type GenerationRunRow } from "./state";

/**
 * The phase machine, pinned against plain objects.
 *
 * `describeRun` is the function that decides whether there is more work to ask
 * for and what to call what is happening, and it is free of I/O precisely so
 * that these transitions can be checked without a database, a network, or a
 * clock.
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
    remaining: 24,
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

describe("describeRun — searching", () => {
  it("keeps going while there is area left and allowance to search it", () => {
    const result = describeRun({
      run: run(),
      search: searchProgress(),
      enrichment: enrichment(),
      budget: budget(),
    });

    expect(result.canAdvance).toBe(true);
    expect(result.headline).toBe("Searching local businesses...");
    expect(result.blockedReason).toBeNull();
  });

  /**
   * THE DEFINING PRODUCT RULE.
   *
   * A run that wanted 40 leads and has found 87 with area still owed has
   * exceeded its benchmark, not finished. The target must not appear anywhere
   * in this decision.
   */
  it("keeps going when the lead target is exceeded but area is still owed", () => {
    const result = describeRun({
      run: run(),
      search: searchProgress({
        leadsFound: 87,
        targetLeads: 40,
        targetReached: true,
        coveragePct: 83.34,
        areasRemaining: 1,
        fullyCovered: false,
      }),
      enrichment: enrichment(),
      budget: budget(),
    });

    expect(result.canAdvance).toBe(true);
    expect(result.headline).toBe("Searching local businesses...");
  });

  it("hands over to the next phase once every area is accounted for", () => {
    const result = describeRun({
      run: run(),
      search: searchProgress({ areasRemaining: 0, coveragePct: 100, fullyCovered: true }),
      enrichment: enrichment(),
      budget: budget(),
    });

    // Still advancing: the next advance performs the phase change itself.
    expect(result.canAdvance).toBe(true);
    expect(result.headline).toBe("Finishing the search...");
  });

  it("stops when the approval has less left than one more area could cost", () => {
    const result = describeRun({
      run: run(),
      search: searchProgress(),
      enrichment: enrichment(),
      budget: budget({ used: 24, remaining: 6, exhausted: true }),
    });

    expect(result.canAdvance).toBe(false);
    expect(result.blockedReason).toBe("This generation reached its current safety limit.");
  });
});

describe("describeRun — email discovery", () => {
  it("checks websites while consented leads remain", () => {
    const result = describeRun({
      run: run({ phase: "enriching" }),
      search: searchProgress({ areasRemaining: 0, fullyCovered: true }),
      enrichment: enrichment({ remaining: 12 }),
      budget: budget(),
    });

    expect(result.canAdvance).toBe(true);
    expect(result.headline).toBe("Checking public business websites...");
  });

  /**
   * THE CONSENT GATE.
   *
   * Without a recorded consent the run may not make a single request to a
   * business's own web server, however many leads are waiting.
   */
  it("refuses to advance email discovery that was never consented to", () => {
    const result = describeRun({
      run: run({ phase: "enriching", enrichment_consented_at: null }),
      search: searchProgress({ areasRemaining: 0, fullyCovered: true }),
      enrichment: enrichment({ remaining: 40, consented: false }),
      budget: budget(),
    });

    expect(result.canAdvance).toBe(false);
    expect(result.blockedReason).toBe("Email discovery was not approved for this generation.");
    expect(result.headline).toBe("Your leads are ready. Email discovery is available.");
  });

  it("finishes once every lead with a website has been looked at", () => {
    const result = describeRun({
      run: run({ phase: "enriching" }),
      search: searchProgress({ areasRemaining: 0, fullyCovered: true }),
      enrichment: enrichment({ remaining: 0, checked: 20 }),
      budget: budget(),
    });

    expect(result.canAdvance).toBe(true);
    expect(result.headline).toBe("Finishing up...");
  });
});

describe("describeRun — terminal states", () => {
  it("reports a completed run as ready", () => {
    const result = describeRun({
      run: run({ status: "completed", phase: "ready", stop_reason: "generation_complete" }),
      search: searchProgress({ areasRemaining: 0, fullyCovered: true }),
      enrichment: enrichment({ remaining: 0 }),
      budget: budget(),
    });

    expect(result.canAdvance).toBe(false);
    expect(result.blockedReason).toBeNull();
    expect(result.headline).toBe("Your leads are ready.");
  });

  it("explains a ceiling stop in the user's terms, not the budget's", () => {
    const result = describeRun({
      run: run({ status: "stopped", stop_reason: "generation_call_ceiling" }),
      search: searchProgress(),
      enrichment: enrichment(),
      budget: budget({ used: 24, remaining: 6, exhausted: true }),
    });

    expect(result.canAdvance).toBe(false);
    expect(result.blockedReason).toBe("This generation reached its current safety limit.");
    // A stop is not a failure: what was collected is still the point.
    expect(result.headline).toBe("Your leads so far are ready.");
  });

  it("reports a user stop without calling it an error", () => {
    const result = describeRun({
      run: run({ status: "stopped", stop_reason: "stopped_by_user" }),
      search: searchProgress(),
      enrichment: enrichment(),
      budget: budget(),
    });

    expect(result.canAdvance).toBe(false);
    expect(result.blockedReason).toBe("This generation was stopped.");
  });

  it("never advances a failed run", () => {
    const result = describeRun({
      run: run({ status: "failed", stop_reason: "failed" }),
      search: searchProgress(),
      enrichment: enrichment(),
      budget: budget(),
    });

    expect(result.canAdvance).toBe(false);
    expect(result.headline).toBe("This generation could not be finished.");
  });
});
