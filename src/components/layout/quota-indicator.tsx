"use client";

import { useQuery } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import Link from "next/link";

import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatNumber } from "@/lib/format";
import { QUOTA_STATE_META } from "@/lib/quota";
import type { UsageOverview } from "@/lib/types/usage";
import { cn } from "@/lib/utils";

/**
 * The always-visible quota reading in the application shell.
 *
 * Reads the database through `/api/usage?summary=1` -- no chart, no per-run
 * breakdown, and above all no Google request. Nothing here contacts Google to
 * find out how much Google quota is left; the counter in Postgres is the only
 * thing the budget guard trusts, so it is the only thing displayed.
 *
 * It shows the SKU every lead search actually bills against, which is the one
 * that runs out first.
 */
export function QuotaIndicator() {
  const { data, isPending, isError } = useQuery<UsageOverview>({
    queryKey: ["usage", "summary"],
    queryFn: async () => {
      const response = await fetch("/api/usage?summary=1");
      if (!response.ok) throw new Error(`Usage request failed: ${response.status}`);
      return response.json();
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  if (isPending) {
    return <Skeleton className="hidden h-6 w-24 rounded-md sm:block" />;
  }

  if (isError || !data) {
    return null;
  }

  const primary = data.skus.find((sku) => sku.isPrimary) ?? data.skus[0];
  if (!primary) return null;

  const meta = QUOTA_STATE_META[primary.state];

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            href="/usage"
            aria-label={`API usage: ${primary.used} of ${primary.effectiveLimit} calls used. ${meta.label}.`}
            className="hover:bg-muted hidden items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors sm:flex"
          />
        }
      >
        <Gauge className={cn("size-3.5", meta.textClass)} />
        <span className="text-muted-foreground">API</span>
        <span className="font-medium tabular-nums">
          {formatNumber(primary.used)}
          <span className="text-muted-foreground"> / {formatNumber(primary.effectiveLimit)}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 space-y-1">
        <p className="font-medium">
          {primary.label} — {data.period.label}
        </p>
        <p>
          {formatNumber(primary.remaining)} of {formatNumber(primary.effectiveLimit)} protected
          calls remaining. {formatNumber(primary.reserve)} of the {formatNumber(primary.freeLimit)}
          -call free allowance is held back as a safety reserve.
        </p>
        <p className="text-muted-foreground">{meta.description}</p>
      </TooltipContent>
    </Tooltip>
  );
}
