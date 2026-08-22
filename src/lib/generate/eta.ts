/**
 * The honest ETA.
 *
 * PURE, and deliberately so: no clock of its own, no I/O, no imports from
 * `@/server/*`. Everything it needs is passed in, which is what lets every rule
 * below be tested by handing it a fixed array of numbers.
 *
 * ---------------------------------------------------------------------------
 * THE ETA IS PRESENTATION ONLY.
 *
 * Nothing in this module is read by anything that requests, reserves, retries,
 * selects a tile, batches a lead, or decides when to stop. It cannot make the
 * application spend more or wait longer, because nothing downstream of a
 * spending decision imports it.
 * ---------------------------------------------------------------------------
 *
 * THE ONE DESIGN DECISION WORTH THE COMMENT: the estimate is a function of
 * REMAINING WORK, never of elapsed time. It is recomputed when a unit of work
 * finishes, not on a timer. That makes a fake countdown structurally impossible
 * rather than merely avoided -- if the run stalls, the number does not tick
 * down toward zero, it sits still while the elapsed clock keeps climbing, and
 * once it has sat still long enough the label says so.
 */

/** Where the rate came from. `prior` means the run has not measured itself yet. */
export type EtaBasis = "run" | "prior";

export type EtaState =
  /** Too few samples to say anything. Shows "Estimating time remaining...". */
  | "estimating"
  /** A real range, from this run's own measurements. */
  | "ranged"
  /** Overdue against its own range: says so instead of showing a smaller number. */
  | "stalled"
  /** No work left to estimate. */
  | "done";

export type EtaEstimate = {
  state: EtaState;
  basis: EtaBasis;
  /** Usable measurements this estimate was built from. */
  samples: number;
  remainingUnits: number;
  lowSeconds: number | null;
  highSeconds: number | null;
  /** Every remaining unit hitting every timeout. Always reported separately. */
  worstCaseSeconds: number | null;
  /** The line to render, e.g. "About 2-4 min remaining". */
  label: string;
  /** The second line, e.g. "Worst case 39 min". Null while estimating. */
  worstCaseLabel: string | null;
};

/**
 * Two, not one.
 *
 * One sample is an anecdote: the first tile of a run carries connection setup
 * and a cold lease, and projecting forty tiles from it produces a confident
 * number that is wrong. Two is the smallest count that can disagree with
 * itself, which is the least a range needs to mean anything.
 */
export const MIN_ETA_SAMPLES = 2;

/**
 * A run is called stalled once it has gone this many times its own upper
 * per-unit estimate without finishing anything.
 */
export const STALL_FACTOR = 3;

/**
 * Durations this module will believe.
 *
 * The upper bound is not paranoia. Search `ff5874c0`'s Tile #1 carries a
 * `completed_at` with a NULL `started_at`; subtracting them yields ~1.79e9
 * seconds, and one such row in the sample set drags a median far enough to
 * produce a multi-decade ETA. Rows that cannot be true are dropped rather than
 * clamped, because a tile whose start was never recorded has no duration to
 * contribute -- clamping would invent one.
 */
const MAX_BELIEVABLE_MS = 60 * 60 * 1_000;

/** Keeps only durations that could have really happened. */
export function sanitizeDurations(raw: readonly (number | null | undefined)[]): number[] {
  return raw.filter(
    (value): value is number =>
      typeof value === "number" &&
      Number.isFinite(value) &&
      value > 0 &&
      value <= MAX_BELIEVABLE_MS,
  );
}

/** Nearest-rank percentile over an already-sorted ascending array. */
function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(fraction * sorted.length);
  const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[index];
}

export type EtaInput = {
  /** Durations of units this run has already finished, in ms. Unsanitised. */
  durationsMs: readonly (number | null | undefined)[];
  /** Units of work still owed. */
  remainingUnits: number;
  /** Derived ceiling for one unit, from the subsystem's own limits. */
  worstCaseMsPerUnit: number;
  /**
   * Time since the last unit finished, in ms. Optional: pass it to enable the
   * `stalled` state, omit it and the estimate simply never stalls.
   */
  msSinceLastUnit?: number;
};

/**
 * The remaining-time estimate.
 *
 * Returns a RANGE. A single number would claim a precision this data does not
 * support: the same enrichment provider takes 0.7s on a site that lists its
 * address on the homepage and 54s on one that hangs, and averaging those into
 * "about 27 seconds" describes neither.
 */
