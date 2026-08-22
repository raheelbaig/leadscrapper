import "server-only";

import type { EmailStatus } from "./types";

/**
 * Who may be enriched, how many at a time, and when to stop trying.
 *
 * Pure, and separate from the runner, because these are the rules that decide
 * how much of somebody else's website we are entitled to fetch. They deserve to
 * be argued with in a test rather than discovered in production.
 */

/** The most leads one request may touch. Deliberately small. */
export const MAX_ENRICHMENT_BATCH = 25;

/**
 * Attempts a single lead may ever receive.
 *
 * THIS IS THE THING THAT MAKES RETRY TERMINATE. Nothing schedules enrichment,
 * so a runaway needs a person pressing a button -- but a person pressing a
 * button repeatedly is exactly how a site that answers 403 gets hammered. After
 * three recorded attempts a lead is retired from every batch selection and can
 * only be revisited by deliberately clearing its history.
 */
export const MAX_ATTEMPTS_PER_LEAD = 3;

/** Requests one lead can cost: robots.txt, then at most four pages. */
export const REQUESTS_PER_LEAD = 5;

export type EnrichmentMode = "new" | "retry-failed";

/**
 * The `email_status` values a mode is allowed to touch.
 *
 * A mode can never widen beyond its own list, which is what makes "retry only
 * failed leads" a property of the query rather than of the caller remembering.
 * In particular `retry-failed` cannot reach a `found` lead and overwrite an
 * address that was already discovered.
 */
export function eligibleStatuses(mode: EnrichmentMode): EmailStatus[] {
  return mode === "retry-failed" ? ["failed"] : ["not_enriched"];
}

export type RetryDecision = { eligible: true } | { eligible: false; reason: string };

/**
 * Whether one lead may be attempted now.
 *
 * Applied to explicitly-named leads too. Passing an id is a request, not an
 * override: naming a `found` lead in a retry batch still refuses, because the
 * alternative is a mis-click quietly destroying a discovered address.
 */
export function canAttempt(args: {
  mode: EnrichmentMode;
  status: EmailStatus;
  website: string | null;
  attemptCount: number;
}): RetryDecision {
  if (!args.website || args.website.trim() === "") {
    return { eligible: false, reason: "no website — there is no path to an email" };
  }

  if (!eligibleStatuses(args.mode).includes(args.status)) {
    return {
      eligible: false,
      reason:
        args.mode === "retry-failed"
          ? `status is ${args.status}, and retry only touches leads that failed`
          : `status is ${args.status}, and this batch only touches leads never checked`,
    };
  }

  if (args.attemptCount >= MAX_ATTEMPTS_PER_LEAD) {
    return {
      eligible: false,
      reason: `already attempted ${args.attemptCount} time(s); the cap is ${MAX_ATTEMPTS_PER_LEAD}`,
    };
  }

  return { eligible: true };
}

/** Clamped on the SERVER, so nothing the browser sends can widen a batch. */
export function clampBatch(requested: number | undefined): number {
  const value = Number.isFinite(requested) ? Number(requested) : 10;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_ENRICHMENT_BATCH);
}

/**
 * The worst-case number of requests a batch can make to third-party sites.
 *
 * Worst case, never expected: it assumes every lead needs robots.txt plus all
 * four pages. The confirmation dialog shows this number rather than an average,
 * because the figure a person should be asked to approve is the largest one the
 * run could actually reach.
 */
export function estimateMaxRequests(leadCount: number): number {
  return Math.max(leadCount, 0) * REQUESTS_PER_LEAD;
}
