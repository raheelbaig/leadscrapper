import type { QuotaHealth, QuotaState } from "@/lib/quota";

/**
 * The sanitized usage payload.
 *
 * This is the ONLY shape that crosses from the server to the browser. It
 * carries no key, no service-role client, no raw catalog object and no Google
 * credential -- just numbers the UI is allowed to render. Client components
 * import these types; they never import `@/server/*`.
 */

export type PricingStatus = {
  version: string;
  verified: boolean;
  /** ISO date the catalog was last checked against Google Cloud billing. */
  lastVerified: string;
  ageDays: number;
  /** Unverified, or verified longer ago than the configured threshold. */
  stale: boolean;
  stalenessWarnAfterDays: number;
  sourceUrl: string;
  billingTimezone: string;
  countMode: "success-only" | "all-requests";
  reserveMode: "max" | "absolute" | "percent";
  reserveAbsolute: number;
  reservePercent: number;
};

export type SkuUsage = {
  sku: string;
  label: string;
  tierRank: number;
  /** Google's free monthly allowance. */
  freeLimit: number;
  /** Safety margin withheld from the allowance. */
  reserve: number;
  used: number;
  /** `freeLimit - reserve`, the ceiling the SQL guard enforces. */
  effectiveLimit: number;
  /** Clamped at zero, matching `quota_snapshot`. */
  remaining: number;
  /** Unclamped, so counter drift stays visible. */
  protectedRemaining: number;
  percentUsed: number;
  percentUsedClamped: number;
  health: QuotaHealth;
  state: QuotaState;
  pricePer1000: number;
  /** The SKU the lead-search flow actually bills against (Enterprise). */
  isPrimary: boolean;
};

export type UsageDayPoint = {
  /** `YYYY-MM-DD` in the billing timezone, never the browser's. */
  day: string;
  /** Short axis label, e.g. "Aug 1". */
  label: string;
  total: number;
  /** Calls per SKU on that day. Missing SKUs mean zero. */
  bySku: Record<string, number>;
};

export type UsageHistory = {
  days: UsageDayPoint[];
  totalCalls: number;
  /** False when the period has no logged calls at all -- render an empty state. */
  hasData: boolean;
  /** SKUs that actually appear in the history, for the filter control. */
  skusPresent: string[];
};

export type RunUsage = {
  searchId: string;
  label: string;
  niche: string;
  status: string;
  calls: number;
};

export type UsagePeriod = {
  key: string;
  label: string;
  /** ISO instants. Half-open: `start <= created_at < end`. */
  start: string;
  end: string;
  timeZone: string;
};

export type UsageOverview = {
  generatedAt: string;
  /** There is no other mode. Not a flag, not a setting. */
  mode: "FREE_ONLY";
  period: UsagePeriod;
  pricing: PricingStatus;
  skus: SkuUsage[];
  primarySku: string;
  history: UsageHistory;
  runs: RunUsage[];
  /** Billable calls recorded this period, across every SKU. */
  totalCallsThisPeriod: number;
  /**
   * Whether any Google request has EVER been recorded by this application.
   * Phase 2 must leave this at false.
   */
  anyCallEverRecorded: boolean;
};
