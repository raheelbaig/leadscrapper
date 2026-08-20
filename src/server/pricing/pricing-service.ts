import "server-only";

import { PLACES_FIELD_MASK } from "@/lib/constants";

import {
  catalogAgeDays,
  getPricingCatalog,
  isCatalogStale,
  reserveFor,
  type PricingCatalog,
} from "./catalog.schema";

/**
 * The pricing service: the ONLY way business logic learns a Google number.
 *
 * Nothing outside this module may read `catalog.json`, and no free allowance,
 * price, reserve or billing timezone may be written as a literal anywhere in
 * `places/`, `geo/`, `grid/`, `coverage/`, `search/` or `export/`. Correcting a
 * Google price must stay a config change, never a code change.
 *
 * Classification is data-driven for the same reason. A single Enterprise field
 * bills the WHOLE request at Enterprise, so the tier is derived from the field
 * mask through the catalog's `fieldTiers` map rather than assumed. Adding a
 * field to the mask therefore cannot silently change what a search costs.
 */

export type SkuId = string;

export class PricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PricingError";
  }
}

export type SkuConfig = {
  sku: SkuId;
  label: string;
  tierRank: number;
  freeCallsPerMonth: number;
  pricePer1000: number;
  /** Derived from the catalog's safety block, never hardcoded. */
  reserve: number;
  /** `freeCallsPerMonth - reserve`, floored at zero. */
  effectiveLimit: number;
};

export type Classification = {
  sku: SkuId;
  label: string;
  tierRank: number;
  /** Normalized, de-duplicated, sorted. */
  fields: string[];
  knownFields: string[];
  unknownFields: string[];
  /** The first field at the winning tier -- the reason this SKU was chosen. */
  decidingField: string | null;
  /**
   * True when an unrecognised field forced the most expensive tier. An unknown
   * field is treated as potentially Enterprise: guessing low would authorise a
   * request under a cheaper allowance than Google actually charges against.
   */
  escalatedForUnknown: boolean;
};

export type CostEstimate = {
  sku: SkuId;
  calls: number;
  /** Calls covered by the free allowance, given `alreadyUsed`. */
  freeCallsApplied: number;
  billableCalls: number;
  estimatedCostUsd: number;
  withinFreeAllowance: boolean;
};

export type StalenessInfo = {
  version: string;
  verified: boolean;
  lastVerified: string;
  ageDays: number;
  stale: boolean;
  stalenessWarnAfterDays: number;
  sourceUrl: string;
};

/**
 * Endpoint -> SKU. Kept here rather than in the calling module so that the geo
 * and places layers never spell a SKU id out for themselves. Validated against
 * the catalog on use, so renaming a SKU fails loudly instead of silently
 * metering against a counter nobody reads.
 */
const ENDPOINT_SKUS = {
  geocoding: "geocoding-essentials",
} as const;

export type EndpointName = keyof typeof ENDPOINT_SKUS;

function catalog(): PricingCatalog {
  return getPricingCatalog();
}

/** Accepts `places.websiteUri` or the bare `websiteUri`. */
function normalizeField(field: string, fieldTiers: Record<string, string>): string {
  const trimmed = field.trim();
  if (trimmed in fieldTiers) return trimmed;
  const prefixed = `places.${trimmed}`;
  return prefixed in fieldTiers ? prefixed : trimmed;
}

export function getVersion(): string {
  return catalog().version;
}

export function isVerified(): boolean {
  return catalog().verified;
}

export function isStale(): boolean {
  return isCatalogStale(catalog());
}

export function getStalenessInfo(): StalenessInfo {
  const c = catalog();
  return {
    version: c.version,
    verified: c.verified,
    lastVerified: c.lastVerified,
    ageDays: catalogAgeDays(c),
    stale: isCatalogStale(c),
    stalenessWarnAfterDays: c.stalenessWarnAfterDays,
    sourceUrl: c.sourceUrl,
  };
}

/** The timezone the monthly free allowance resets in. Never UTC. */
export function getBillingTimezone(): string {
  return catalog().billingTimezone;
}

export function getSafety() {
  return catalog().safety;
}

export function listSkuIds(): SkuId[] {
  return Object.keys(catalog().skus);
}

export function hasSku(sku: SkuId): boolean {
  return sku in catalog().skus;
}

export function getSkuConfig(sku: SkuId): SkuConfig {
  const c = catalog();
  const entry = c.skus[sku];
  if (!entry) {
    throw new PricingError(`Unknown SKU "${sku}". Known SKUs: ${Object.keys(c.skus).join(", ")}.`);
  }

  const reserve = reserveFor(c, entry.freeCallsPerMonth);
  return {
    sku,
    label: entry.label,
    tierRank: entry.tierRank,
    freeCallsPerMonth: entry.freeCallsPerMonth,
    pricePer1000: entry.pricePer1000,
    reserve,
    effectiveLimit: Math.max(entry.freeCallsPerMonth - reserve, 0),
  };
}

export function listSkuConfigs(): SkuConfig[] {
  return listSkuIds().map(getSkuConfig);
}

export function getFreeLimit(sku: SkuId): number {
  return getSkuConfig(sku).freeCallsPerMonth;
}

