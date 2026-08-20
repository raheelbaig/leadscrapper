import "server-only";

import {
  billingPeriodKeyFor,
  currentBillingPeriod,
  type BillingPeriod,
} from "@/lib/billing-period";
import {
  deriveQuotaFigures,
  resolveQuotaState,
  type QuotaFigures,
  type QuotaState,
} from "@/lib/quota";
import { getSupabaseAdminClient } from "@/server/db/admin";
import * as pricing from "@/server/pricing/pricing-service";

/**
 * The quota service: the server-side face of the verified Postgres quota RPCs.
 *
 * FREE ONLY is the only mode. There is no paid path, no override flag, and no
 * automatic overage. This module does not re-implement the budget guard -- the
 * guard is `public.reserve_api_calls()`, which is atomic inside a row lock and
 * is the one place that can truthfully say whether a call may be made. What
 * this module does is supply that function with the right numbers, from the
 * pricing catalog, in the right billing timezone.
 *
 * The browser never reaches any of this. It cannot write the counter tables
 * (RLS grants SELECT only) and cannot execute the reserve/release/record RPCs
 * (EXECUTE is revoked from `authenticated`). A usage number supplied by a
 * client is never trusted anywhere.
 */

/**
 * Only `rpc` is required, so a read path may hand in the RLS-bound request
 * client instead of the service-role one. `quota_snapshot` is granted to
 * `authenticated`; reserve/release/record are not, and are service-role only.
 */
export type QuotaClient = Pick<ReturnType<typeof getSupabaseAdminClient>, "rpc">;

export class QuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaError";
  }
}

/**
 * Thrown when a reservation is refused for a reason that is not "out of quota":
 * today, that the pricing catalog is still unverified.
 */
export class QuotaBlockedError extends Error {
  readonly reason: "pricing-unverified";
  constructor(message: string, reason: "pricing-unverified") {
    super(message);
    this.name = "QuotaBlockedError";
    this.reason = reason;
  }
}

export type QuotaSnapshot = QuotaFigures & {
  sku: string;
  label: string;
  /** `YYYY-MM` in the billing timezone. */
  period: string;
  timeZone: string;
  state: QuotaState;
};

export type ReserveResult = {
  granted: boolean;
  sku: string;
  requested: number;
  used: number;
  remaining: number;
  period: string;
  effectiveLimit: number;
};

type Options = { db?: QuotaClient };

function client(options?: Options): QuotaClient {
  return options?.db ?? getSupabaseAdminClient();
}

/** The billing month right now, in the catalog's timezone. */
export function getCurrentPeriod(now: Date = new Date()): BillingPeriod {
  return currentBillingPeriod(pricing.getBillingTimezone(), now);
}

export function getPeriodKey(instant: Date = new Date()): string {
  return billingPeriodKeyFor(instant, pricing.getBillingTimezone());
}

function toSnapshot(args: {
  sku: string;
  label: string;
  freeLimit: number;
  reserve: number;
  used: number;
  period: string;
  timeZone: string;
}): QuotaSnapshot {
  const figures = deriveQuotaFigures({
    freeLimit: args.freeLimit,
    reserve: args.reserve,
    used: args.used,
  });

  return {
    ...figures,
    sku: args.sku,
    label: args.label,
    period: args.period,
    timeZone: args.timeZone,
    state: resolveQuotaState(figures.health, pricing.isVerified()),
  };
}

/**
 * Read-only quota position for one SKU.
 *
 * Uses `quota_snapshot()`, which recomputes the period from `p_tz` inside
 * Postgres. The limit and reserve travel from the catalog to SQL as arguments,
 * so the database holds no Google number of its own and the two can never drift
 * apart.
 */
export async function getQuotaSnapshot(sku: string, options?: Options): Promise<QuotaSnapshot> {
  const config = pricing.getSkuConfig(sku);
  const timeZone = pricing.getBillingTimezone();

  const { data, error } = await client(options).rpc("quota_snapshot", {
    p_sku: sku,
    p_free_limit: config.freeCallsPerMonth,
    p_reserve: config.reserve,
    p_tz: timeZone,
  });

  if (error) {
    throw new QuotaError(`quota_snapshot(${sku}) failed: ${error.message}`);
  }

  const row = Array.isArray(data) ? data[0] : null;

  return toSnapshot({
    sku,
    label: config.label,
    freeLimit: config.freeCallsPerMonth,
    reserve: config.reserve,
    // No counter row yet simply means no call has been made this month.
    used: row?.used ?? 0,
    period: row?.period ?? getPeriodKey(),
    timeZone,
  });
}

