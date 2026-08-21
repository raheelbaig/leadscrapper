"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Ban, Calculator, ShieldCheck } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatNumber } from "@/lib/format";

/**
 * The pre-flight panel: what this run would cost, and whether it may run.
 *
 * Two numbers are always shown side by side -- the ESTIMATE and the GUARANTEED
 * MAXIMUM -- because an estimate that fits inside the free allowance while the
 * worst case does not is precisely the situation that quietly overspends.
 *
 * Reads `/api/searches/preflight`, which reads the counter in Postgres. Nothing
 * here asks Google how much Google quota is left; that would itself be billable.
 */

export type PreflightPayload = {
  allowed: boolean;
  blocked: { code: string; title: string; message: string; action: string } | null;
  estimate: {
    sku: string;
    skuLabel: string;
    tiles: number;
    estimatedCalls: number;
    guaranteedMaxCalls: number;
    worstCaseCostUsd: number;
  };
  quota: {
    period: string;
    used: number;
    freeLimit: number;
    reserve: number;
    effectiveLimit: number;
    remaining: number;
    percentUsed: number;
  };
  pricing: { version: string; verified: boolean };
  worstCaseExceedsQuota: boolean;
};

export function usePreflight() {
  return useQuery<PreflightPayload>({
    queryKey: ["searches", "preflight"],
    queryFn: async () => {
      const response = await fetch("/api/searches/preflight");
      if (!response.ok) throw new Error(`Pre-flight failed: ${response.status}`);
      return response.json();
    },
    staleTime: 15_000,
  });
}

function Figure({
  label,
  value,
  hint,
  emphasis,
}: {
  label: string;
  value: string;
  hint?: string;
  emphasis?: boolean;
}) {
  return (
    <div className="space-y-0.5">
      <p className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
        {label}
      </p>
      <p
        className={
          emphasis
            ? "text-lg font-semibold tabular-nums text-amber-600 dark:text-amber-400"
            : "text-lg font-semibold tabular-nums"
        }
      >
        {value}
      </p>
      {hint ? <p className="text-muted-foreground text-[11px]">{hint}</p> : null}
    </div>
  );
}

/** The blocked banner, reusable wherever a run can be refused. */
export function PreflightBlockedBanner({
  block,
}: {
  block: { code: string; title: string; message: string; action: string };
}) {
  const isPricing = block.code === "pricing-unverified";

  return (
    <Alert variant="destructive">
      {isPricing ? <AlertTriangle className="size-4" /> : <Ban className="size-4" />}
      <AlertTitle className="font-mono tracking-wide">{block.title}</AlertTitle>
      <AlertDescription className="space-y-2">
        <p className="font-medium">{block.message}</p>
        <p className="text-sm opacity-90">{block.action}</p>
      </AlertDescription>
    </Alert>
  );
}

export function PreflightPanel() {
  const { data, isPending, isError } = usePreflight();

  if (isPending) {
    return (
      <Card>
        <CardHeader className="gap-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-64" />
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="space-y-1.5">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-5 w-16" />
            </div>
          ))}
        </CardContent>
      </Card>
    );
  }

  if (isError || !data) {
    return (
      <Alert>
        <AlertTriangle className="size-4" />
        <AlertTitle>Pre-flight unavailable</AlertTitle>
        <AlertDescription>
          The estimate could not be computed. Nothing has been spent — this check only reads.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      {data.blocked ? <PreflightBlockedBanner block={data.blocked} /> : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Calculator className="text-muted-foreground size-4" />
            Pre-flight
            {data.allowed ? (
              <span className="ml-auto flex items-center gap-1.5 text-xs font-normal text-emerald-600 dark:text-emerald-400">
                <ShieldCheck className="size-3.5" />
                Cleared
              </span>
            ) : null}
          </CardTitle>
          <CardDescription>
            {data.estimate.skuLabel} · billing period {data.quota.period} · catalog{" "}
            {data.pricing.version}
          </CardDescription>
        </CardHeader>

        <CardContent className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <Figure
            label="Estimated calls"
            value={formatNumber(data.estimate.estimatedCalls)}
            hint={`${data.estimate.tiles} tile × 1 page`}
          />
          <Figure
            label="Guaranteed max"
            value={formatNumber(data.estimate.guaranteedMaxCalls)}
            hint="Including every retry"
            emphasis={data.worstCaseExceedsQuota}
          />
          <Figure
            label="Free quota left"
            value={formatNumber(data.quota.remaining)}
            hint={`of ${formatNumber(data.quota.effectiveLimit)} usable`}
          />
          <Figure
            label="Worst-case cost"
            value={`$${data.estimate.worstCaseCostUsd.toFixed(2)}`}
            hint={
              data.estimate.worstCaseCostUsd === 0
                ? "Inside the free allowance"
                : "Which is why the run is refused"
            }
            emphasis={data.estimate.worstCaseCostUsd > 0}
          />
        </CardContent>

        {data.worstCaseExceedsQuota && data.allowed ? (
          <CardContent className="pt-0">
            <Alert className="border-amber-500/40 bg-amber-500/5">
              <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400" />
              <AlertTitle>The estimate fits, the worst case does not</AlertTitle>
              <AlertDescription>
                {formatNumber(data.estimate.estimatedCalls)} call(s) expected, but up to{" "}
                {formatNumber(data.estimate.guaranteedMaxCalls)} if every request has to be retried
                — more than the {formatNumber(data.quota.remaining)} remaining. The budget guard
                would stop the run part-way and keep whatever it had already collected.
              </AlertDescription>
            </Alert>
          </CardContent>
        ) : null}
      </Card>
    </div>
  );
}
