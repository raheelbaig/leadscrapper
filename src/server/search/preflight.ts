import "server-only";

import { PLACES_FIELD_MASK } from "@/lib/constants";
import type { PricingStatus } from "@/lib/types/usage";
import * as pricing from "@/server/pricing/pricing-service";
import { getQuotaSnapshot, type QuotaClient } from "@/server/quota/quota-service";

import { PHASE_3A_LIMITS } from "./limits";

/**
 * The pre-flight check every run must pass before a single Google request is
 * made.
 *
 * Two gates, in this order:
 *
 *   1. PRICING VERIFICATION. Every budget decision in this application is made
 *      from the numbers in the pricing catalog. While those numbers are
 *      unconfirmed, a "you have 950 calls left" is not a fact, it is a guess --
 *      and authorising a billable request on a guess is exactly what the
 *      FREE-ONLY guarantee exists to prevent. This gate is checked BEFORE the
 *      worker lease is taken, so a blocked run leaves no trace to clean up.
 *
 *   2. BUDGET. Can the protected free allowance actually absorb the worst case?
 *
 * Neither gate may be bypassed by a flag, a query parameter, or a value sent
 * from the browser.
 */

export type BlockCode =
  | "pricing-unverified"
  | "quota-exhausted"
  | "quota-insufficient";

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
  tiles: number;
  /**
   * What the run is expected to cost, at one page per tile in Phase 3A.
   */
  estimatedCalls: number;
  /**
   * The ceiling: tiles x maxPagesPerTile x attempts. Shown as a SEPARATE number
   * from the estimate, because an estimate that fits while the worst case does
   * not is the situation that quietly overspends.
   */
  guaranteedMaxCalls: number;
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

/** The exact wording required by the Phase 3A specification. */
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
  /** Defaults to the Phase 3A single tile. */
  tiles?: number;
};

export async function runPreflight(options: PreflightOptions = {}): Promise<PreflightResult> {
  const tiles = options.tiles ?? PHASE_3A_LIMITS.maxSeedTiles;

  // The SKU is DERIVED from the field mask that will actually be sent, never
  // named. Phone and website are Enterprise fields and both are required, so
  // this resolves to Enterprise -- and if the mask ever changed, the estimate
  // would follow it instead of quietly staying wrong.
  const sku = pricing.classify(PLACES_FIELD_MASK).sku;
  const config = pricing.getSkuConfig(sku);

  const estimatedCalls = tiles * PHASE_3A_LIMITS.maxPagesPerTile;
  const guaranteedMaxCalls =
    tiles * PHASE_3A_LIMITS.maxPagesPerTile * PHASE_3A_LIMITS.maxAttemptsPerPage;

  const snapshot = await getQuotaSnapshot(sku, { db: options.db });

  const estimate: PreflightEstimate = {
    sku,
    skuLabel: config.label,
    tiles,
    estimatedCalls,
    guaranteedMaxCalls,
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

  // Gate 2: budget.
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
        message: `This run needs ${estimatedCalls} call(s) but only ${snapshot.remaining} remain in the protected allowance.`,
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
