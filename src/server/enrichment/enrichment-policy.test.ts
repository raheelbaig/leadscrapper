import { describe, expect, it } from "vitest";

import {
  canAttempt,
  clampBatch,
  eligibleStatuses,
  estimateMaxRequests,
  MAX_ATTEMPTS_PER_LEAD,
  MAX_ENRICHMENT_BATCH,
  REQUESTS_PER_LEAD,
} from "./enrichment-policy";
import type { EmailStatus } from "./types";

/**
 * The rules that decide how much of somebody else's website we fetch.
 *
 * Two properties matter more than the rest:
 *
 *   1. `retry-failed` must be unable to reach a lead that is not `failed`.
 *      Retrying a `found` lead would overwrite a discovered address with
 *      whatever a second look happened to return.
 *   2. Retrying must TERMINATE. Nothing schedules enrichment, so the runaway
 *      case is a person holding down a button against a site that answers 403.
 *      The attempt cap is what makes that stop.
 */

const ALL_STATUSES: EmailStatus[] = [
  "not_enriched",
  "queued",
  "found",
  "verified",
  "unverified",
  "not_found",
  "failed",
];

const base = { website: "https://example.test", attemptCount: 0 };

describe("mode decides which leads are reachable at all", () => {
  it("a new batch touches only leads never checked", () => {
    expect(eligibleStatuses("new")).toEqual(["not_enriched"]);
  });

  it("a retry batch touches only leads that failed", () => {
    expect(eligibleStatuses("retry-failed")).toEqual(["failed"]);
  });

  it("retry refuses every status except failed", () => {
    for (const status of ALL_STATUSES) {
      const decision = canAttempt({ ...base, mode: "retry-failed", status });
      expect(decision.eligible).toBe(status === "failed");
    }
  });

  it("a new batch refuses every status except not_enriched", () => {
    for (const status of ALL_STATUSES) {
      const decision = canAttempt({ ...base, mode: "new", status });
      expect(decision.eligible).toBe(status === "not_enriched");
    }
  });

  it("REFUSES to retry a lead where an address was already found", () => {
    // The destructive case: a second look could return something worse, or
    // nothing, and overwrite a good address.
    const decision = canAttempt({ ...base, mode: "retry-failed", status: "found" });

    expect(decision.eligible).toBe(false);
    if (!decision.eligible) expect(decision.reason).toMatch(/only touches leads that failed/);
  });

  it("refuses a lead with no website in either mode", () => {
    for (const mode of ["new", "retry-failed"] as const) {
      const status: EmailStatus = mode === "new" ? "not_enriched" : "failed";
      for (const website of [null, "", "   "]) {
        const decision = canAttempt({ mode, status, website, attemptCount: 0 });
        expect(decision.eligible).toBe(false);
        if (!decision.eligible) expect(decision.reason).toMatch(/no website/);
      }
    }
  });
});

describe("retrying terminates", () => {
  it("allows attempts up to the cap and refuses at it", () => {
    for (let n = 0; n < MAX_ATTEMPTS_PER_LEAD; n += 1) {
      expect(
        canAttempt({ ...base, mode: "retry-failed", status: "failed", attemptCount: n }).eligible,
      ).toBe(true);
    }

    const atCap = canAttempt({
      ...base,
      mode: "retry-failed",
      status: "failed",
      attemptCount: MAX_ATTEMPTS_PER_LEAD,
    });

    expect(atCap.eligible).toBe(false);
    if (!atCap.eligible) expect(atCap.reason).toMatch(/the cap is 3/);
  });

  it("stays refused however many more times it is pressed", () => {
    // The "no automatic retry loop" property, expressed as the thing that
    // actually protects the remote host: pressing the button again changes
    // nothing once the cap is reached.
    for (const attemptCount of [3, 4, 10, 100]) {
      expect(
        canAttempt({ ...base, mode: "retry-failed", status: "failed", attemptCount }).eligible,
      ).toBe(false);
    }
  });

  it("caps a new batch too, not just retries", () => {
    expect(
      canAttempt({
        ...base,
        mode: "new",
        status: "not_enriched",
        attemptCount: MAX_ATTEMPTS_PER_LEAD,
      }).eligible,
    ).toBe(false);
  });

  it("has a cap small enough to be a real bound", () => {
    expect(MAX_ATTEMPTS_PER_LEAD).toBe(3);
  });
});

describe("batch size is clamped on the server", () => {
  it("caps anything larger than the batch limit", () => {
    for (const requested of [26, 100, 10_000, Number.MAX_SAFE_INTEGER]) {
      expect(clampBatch(requested)).toBe(MAX_ENRICHMENT_BATCH);
    }
  });

  it("floors anything smaller than one", () => {
    for (const requested of [0, -1, -500]) {
      expect(clampBatch(requested)).toBe(1);
    }
  });

  it("passes a sensible request through untouched", () => {
    expect(clampBatch(1)).toBe(1);
    expect(clampBatch(5)).toBe(5);
    expect(clampBatch(MAX_ENRICHMENT_BATCH)).toBe(MAX_ENRICHMENT_BATCH);
  });

  it("survives rubbish without opening the gate", () => {
    // A browser can send anything; the clamp is what makes that harmless.
    expect(clampBatch(undefined)).toBe(10);
    expect(clampBatch(Number.NaN)).toBe(10);
    expect(clampBatch(Number.POSITIVE_INFINITY)).toBe(10);
    expect(clampBatch(7.9)).toBe(7);
  });

  it("keeps the batch cap small", () => {
    expect(MAX_ENRICHMENT_BATCH).toBe(25);
  });
});

describe("the request estimate shown for confirmation", () => {
  it("is the WORST case, not an average", () => {
    // robots.txt plus four pages. A person approving a run should see the
    // largest number it could reach.
    expect(REQUESTS_PER_LEAD).toBe(5);
    expect(estimateMaxRequests(3)).toBe(15);
    expect(estimateMaxRequests(1)).toBe(5);
  });

  it("is zero when nothing is selected", () => {
    expect(estimateMaxRequests(0)).toBe(0);
    expect(estimateMaxRequests(-5)).toBe(0);
  });

  it("can never exceed what the batch cap permits", () => {
    const ceiling = estimateMaxRequests(clampBatch(Number.MAX_SAFE_INTEGER));
    expect(ceiling).toBe(MAX_ENRICHMENT_BATCH * REQUESTS_PER_LEAD);
    expect(ceiling).toBe(125);
  });
});
