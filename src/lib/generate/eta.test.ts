import { describe, expect, it } from "vitest";

import { WORST_CASE_LEAD_MS, WORST_CASE_TILE_MS } from "./calibration";
import {
  elapsedSeconds,
  estimateRemaining,
  formatDurationApprox,
  formatElapsed,
  MIN_ETA_SAMPLES,
  sanitizeDurations,
  STALL_FACTOR,
} from "./eta";

/**
 * The ETA rules, pinned without a clock.
 *
 * Every case here is a fixed array of numbers in and a fixed estimate out,
 * which is the whole reason `estimateRemaining` takes its inputs rather than
 * reading a clock: an ETA that consulted `Date.now()` internally could only be
 * tested by waiting.
 */

describe("sanitizeDurations", () => {
  it("keeps ordinary measurements", () => {
    expect(sanitizeDurations([2_100, 3_100, 4_200])).toEqual([2_100, 3_100, 4_200]);
  });

  it("drops nulls, undefined and NaN", () => {
    expect(sanitizeDurations([null, 3_000, undefined, Number.NaN, 4_000])).toEqual([3_000, 4_000]);
  });

  it("drops zero and negative durations", () => {
    // A negative duration means the two timestamps disagree about order. There
    // is no honest way to project from it.
    expect(sanitizeDurations([0, -500, 3_000])).toEqual([3_000]);
  });

  /**
   * THE REAL ROW THIS EXISTS FOR.
   *
   * Search ff5874c0's Tile #1 has a `completed_at` and a NULL `started_at`.
   * Subtracting them yields ~1.787e12 ms. Left in the sample set it drags the
   * median far enough to produce a multi-decade estimate.
   */
  it("drops a duration computed against a null start timestamp", () => {
    const bogus = Date.now() - Date.parse("1970-01-01T00:00:00Z");
    expect(sanitizeDurations([3_100, bogus, 2_900])).toEqual([3_100, 2_900]);
  });

  it("still estimates sensibly with such a row in the input", () => {
    const bogus = Date.now();
    const estimate = estimateRemaining({
      durationsMs: [3_000, bogus, 3_000],
      remainingUnits: 4,
      worstCaseMsPerUnit: WORST_CASE_TILE_MS,
    });

    expect(estimate.samples).toBe(2);
    expect(estimate.highSeconds).toBe(12);
  });
});

