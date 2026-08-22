import "server-only";

import { INITIAL_AVG_PAGES_PER_TILE, PLACES_FIELD_MASK } from "@/lib/constants";
import type { PricingStatus } from "@/lib/types/usage";
import * as pricing from "@/server/pricing/pricing-service";
import { getQuotaSnapshot, type QuotaClient } from "@/server/quota/quota-service";

import { SEARCH_LIMITS, maxTilesAfterSubdivision } from "./limits";

/**
 * The pre-flight check every run must pass before a single Google request is
 * made.
 *
 * Three gates, in this order:
 *
 *   1. PRICING VERIFICATION. Every budget decision in this application is made
 *      from the numbers in the pricing catalog. While those numbers are
 *      unconfirmed, a "948 calls left" is not a fact, it is a guess -- and
 *      authorising a billable request on a guess is exactly what the FREE-ONLY
 *      guarantee exists to prevent. This gate is checked BEFORE the worker
 *      lease is taken, so a blocked run leaves no trace to clean up.
 *
 *   2. THE PER-SEARCH CALL BUDGET. New in Phase 3B, and the gate that does the
 *      real work now. Pagination, multi-tile grids and subdivision mean the
 *      geometry alone no longer bounds the cost of a run; a fixed budget does.
 *
 *   3. FREE QUOTA. Can the protected free allowance absorb what this run wants?
 *
 * None of them may be bypassed by a flag, a query parameter, or a value sent
 * from the browser.
 */

export type BlockCode =
  "pricing-unverified" | "call-budget-spent" | "quota-exhausted" | "quota-insufficient";

export type PreflightBlock = {
  code: BlockCode;
  /** The banner headline, shown verbatim in the UI. */
  title: string;
  /** The one-line reason. */
  message: string;
  /** What the user has to do about it. */
  action: string;
};

export type PreflightEstimate = {
  sku: string;
  skuLabel: string;
  /** Tiles this run would actually work through -- pending leaves on a resume. */
  tiles: number;
  pagesPerTile: number;
  attemptsPerPage: number;
  maxSubdivisionDepth: number;
  /**
   * What the run is expected to cost: tiles x the learned average pages per
   * tile. An expectation, not a promise.
   */
  estimatedCalls: number;
  /**
   * What GEOMETRY alone permits: every tile saturating and subdividing all the
   * way down, every page fetched, every attempt retried. Reported even though
   * the budget caps it, because quoting only the capped number would hide how
   * far a bug could run before the cap caught it.
   */
  geometricMaxCalls: number;
  /** The per-search ceiling, cumulative across resumes. */
  callBudget: number;
  /** Billable calls this search has already made. */
  callsAlreadySpent: number;
  /** What is left of the budget. */
  callBudgetRemaining: number;
  /**
   * The number that actually binds: min(geometry, budget). Shown as a SEPARATE
   * figure from the estimate, because an estimate that fits while the worst
   * case does not is the situation that quietly overspends.
   */
  guaranteedMaxCalls: number;
  /** True when the budget, not the geometry, is what stops the run. */
  budgetBinds: boolean;
  /** What those calls would cost if they fell outside the free allowance. */
  worstCaseCostUsd: number;
};

export type PreflightQuota = {
  period: string;
  used: number;
  freeLimit: number;
  reserve: number;
  effectiveLimit: number;
  remaining: number;
  percentUsed: number;
};

export type PreflightResult = {
  allowed: boolean;
  blocked: PreflightBlock | null;
  estimate: PreflightEstimate;
  quota: PreflightQuota;
  pricing: PricingStatus;
  /** True when the estimate fits but the worst case does not. */
  worstCaseExceedsQuota: boolean;
};

/** The exact wording required by the specification. */
export const PRICING_BLOCK: PreflightBlock = {
  code: "pricing-unverified",
  title: "GOOGLE SEARCH BLOCKED",
  message: "Pricing configuration has not been verified.",
  action:
    "Confirm the free monthly allowances and prices in src/server/pricing/catalog.json against your Google Cloud billing account, then set verified: true. Until then no Google request will be made.",
};

function toPricingStatus(): PricingStatus {
  const info = pricing.getStalenessInfo();
  const safety = pricing.getSafety();

  return {
    version: info.version,
    verified: info.verified,
    lastVerified: info.lastVerified,
    ageDays: info.ageDays,
    stale: info.stale,
    stalenessWarnAfterDays: info.stalenessWarnAfterDays,
    sourceUrl: info.sourceUrl,
    billingTimezone: pricing.getBillingTimezone(),
    countMode: safety.countMode,
    reserveMode: safety.reserveMode,
    reserveAbsolute: safety.reserveAbsolute,
    reservePercent: safety.reservePercent,
  };
}

export type PreflightOptions = {
  db?: QuotaClient;
  /** Tiles the run will work through. Defaults to a single tile. */
  tiles?: number;
  pagesPerTile?: number;
  /**
   * Attempts the caller will actually allow per page.
   *
   * Taken at FACE VALUE, not clamped. This function describes the run it is
   * told about; enforcing the phase cap is the runner's job, and the runner
   * passes its own already-capped number in. Clamping here as well would make
   * the estimate silently disagree with its caller.
   */
  attemptsPerPage?: number;
  maxSubdivisionDepth?: number;
  callBudget?: number;
  /** `searches.api_calls_run`. */
  callsAlreadySpent?: number;
};

