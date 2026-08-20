import "server-only";

import {
  billingDayKeyFor,
  billingPeriod,
  billingPeriodDayKeys,
  currentBillingPeriod,
  formatDayKeyShort,
  type BillingPeriod,
} from "@/lib/billing-period";
import type {
  PricingStatus,
  RunUsage,
  SkuUsage,
  UsageDayPoint,
  UsageHistory,
  UsageOverview,
} from "@/lib/types/usage";
import { getSupabaseServerClient } from "@/server/db/server-client";
import * as pricing from "@/server/pricing/pricing-service";
import { getAllQuotaSnapshots, type QuotaClient } from "@/server/quota/quota-service";

/**
 * Builds the sanitized usage payload shown on `/usage`, on the dashboard, and
 * in the topbar indicator.
 *
 * Reads run as the signed-in user through Row Level Security -- the counter and
 * audit tables grant SELECT to `authenticated` and nothing more, so this path
 * never needs the service-role key. Writes to those tables have no client
 * policy at all and only ever happen inside the worker.
 *
 * Daily buckets are computed in the BILLING timezone, not the browser's and not
 * the database session's. The `api_call_log` indexes are on the raw timestamp
 * (a timezone-dependent index expression is not immutable and Postgres rejects
 * it), so the query supplies explicit half-open UTC ranges and the grouping
 * happens here.
 */

type ReadClient = Awaited<ReturnType<typeof getSupabaseServerClient>>;

/** How many log rows one month may contribute to the chart. */
const MAX_LOG_ROWS = 20_000;

export type UsageReportOptions = {
  db?: ReadClient;
  now?: Date;
  /** `YYYY-MM`. Defaults to the current billing month. */
  periodKey?: string;
  /** Skip the chart and per-run breakdown -- used by the topbar indicator. */
  summaryOnly?: boolean;
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

const EMPTY_HISTORY: UsageHistory = {
  days: [],
  totalCalls: 0,
  hasData: false,
  skusPresent: [],
};

type LogRow = { created_at: string; sku: string; search_id: string | null };

/**
 * Bucketed daily call counts for the period.
 *
 * Days with no calls are emitted as real zeros so the chart shows a continuous
 * month rather than a gap that reads like missing data. Future days of the
 * current month are omitted -- an empty bar for tomorrow is not information.
 */
function buildHistory(rows: LogRow[], period: BillingPeriod, now: Date): UsageHistory {
  const timeZone = period.timeZone;
  const todayKey = billingDayKeyFor(now, timeZone);

  const counts = new Map<string, Map<string, number>>();
  const skusPresent = new Set<string>();
  let totalCalls = 0;

  for (const row of rows) {
    const dayKey = billingDayKeyFor(new Date(row.created_at), timeZone);
    const bySku = counts.get(dayKey) ?? new Map<string, number>();
    bySku.set(row.sku, (bySku.get(row.sku) ?? 0) + 1);
    counts.set(dayKey, bySku);
    skusPresent.add(row.sku);
    totalCalls += 1;
  }

  const days: UsageDayPoint[] = billingPeriodDayKeys(period)
    .filter((dayKey) => dayKey <= todayKey)
    .map((dayKey) => {
      const bySku = counts.get(dayKey);
      return {
        day: dayKey,
        label: formatDayKeyShort(dayKey),
        total: bySku ? Array.from(bySku.values()).reduce((a, b) => a + b, 0) : 0,
        bySku: bySku ? Object.fromEntries(bySku) : {},
      };
    });

  return {
    days,
    totalCalls,
    hasData: totalCalls > 0,
    skusPresent: Array.from(skusPresent).sort(),
  };
}

async function buildRuns(db: ReadClient, rows: LogRow[]): Promise<RunUsage[]> {
  const callsBySearch = new Map<string, number>();
  for (const row of rows) {
    if (!row.search_id) continue;
    callsBySearch.set(row.search_id, (callsBySearch.get(row.search_id) ?? 0) + 1);
  }
  if (callsBySearch.size === 0) return [];

  const { data } = await db
    .from("searches")
    .select("id, niche, label, status")
    .in("id", Array.from(callsBySearch.keys()));

  const searches = new Map((data ?? []).map((s) => [s.id, s]));

  return Array.from(callsBySearch.entries())
    .map(([searchId, calls]) => {
      const search = searches.get(searchId);
      return {
        searchId,
        niche: search?.niche ?? "Unknown search",
        label: search?.label ?? searchId,
        status: search?.status ?? "unknown",
        calls,
      };
    })
    .sort((a, b) => b.calls - a.calls);
}

export async function getUsageOverview(options: UsageReportOptions = {}): Promise<UsageOverview> {
  const db = options.db ?? (await getSupabaseServerClient());
  const now = options.now ?? new Date();
  const timeZone = pricing.getBillingTimezone();

  const period = options.periodKey
    ? billingPeriod(options.periodKey, timeZone)
    : currentBillingPeriod(timeZone, now);

  const primarySku = pricing.getPrimarySku();

  const snapshots = await getAllQuotaSnapshots({ db: db as unknown as QuotaClient });

  const skus: SkuUsage[] = snapshots.map((snapshot) => {
    const config = pricing.getSkuConfig(snapshot.sku);
    return {
      sku: snapshot.sku,
      label: snapshot.label,
      tierRank: config.tierRank,
      freeLimit: snapshot.freeLimit,
      reserve: snapshot.reserve,
      used: snapshot.used,
      effectiveLimit: snapshot.effectiveLimit,
      remaining: snapshot.remaining,
      protectedRemaining: snapshot.protectedRemaining,
      percentUsed: snapshot.percentUsed,
      percentUsedClamped: snapshot.percentUsedClamped,
      health: snapshot.health,
      state: snapshot.state,
      pricePer1000: config.pricePer1000,
      isPrimary: snapshot.sku === primarySku,
    };
  });

  const base = {
    generatedAt: now.toISOString(),
    mode: "FREE_ONLY" as const,
    period: {
      key: period.key,
      label: period.label,
      start: period.start.toISOString(),
      end: period.end.toISOString(),
      timeZone,
    },
    pricing: toPricingStatus(),
    skus,
    primarySku,
    totalCallsThisPeriod: skus.reduce((sum, s) => sum + s.used, 0),
  };

  if (options.summaryOnly) {
    return { ...base, history: EMPTY_HISTORY, runs: [], anyCallEverRecorded: false };
  }

  // Half-open range on the raw timestamp: `start <= created_at < end`. The
  // boundaries come from the billing timezone, so a call made at 23:30 Pacific
  // on the last day of the month belongs to that month and not the next one.
  const [logResult, everResult] = await Promise.all([
    db
      .from("api_call_log")
      .select("created_at, sku, search_id")
      .eq("billable", true)
      .gte("created_at", period.start.toISOString())
      .lt("created_at", period.end.toISOString())
      .order("created_at", { ascending: true })
      .limit(MAX_LOG_ROWS),
    db.from("api_call_log").select("id", { count: "exact", head: true }),
  ]);

  const rows = (logResult.data ?? []) as LogRow[];

  return {
    ...base,
    history: buildHistory(rows, period, now),
    runs: await buildRuns(db, rows),
    anyCallEverRecorded: (everResult.count ?? 0) > 0,
  };
}

/** Period + per-SKU figures only. Used by the topbar quota indicator. */
export function getUsageSummary(options: UsageReportOptions = {}): Promise<UsageOverview> {
  return getUsageOverview({ ...options, summaryOnly: true });
}