/** Every SKU in the catalog, ordered most expensive tier first. */
export async function getAllQuotaSnapshots(options?: Options): Promise<QuotaSnapshot[]> {
  const snapshots = await Promise.all(
    pricing.listSkuIds().map((sku) => getQuotaSnapshot(sku, options)),
  );

  const primary = pricing.getPrimarySku();
  return snapshots.sort((a, b) => {
    if (a.sku === primary) return -1;
    if (b.sku === primary) return 1;
    return b.freeLimit - a.freeLimit || a.sku.localeCompare(b.sku);
  });
}

/**
 * THE chokepoint. Every Google request must pass through this before it is
 * made, and each *page* of a Text Search response is a separate billable call,
 * so a fully paginated tile reserves three times rather than once.
 *
 * Two guards, in order:
 *   1. an unverified pricing catalog blocks outright -- budget decisions made
 *      from unconfirmed free limits are not budget decisions, and
 *   2. the atomic SQL guard, which is the authoritative answer.
 */
export async function reserveCalls(
  args: { sku: string; calls: number },
  options?: Options,
): Promise<ReserveResult> {
  const { sku, calls } = args;

  if (!Number.isInteger(calls) || calls <= 0) {
    throw new QuotaError(`reserveCalls: calls must be a positive integer (got ${calls}).`);
  }

  if (!pricing.isVerified()) {
    throw new QuotaBlockedError(
      "Pricing catalog is not verified, so no Google request may be made. " +
        "Confirm the free limits and prices in src/server/pricing/catalog.json against your " +
        "Google Cloud billing account and set verified: true.",
      "pricing-unverified",
    );
  }

  const config = pricing.getSkuConfig(sku);

  const { data, error } = await client(options).rpc("reserve_api_calls", {
    p_sku: sku,
    p_n: calls,
    p_free_limit: config.freeCallsPerMonth,
    p_reserve: config.reserve,
    p_tz: pricing.getBillingTimezone(),
  });

  if (error) {
    throw new QuotaError(`reserve_api_calls(${sku}, ${calls}) failed: ${error.message}`);
  }

  const row = Array.isArray(data) ? data[0] : null;
  if (!row) {
    // The guard must fail closed: no row means no grant, never an assumed one.
    throw new QuotaError(
      `reserve_api_calls(${sku}, ${calls}) returned no row. Refusing to treat that as a grant.`,
    );
  }

  return {
    granted: row.granted,
    sku,
    requested: calls,
    used: row.used,
    remaining: row.remaining,
    period: row.period,
    effectiveLimit: row.effective_limit,
  };
}

/**
 * Refunds a reservation for a request that produced no billable response --
 * a connection error or a timeout before any HTTP status arrived. Only called
 * under the catalog's `success-only` counting mode.
 */
export async function releaseCalls(
  args: { sku: string; calls: number },
  options?: Options,
): Promise<number> {
  const { sku, calls } = args;
  if (!Number.isInteger(calls) || calls <= 0) {
    throw new QuotaError(`releaseCalls: calls must be a positive integer (got ${calls}).`);
  }

  const { data, error } = await client(options).rpc("release_api_calls", {
    p_sku: sku,
    p_n: calls,
    p_tz: pricing.getBillingTimezone(),
  });

  if (error) {
    throw new QuotaError(`release_api_calls(${sku}, ${calls}) failed: ${error.message}`);
  }

  return typeof data === "number" ? data : 0;
}

export type RecordCallArgs = {
  sku: string;
  endpoint: string;
  searchId?: string | null;
  tileId?: string | null;
  pageIndex?: number | null;
  httpStatus?: number | null;
  billable?: boolean;
  resultCount?: number | null;
  durationMs?: number | null;
  error?: string | null;
};

/**
 * Appends to the audit trail and bumps the per-run and per-tile counters in one
 * statement. This is what the usage chart, per-run usage and the learned
 * avgPagesPerTile are all computed from, and what a reconciliation against the
 * real Google console figures compares to.
 */
export async function recordCall(args: RecordCallArgs, options?: Options): Promise<number> {
  const { data, error } = await client(options).rpc("record_api_call", {
    p_sku: args.sku,
    p_endpoint: args.endpoint,
    p_tz: pricing.getBillingTimezone(),
    p_search_id: args.searchId ?? undefined,
    p_tile_id: args.tileId ?? undefined,
    p_page_index: args.pageIndex ?? undefined,
    p_http_status: args.httpStatus ?? undefined,
    p_billable: args.billable ?? true,
    p_result_count: args.resultCount ?? undefined,
    p_duration_ms: args.durationMs ?? undefined,
    p_error: args.error ?? undefined,
  });

  if (error) {
    throw new QuotaError(`record_api_call(${args.sku}) failed: ${error.message}`);
  }

  return typeof data === "number" ? data : 0;
}