export async function runPreflight(options: PreflightOptions = {}): Promise<PreflightResult> {
  const tiles = options.tiles ?? 1;
  const pagesPerTile = options.pagesPerTile ?? SEARCH_LIMITS.maxPagesPerTile;
  const attemptsPerPage = options.attemptsPerPage ?? SEARCH_LIMITS.maxAttemptsPerPage;
  const maxSubdivisionDepth = options.maxSubdivisionDepth ?? SEARCH_LIMITS.maxSubdivisionDepth;
  const callBudget = options.callBudget ?? SEARCH_LIMITS.maxCallsPerSearch;
  const callsAlreadySpent = Math.max(options.callsAlreadySpent ?? 0, 0);
  const callBudgetRemaining = Math.max(callBudget - callsAlreadySpent, 0);

  // The SKU is DERIVED from the field mask that will actually be sent, never
  // named. Phone and website are Enterprise fields and both are required, so
  // this resolves to Enterprise -- and if the mask ever changed, the estimate
  // would follow it instead of quietly staying wrong.
  const sku = pricing.classify(PLACES_FIELD_MASK).sku;
  const config = pricing.getSkuConfig(sku);

  const estimatedCalls = Math.ceil(tiles * INITIAL_AVG_PAGES_PER_TILE);
  const geometricMaxCalls =
    maxTilesAfterSubdivision(tiles, maxSubdivisionDepth) * pagesPerTile * attemptsPerPage;
  const guaranteedMaxCalls = Math.min(geometricMaxCalls, callBudgetRemaining);

  const snapshot = await getQuotaSnapshot(sku, { db: options.db });

  const estimate: PreflightEstimate = {
    sku,
    skuLabel: config.label,
    tiles,
    pagesPerTile,
    attemptsPerPage,
    maxSubdivisionDepth,
    estimatedCalls,
    geometricMaxCalls,
    callBudget,
    callsAlreadySpent,
    callBudgetRemaining,
    guaranteedMaxCalls,
    budgetBinds: callBudgetRemaining < geometricMaxCalls,
    worstCaseCostUsd: pricing.estimateCost({
      sku,
      calls: guaranteedMaxCalls,
      alreadyUsed: snapshot.used,
    }).estimatedCostUsd,
  };

  const quota: PreflightQuota = {
    period: snapshot.period,
    used: snapshot.used,
    freeLimit: snapshot.freeLimit,
    reserve: snapshot.reserve,
    effectiveLimit: snapshot.effectiveLimit,
    remaining: snapshot.remaining,
    percentUsed: snapshot.percentUsed,
  };

  const pricingStatus = toPricingStatus();
  const worstCaseExceedsQuota = guaranteedMaxCalls > snapshot.remaining;

  // Gate 1: pricing. Checked first and independently of the budget, because a
  // comfortable-looking budget computed from unverified numbers is the most
  // dangerous state of all.
  //
  // Asked of the pricing service directly rather than read off the status
  // object: the gate has exactly one question, and there should be exactly one
  // place that answers it. `quota-service.reserveCalls` asks the same way.
  if (!pricing.isVerified()) {
    return {
      allowed: false,
      blocked: PRICING_BLOCK,
      estimate,
      quota,
      pricing: pricingStatus,
      worstCaseExceedsQuota,
    };
  }

  // Gate 2: the per-search budget. Independent of the free allowance -- this is
  // the phase's own ceiling, and it binds long before Google's does.
  if (callBudgetRemaining <= 0) {
    return {
      allowed: false,
      blocked: {
        code: "call-budget-spent",
        title: "CONTROLLED RUN BUDGET SPENT",
        message: `This search has made ${callsAlreadySpent} of its ${callBudget} permitted Google calls.`,
        action:
          "This is the per-search spending ceiling, and since the lead target no longer stops a " +
          "run it is the only thing that does. Review what the run collected and what area is " +
          "still owed, then raise maxCallsPerSearch in src/server/search/limits.ts only if the " +
          "remaining geography is genuinely worth the calls.",
      },
      estimate,
      quota,
      pricing: pricingStatus,
      worstCaseExceedsQuota,
    };
  }

  // Gate 3: the free allowance.
  if (snapshot.remaining <= 0) {
    return {
      allowed: false,
      blocked: {
        code: "quota-exhausted",
        title: "FREE PLAN LIMIT REACHED",
        message: `The protected free allowance for ${config.label} is spent for ${snapshot.period}.`,
        action: `No further Google requests will be made until the billing month resets at midnight ${pricingStatus.billingTimezone}.`,
      },
      estimate,
      quota,
      pricing: pricingStatus,
      worstCaseExceedsQuota,
    };
  }

  if (estimatedCalls > snapshot.remaining) {
    return {
      allowed: false,
      blocked: {
        code: "quota-insufficient",
        title: "NOT ENOUGH FREE QUOTA",
        message: `This run needs about ${estimatedCalls} call(s) but only ${snapshot.remaining} remain in the protected allowance.`,
        action: "Wait for the billing month to reset, or reduce the size of the run.",
      },
      estimate,
      quota,
      pricing: pricingStatus,
      worstCaseExceedsQuota,
    };
  }

  return {
    allowed: true,
    blocked: null,
    estimate,
    quota,
    pricing: pricingStatus,
    worstCaseExceedsQuota,
  };
}

export class SearchBlockedError extends Error {
  readonly block: PreflightBlock;
  readonly preflight: PreflightResult;
  readonly status = 409;

  constructor(preflight: PreflightResult) {
    const block = preflight.blocked;
    if (!block) {
      throw new Error("SearchBlockedError constructed from an allowed pre-flight");
    }
    super(`${block.title}\n\n${block.message}`);
    this.name = "SearchBlockedError";
    this.block = block;
    this.preflight = preflight;
  }
}
