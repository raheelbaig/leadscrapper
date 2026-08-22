import { describe, expect, it } from "vitest";

import { finalOutcome, finalStatus, nextStopReason, type TickStopReason } from "./completion";

/**
 * The central product rule, tested on its own.
 *
 * Phase 3B shipped a search that reported `completed / target_reached` having
 * covered 83.34% of its rectangle: target 40, found 51, one seed tile never
 * searched. It was not lying about the leads. It was lying about the area, and
 * anything decided from that list inherited the claim.
 *
 * These tests exist to make that specific outcome unreachable.
 */

const ALL_REASONS: TickStopReason[] = [
  "coverage_complete",
  "tile_budget_reached",
  "call_budget_reached",
  "tick_slice_expired",
  "quota_exhausted",
  "tile_error",
  "fatal_api_error",
  "lease_lost",
  "paused_by_user",
  "canceled",
  "stopped_at_target",
];

/** The loop state of a healthy run with plenty of budget left. */
function state(overrides: Partial<Parameters<typeof nextStopReason>[0]> = {}) {
  return {
    stopOnTargetReached: false,
    leadsFound: 0,
    targetLeads: 40,
    status: "running",
    callsRemainingInSearch: 100,
    callsThisTick: 0,
    maxCallsPerTick: 108,
    tilesThisTick: 0,
    maxTilesPerTick: 12,
    elapsedMs: 0,
    maxTickMs: 50_000,
    ...overrides,
  };
}

describe("completion is geographic, never the lead target", () => {
  it("only coverage_complete yields a completed status", () => {
    const completing = ALL_REASONS.filter((reason) => finalStatus(reason) === "completed");
    expect(completing).toEqual(["coverage_complete"]);
  });

  it("every other ending leaves the search paused, failed or canceled", () => {
    for (const reason of ALL_REASONS) {
      if (reason === "coverage_complete") continue;
      expect(finalStatus(reason)).not.toBe("completed");
    }

    expect(finalStatus("fatal_api_error")).toBe("failed");
    expect(finalStatus("canceled")).toBe("canceled");
    expect(finalStatus("quota_exhausted")).toBe("paused");
    expect(finalStatus("call_budget_reached")).toBe("paused");
    expect(finalStatus("tick_slice_expired")).toBe("paused");
  });

  it("does not stop when the target is met with tiles still owed", () => {
    // The exact Phase 3B situation: target 40, found 51, geography outstanding.
    expect(nextStopReason(state({ leadsFound: 51, targetLeads: 40 }))).toBeNull();
  });

  it("does not stop when the target is exceeded twofold", () => {
    // Target 40 · found 87 · tiles remaining. The specified successful run.
    expect(nextStopReason(state({ leadsFound: 87, targetLeads: 40 }))).toBeNull();
  });

  it("keeps going even at a target of zero, which is trivially met", () => {
    expect(nextStopReason(state({ leadsFound: 0, targetLeads: 0 }))).toBeNull();
  });
});

describe("the frozen legacy policy", () => {
  it("is honoured for a pre-2026-08-22 search", () => {
    expect(
      nextStopReason(state({ stopOnTargetReached: true, leadsFound: 51, targetLeads: 40 })),
    ).toBe("stopped_at_target");
  });

  it("pauses rather than completing, because the area is still owed", () => {
    expect(finalStatus("stopped_at_target")).toBe("paused");
    expect(finalOutcome("stopped_at_target", 3)).toBe("paused-by-user");
  });

  it("does not fire while the search is still below its target", () => {
    expect(
      nextStopReason(state({ stopOnTargetReached: true, leadsFound: 39, targetLeads: 40 })),
    ).toBeNull();
  });
});

describe("the budgets that DO stop a run, in order", () => {
  it("stops the moment the per-search budget is spent", () => {
    expect(nextStopReason(state({ callsRemainingInSearch: 0 }))).toBe("call_budget_reached");
    expect(nextStopReason(state({ callsRemainingInSearch: -3 }))).toBe("call_budget_reached");
  });

  it("stops on the per-tick call cap", () => {
    expect(nextStopReason(state({ callsThisTick: 108, maxCallsPerTick: 108 }))).toBe(
      "call_budget_reached",
    );
  });

  it("stops on the tile cap", () => {
    expect(nextStopReason(state({ tilesThisTick: 12, maxTilesPerTick: 12 }))).toBe(
      "tile_budget_reached",
    );
  });

  it("stops on the wall clock", () => {
    expect(nextStopReason(state({ elapsedMs: 50_000, maxTickMs: 50_000 }))).toBe(
      "tick_slice_expired",
    );
  });

  it("honours a pause before spending anything else", () => {
    // Checked ahead of every budget: a user who pressed Pause must not have one
    // more billable tile run against them first.
    expect(nextStopReason(state({ status: "paused" }))).toBe("paused_by_user");
    expect(nextStopReason(state({ status: "canceled" }))).toBe("canceled");
  });

  it("prefers the cancel signal over an exhausted budget", () => {
    expect(nextStopReason(state({ status: "canceled", callsRemainingInSearch: 0 }))).toBe(
      "canceled",
    );
  });
});

describe("the reported outcome", () => {
  it("calls a tick that found nothing to do exactly that", () => {
    expect(finalOutcome("coverage_complete", 0)).toBe("nothing-to-do");
    expect(finalOutcome("coverage_complete", 1)).toBe("completed");
  });

  it("never reports a paused run as completed", () => {
    for (const reason of ALL_REASONS) {
      if (reason === "coverage_complete") continue;
      expect(finalOutcome(reason, 5)).not.toBe("completed");
    }
  });

  it("covers every stop reason with no fallthrough", () => {
    for (const reason of ALL_REASONS) {
      expect(finalOutcome(reason, 1)).toBeTypeOf("string");
    }
  });
});
