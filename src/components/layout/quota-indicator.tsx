"use client";

import { useQuery } from "@tanstack/react-query";
import { Gauge } from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatNumber } from "@/lib/format";
import { QUOTA_STATE_META } from "@/lib/quota";
import type { UsageOverview } from "@/lib/types/usage";
import { cn } from "@/lib/utils";

/**
 * The always-visible Google usage reading in the application shell.
 *
 * ---------------------------------------------------------------------------
 * IT SAYS WHOSE API IT IS, AND COUNTS AGAINST THE REAL ALLOWANCE.
 *
 * This used to read `API 188 / 950`, which was wrong twice over. "API" gave no
 * hint which API -- and by far the most numerous outbound requests this product
 * makes are the ordinary website reads of email discovery, which are not
 * Google, not billed, and not counted here at all. And 950 is the free
 * allowance minus an internal safety reserve, so the denominator was a number
 * the user has no reason to recognise and never agreed to.
 *
 * It now reads `Google 188 / 1,000` against the real monthly free allowance,
 * with the reserve explained in the tooltip where it belongs. The full
 * breakdown -- Google versus website checks versus geocoding -- lives on the
 * results page, next to the run that caused it.
 *
 * Still no Google request is made to produce this. The counter in Postgres is
 * the only thing the budget guard trusts, so it is the only thing displayed.
 * ---------------------------------------------------------------------------
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
          <span
            aria-label={`Google API usage: ${primary.used} of ${primary.freeLimit} free monthly requests used. ${meta.label}.`}
            className="hidden items-center gap-1.5 rounded-md border px-2 py-1 text-xs sm:flex"
          />
        }
      >
        <Gauge className={cn("size-3.5", meta.textClass)} />
        <span className="text-muted-foreground">Google</span>
        <span className="font-medium tabular-nums">
          {formatNumber(primary.used)}
          <span className="text-muted-foreground"> / {formatNumber(primary.freeLimit)}</span>
        </span>
        <span className="text-muted-foreground border-l pl-1.5 text-[10px] tracking-wide uppercase">
          Free only
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72 space-y-1">
        <p className="font-medium">Google Places — {data.period.label}</p>
        <p>
          {formatNumber(primary.used)} of the {formatNumber(primary.freeLimit)} free monthly
          requests used. Only free usage is ever made.
        </p>
        <p className="text-muted-foreground">
          Business-website checks for email discovery are not counted here — they are ordinary
          requests to those sites and cost nothing.
        </p>
        <p className="text-muted-foreground">
          {formatNumber(primary.reserve)} requests are held back as a safety reserve, so searching
          stops at {formatNumber(primary.effectiveLimit)}.
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