export function getPricePer1000(sku: SkuId): number {
  return getSkuConfig(sku).pricePer1000;
}

/** The safety margin withheld from the free allowance for this SKU. */
export function getReserve(sku: SkuId): number {
  return getSkuConfig(sku).reserve;
}

/** `freeLimit - reserve`. The ceiling `reserve_api_calls()` enforces. */
export function getEffectiveLimit(sku: SkuId): number {
  return getSkuConfig(sku).effectiveLimit;
}

/**
 * Derives the billing SKU from a field mask.
 *
 * The highest tier any single field belongs to decides the tier for the whole
 * request -- that is how Google bills, and modelling it any other way would
 * under-count the expensive allowance.
 */
export function classify(fieldMask: readonly string[]): Classification {
  const c = catalog();
  const { fieldTiers, skus } = c;

  const fields = Array.from(
    new Set(fieldMask.map((f) => normalizeField(f, fieldTiers)).filter((f) => f.length > 0)),
  ).sort();

  if (fields.length === 0) {
    // Google rejects a request with no field mask, and an unclassifiable
    // request cannot be metered. Refusing is the only safe answer.
    throw new PricingError(
      "Cannot classify an empty field mask. Every Places request must declare X-Goog-FieldMask.",
    );
  }

  const knownFields = fields.filter((f) => f in fieldTiers);
  const unknownFields = fields.filter((f) => !(f in fieldTiers));

  // The classifiable universe: only SKUs some field can actually select. The
  // Geocoding SKU is never reachable from a Places field mask.
  const familySkus = Array.from(new Set(Object.values(fieldTiers)));
  const highestFamilySku = familySkus.reduce((best, sku) =>
    skus[sku].tierRank > skus[best].tierRank ? sku : best,
  );

  let sku = highestFamilySku;
  let decidingField: string | null = null;

  if (unknownFields.length > 0) {
    // Fail expensive, not cheap.
    decidingField = unknownFields[0];
  } else {
    let bestRank = -Infinity;
    for (const field of knownFields) {
      const candidate = fieldTiers[field];
      const rank = skus[candidate].tierRank;
      if (rank > bestRank) {
        bestRank = rank;
        sku = candidate;
        decidingField = field;
      }
    }
  }

  return {
    sku,
    label: skus[sku].label,
    tierRank: skus[sku].tierRank,
    fields,
    knownFields,
    unknownFields,
    decidingField,
    escalatedForUnknown: unknownFields.length > 0,
  };
}

/**
 * The SKU every lead search bills against, derived from the real field mask
 * rather than named. Phone and website are Enterprise fields and both are
 * required by the product, so this resolves to Enterprise.
 */
export function getPrimarySku(): SkuId {
  return classify(PLACES_FIELD_MASK).sku;
}

/** The SKU a non-Places endpoint bills against, e.g. bounding-box geocoding. */
export function getSkuForEndpoint(endpoint: EndpointName): SkuId {
  const sku = ENDPOINT_SKUS[endpoint];
  if (!hasSku(sku)) {
    throw new PricingError(
      `Endpoint "${endpoint}" maps to SKU "${sku}", which is not in the pricing catalog.`,
    );
  }
  return sku;
}

/**
 * What `calls` more requests WOULD cost, given how much of the free allowance
 * is already spent.
 *
 * This application never spends money: it exists so the preflight can say "this
 * would cost $X if it were not blocked", and so a non-zero figure is visible
 * evidence that the run must not proceed.
 */
export function estimateCost(args: {
  sku: SkuId;
  calls: number;
  alreadyUsed?: number;
}): CostEstimate {
  const { sku, calls } = args;
  const alreadyUsed = Math.max(args.alreadyUsed ?? 0, 0);

  if (!Number.isFinite(calls) || calls < 0) {
    throw new PricingError(`estimateCost: calls must be a non-negative number (got ${calls}).`);
  }

  const config = getSkuConfig(sku);
  const freeLimit = config.freeCallsPerMonth;

  const billedBefore = Math.max(alreadyUsed - freeLimit, 0);
  const billedAfter = Math.max(alreadyUsed + calls - freeLimit, 0);
  const billableCalls = billedAfter - billedBefore;

  return {
    sku,
    calls,
    freeCallsApplied: calls - billableCalls,
    billableCalls,
    estimatedCostUsd: (billableCalls / 1000) * config.pricePer1000,
    withinFreeAllowance: billableCalls === 0,
  };
}

/** Re-exported so callers never need to reach past the service. */
export type { PricingCatalog };

/**
 * Namespaced handle, so call sites read as `pricing.classify(mask)` and it is
 * obvious at a glance that a Google number came from the catalog.
 */
export const pricing = {
  classify,
  estimateCost,
  getBillingTimezone,
  getEffectiveLimit,
  getFreeLimit,
  getPricePer1000,
  getPrimarySku,
  getReserve,
  getSafety,
  getSkuConfig,
  getSkuForEndpoint,
  getStalenessInfo,
  getVersion,
  hasSku,
  isStale,
  isVerified,
  listSkuConfigs,
  listSkuIds,
} as const;