describe("estimateRemaining", () => {
  it("refuses to guess from fewer than two samples", () => {
    const estimate = estimateRemaining({
      durationsMs: [3_100],
      remainingUnits: 5,
      worstCaseMsPerUnit: WORST_CASE_TILE_MS,
    });

    expect(estimate.state).toBe("estimating");
    expect(estimate.basis).toBe("prior");
    expect(estimate.label).toBe("Estimating time remaining...");
    // No number is offered at all, rather than a confident one built on one
    // observation.
    expect(estimate.lowSeconds).toBeNull();
    expect(estimate.highSeconds).toBeNull();
  });

  it("switches to the run's own measurements at the sample threshold", () => {
    const estimate = estimateRemaining({
      durationsMs: Array.from({ length: MIN_ETA_SAMPLES }, () => 3_000),
      remainingUnits: 2,
      worstCaseMsPerUnit: WORST_CASE_TILE_MS,
    });

    expect(estimate.basis).toBe("run");
    expect(estimate.state).toBe("ranged");
  });

  it("projects a range from the observed spread", () => {
    const estimate = estimateRemaining({
      durationsMs: [2_000, 3_000, 4_000, 5_000],
      remainingUnits: 10,
      worstCaseMsPerUnit: WORST_CASE_TILE_MS,
    });

    expect(estimate.lowSeconds).toBe(20);
    expect(estimate.highSeconds).toBe(50);
    expect(estimate.label).toBe("About 20–50 sec remaining");
  });

  it("reports the worst case separately from the estimate", () => {
    const estimate = estimateRemaining({
      durationsMs: [4_000, 4_000],
      remainingUnits: 43,
      worstCaseMsPerUnit: WORST_CASE_LEAD_MS,
    });

    // The honest spread for 43 leads: minutes by the estimate, but well over
    // half an hour if every site hangs. Both are shown; neither is hidden
    // inside an average.
    expect(estimate.highSeconds).toBe(172);
    expect(estimate.worstCaseSeconds).toBe(43 * 54);
    expect(estimate.worstCaseLabel).toBe("Worst case 39 min");
  });

  it("never returns a negative estimate", () => {
    const estimate = estimateRemaining({
      durationsMs: [3_000, 3_000],
      remainingUnits: -5,
      worstCaseMsPerUnit: WORST_CASE_TILE_MS,
    });

    expect(estimate.remainingUnits).toBe(0);
    expect(estimate.lowSeconds).toBe(0);
    expect(estimate.highSeconds).toBe(0);
    expect(estimate.worstCaseSeconds).toBe(0);
  });

  it("reports 'done' rather than a countdown when nothing is left", () => {
    const estimate = estimateRemaining({
      durationsMs: [3_000, 3_000],
      remainingUnits: 0,
      worstCaseMsPerUnit: WORST_CASE_TILE_MS,
    });

    expect(estimate.state).toBe("done");
    expect(estimate.label).toBe("Finishing up...");
  });

  /**
   * NO FAKE COUNTDOWN.
   *
   * The estimate is a function of REMAINING WORK, not of elapsed time. Time
   * passing with nothing completed must not shrink it -- which is exactly what
   * a countdown would do, and what would let the display reach "00:00" while
   * the run was still going.
   */
  it("does not shrink as time passes with no work completed", () => {
    const durations = [3_000, 3_000, 3_000];

    const first = estimateRemaining({
      durationsMs: durations,
      remainingUnits: 6,
      worstCaseMsPerUnit: WORST_CASE_TILE_MS,
      msSinceLastUnit: 1_000,
    });

    const muchLater = estimateRemaining({
      durationsMs: durations,
      remainingUnits: 6,
      worstCaseMsPerUnit: WORST_CASE_TILE_MS,
      // Two minutes later, still nothing finished.
      msSinceLastUnit: 121_000,
    });

    expect(muchLater.lowSeconds).toBe(first.lowSeconds);
    expect(muchLater.highSeconds).toBe(first.highSeconds);
    expect(muchLater.lowSeconds).toBeGreaterThan(0);
  });

  it("never reaches zero while work remains", () => {
    for (const msSinceLastUnit of [0, 10_000, 60_000, 600_000, 86_400_000]) {
      const estimate = estimateRemaining({
        durationsMs: [3_000, 3_000],
        remainingUnits: 3,
        worstCaseMsPerUnit: WORST_CASE_TILE_MS,
        msSinceLastUnit,
      });

      expect(estimate.state).not.toBe("done");
      expect(estimate.highSeconds).toBeGreaterThan(0);
    }
  });

  it("says it is overdue instead of quoting a range it has disproved", () => {
    const highMs = 4_000;
    const estimate = estimateRemaining({
      durationsMs: [3_000, highMs],
      remainingUnits: 3,
      worstCaseMsPerUnit: WORST_CASE_TILE_MS,
      msSinceLastUnit: highMs * STALL_FACTOR + 1,
    });

    expect(estimate.state).toBe("stalled");
    expect(estimate.label).toBe("Taking longer than expected...");
    // The figures are still carried, so the worst case stays visible.
    expect(estimate.highSeconds).toBe(12);
  });

  it("stays ranged just inside the stall threshold", () => {
    const estimate = estimateRemaining({
      durationsMs: [3_000, 4_000],
      remainingUnits: 3,
      worstCaseMsPerUnit: WORST_CASE_TILE_MS,
      msSinceLastUnit: 4_000 * STALL_FACTOR,
    });

    expect(estimate.state).toBe("ranged");
  });

  it("collapses the range to one figure when the band is tight", () => {
    const estimate = estimateRemaining({
      durationsMs: [3_000, 3_000],
      remainingUnits: 20,
      worstCaseMsPerUnit: WORST_CASE_TILE_MS,
    });

    expect(estimate.label).toBe("About 1 min remaining");
  });
});

describe("formatDurationApprox", () => {
  it("never says zero", () => {
    // "0 sec remaining" while a run is working is the countdown lie in
    // miniature.
    expect(formatDurationApprox(0)).toBe("1 sec");
  });

  it.each([
    [45, "45 sec"],
    [59, "59 sec"],
    [90, "2 min"],
    [600, "10 min"],
    [3_600, "1 hr"],
    [4_200, "1 hr 10 min"],
  ])("formats %i seconds as %s", (seconds, expected) => {
    expect(formatDurationApprox(seconds)).toBe(expected);
  });
});

describe("formatElapsed", () => {
  it.each([
    [0, "00:00"],
    [42, "00:42"],
    [252, "04:12"],
    [3_852, "1:04:12"],
  ])("formats %i seconds as %s", (seconds, expected) => {
    expect(formatElapsed(seconds)).toBe(expected);
  });

  it("clamps a negative input rather than rendering a minus sign", () => {
    expect(formatElapsed(-30)).toBe("00:00");
  });
});

describe("elapsedSeconds", () => {
  const start = "2026-08-23T12:00:00.000Z";
  const startMs = Date.parse(start);

  it("measures against now while the phase is open", () => {
    expect(elapsedSeconds(start, null, startMs + 252_000)).toBe(252);
  });

  it("freezes at the real duration once the phase has ended", () => {
    const end = "2026-08-23T12:04:12.000Z";
    // Reading it an hour later must not change the answer.
    expect(elapsedSeconds(start, end, startMs + 3_600_000)).toBe(252);
  });

  it("returns zero when the phase has not started", () => {
    expect(elapsedSeconds(null, null, startMs)).toBe(0);
  });

  /**
   * Server and browser clocks disagree by seconds routinely. A run that started
   * 400ms ago according to Postgres and 200ms in the future according to the
   * laptop must render "00:00", never "-00:01".
   */
  it("never returns a negative elapsed time", () => {
    expect(elapsedSeconds(start, null, startMs - 5_000)).toBe(0);
  });

  it("ignores an unparseable timestamp", () => {
    expect(elapsedSeconds("not a date", null, startMs)).toBe(0);
  });
});