export function estimateRemaining(input: EtaInput): EtaEstimate {
  const remainingUnits = Math.max(Math.trunc(input.remainingUnits), 0);
  const samples = sanitizeDurations(input.durationsMs);
  const basis: EtaBasis = samples.length >= MIN_ETA_SAMPLES ? "run" : "prior";

  const worstCaseSeconds = Math.max(
    Math.ceil((remainingUnits * input.worstCaseMsPerUnit) / 1_000),
    0,
  );

  if (remainingUnits === 0) {
    return {
      state: "done",
      basis,
      samples: samples.length,
      remainingUnits: 0,
      lowSeconds: 0,
      highSeconds: 0,
      worstCaseSeconds: 0,
      label: "Finishing up...",
      worstCaseLabel: null,
    };
  }

  // Not enough of this run's own history to make a claim about it. The measured
  // prior is NOT quoted as though it were a measurement of THIS run -- the
  // honest answer here is that we do not know yet, so that is what it says.
  if (basis === "prior") {
    return {
      state: "estimating",
      basis,
      samples: samples.length,
      remainingUnits,
      lowSeconds: null,
      highSeconds: null,
      worstCaseSeconds,
      label: "Estimating time remaining...",
      worstCaseLabel: null,
    };
  }

  const sorted = [...samples].sort((a, b) => a - b);
  // The interquartile band, widened to the observed extremes when the sample is
  // small enough that p25 and p75 land on the same point.
  const lowMs = Math.min(percentile(sorted, 0.25), sorted[0]);
  const highMs = Math.max(percentile(sorted, 0.75), sorted[sorted.length - 1]);

  const lowSeconds = Math.max(Math.ceil((remainingUnits * lowMs) / 1_000), 0);
  const highSeconds = Math.max(Math.ceil((remainingUnits * highMs) / 1_000), lowSeconds);

  // Overdue against its own upper bound for a single unit. Reporting a range
  // here would be reporting one this run has already disproved.
  if (
    typeof input.msSinceLastUnit === "number" &&
    Number.isFinite(input.msSinceLastUnit) &&
    input.msSinceLastUnit > highMs * STALL_FACTOR
  ) {
    return {
      state: "stalled",
      basis,
      samples: samples.length,
      remainingUnits,
      lowSeconds,
      highSeconds,
      worstCaseSeconds,
      label: "Taking longer than expected...",
      worstCaseLabel: `Worst case ${formatDurationApprox(worstCaseSeconds)}`,
    };
  }

  return {
    state: "ranged",
    basis,
    samples: samples.length,
    remainingUnits,
    lowSeconds,
    highSeconds,
    worstCaseSeconds,
    label: formatRangeLabel(lowSeconds, highSeconds),
    worstCaseLabel: `Worst case ${formatDurationApprox(worstCaseSeconds)}`,
  };
}

/** "About 2-4 min remaining", collapsing to one figure when the band is tight. */
export function formatRangeLabel(lowSeconds: number, highSeconds: number): string {
  const low = formatDurationApprox(lowSeconds);
  const high = formatDurationApprox(highSeconds);
  if (low === high) return `About ${high} remaining`;
  return `About ${stripSharedUnit(low, high)}–${high} remaining`;
}

/**
 * Drops the unit from the lower half of a range when both halves share it, so
 * it reads "2-4 min" rather than "2 min-4 min".
 */
function stripSharedUnit(low: string, high: string): string {
  const lowUnit = low.replace(/^[\d.]+\s*/, "");
  const highUnit = high.replace(/^[\d.]+\s*/, "");
  return lowUnit === highUnit ? low.replace(/\s*[a-z]+$/, "") : low;
}

/** Coarse, human duration: "45 sec", "3 min", "1 hr 10 min". */
export function formatDurationApprox(totalSeconds: number): string {
  const seconds = Math.max(Math.round(totalSeconds), 0);
  if (seconds < 60) return `${Math.max(seconds, 1)} sec`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

/** The elapsed clock: "04:12", or "1:04:12" past an hour. */
export function formatElapsed(totalSeconds: number): string {
  const seconds = Math.max(Math.floor(totalSeconds), 0);
  const h = Math.floor(seconds / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  const s = seconds % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Seconds between two persisted timestamps, or between one and now.
 *
 * NEVER NEGATIVE. Server and browser clocks disagree by seconds routinely, and
 * a run that started 400ms ago according to Postgres and 200ms in the future
 * according to the laptop must render "00:00", not "-00:01".
 */
export function elapsedSeconds(
  startedAt: string | null | undefined,
  endedAt: string | null | undefined,
  nowMs: number,
): number {
  if (!startedAt) return 0;
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return 0;

  const end = endedAt ? Date.parse(endedAt) : nowMs;
  const finish = Number.isFinite(end) ? end : nowMs;

  return Math.max(Math.floor((finish - start) / 1_000), 0);
}
