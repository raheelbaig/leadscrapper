import { Gauge, MapPinned, Plus, Search, Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { EmptyState } from "@/components/common/empty-state";
import { StatCard } from "@/components/common/stat-card";
import { PageHeader } from "@/components/layout/page-header";
import { SearchStatusBadge } from "@/components/search/search-status-badge";
import { PricingWarning } from "@/components/usage/pricing-warning";
import { QuotaMeter } from "@/components/usage/quota-meter";
import { QuotaStateBadge } from "@/components/usage/quota-state-badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { formatNumber, formatPercent, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { getDashboardSummary } from "@/server/db/queries/dashboard";
import { getUsageSummary } from "@/server/quota/usage-report";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const [summary, usage] = await Promise.all([getDashboardSummary(), getUsageSummary()]);
  const primarySku = usage.skus.find((sku) => sku.isPrimary) ?? usage.skus[0];

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Coverage-first lead generation for your embroidery digitizing business."
        actions={
          <Link href="/find-leads" className={cn(buttonVariants({ size: "lg" }), "gap-2")}>
            <Plus className="size-4" />
            Find New Leads
          </Link>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Total leads"
          value={formatNumber(summary.totalLeads)}
          sublabel="Across every search"
          icon={Users}
        />
        <StatCard
          label="Leads this month"
          value={formatNumber(summary.leadsThisMonth)}
          sublabel="Since the 1st"
          icon={MapPinned}
        />
        <StatCard
          label="Searches"
          value={formatNumber(summary.totalSearches)}
          sublabel={`${summary.activeSearches.length} active`}
          icon={Search}
        />
        <StatCard
          label="Google API mode"
          value="FREE ONLY"
          sublabel="No paid request is ever made"
          icon={Gauge}
          tone="positive"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Active searches</CardTitle>
            <CardDescription>
              Searches keep running on the server. Closing this tab does not stop them.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {summary.activeSearches.length === 0 ? (
              <EmptyState
                icon={Search}
                title="Nothing running"
                description="Start a search and it will keep working in the background until the area is covered or the free quota runs out."
                actionLabel="Find New Leads"
                actionHref="/find-leads"
              />
            ) : (
              <ul className="divide-border divide-y">
                {summary.activeSearches.map((s) => {
                  // The bar tracks COVERAGE, not leads. A progress bar is read
                  // as "how done is this", and what finishes a search is the
                  // geography — filling a lead bar to 100% would say the run
                  // was over when it may have searched a third of the area.
                  const pct = Math.min(Math.max(s.coverage_pct, 0), 100);
                  const targetMet = s.target_leads > 0 && s.leads_found >= s.target_leads;

                  return (
                    <li key={s.id} className="py-3 first:pt-0 last:pb-0">
                      <Link
                        href={`/searches/${s.id}`}
                        className="group flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div className="min-w-0 space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium group-hover:underline">
                              {s.niche}
                            </span>
                            <SearchStatusBadge status={s.status} />
                          </div>
                          <p className="text-muted-foreground text-xs">{s.label}</p>
                        </div>
                        <div className="w-full shrink-0 space-y-1.5 sm:w-52">
                          <div className="flex justify-between text-xs tabular-nums">
                            <span className="text-muted-foreground">
                              {formatNumber(s.leads_found)} / {formatNumber(s.target_leads)} leads
                              {targetMet ? " ✓" : ""}
                            </span>
                            <span>{formatPercent(s.coverage_pct, 0)} area</span>
                          </div>
                          <Progress value={pct} />
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between gap-2">
              Free quota
              {primarySku ? <QuotaStateBadge state={primarySku.state} /> : null}
            </CardTitle>
            <CardDescription>
              {primarySku
                ? `${primarySku.label} · ${usage.period.label}`
                : "Monthly Google API allowance"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {primarySku ? (
              <>
                <div className="space-y-1.5">
                  <QuotaMeter
                    used={primarySku.used}
                    effectiveLimit={primarySku.effectiveLimit}
                    freeLimit={primarySku.freeLimit}
                    percent={primarySku.percentUsedClamped}
                    state={primarySku.state}
                  />
                  <div className="flex items-baseline justify-between text-xs">
                    <span className="text-muted-foreground tabular-nums">
                      {formatNumber(primarySku.used)} / {formatNumber(primarySku.effectiveLimit)}{" "}
                      used
                    </span>
                    <span className="font-medium tabular-nums">
                      {formatNumber(primarySku.remaining)} left
                    </span>
                  </div>
                </div>
                <p className="text-muted-foreground text-xs">
                  {formatNumber(primarySku.reserve)} of the {formatNumber(primarySku.freeLimit)}
                  -call allowance is held back as a safety reserve and is never spent.
                </p>
              </>
            ) : null}

            <PricingWarning pricing={usage.pricing} compact />

            <Link
              href="/usage"
              className={cn(buttonVariants({ variant: "outline", size: "sm" }), "w-full")}
            >
              Open usage
            </Link>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent searches</CardTitle>
          <CardDescription>The last searches you ran, newest first.</CardDescription>
        </CardHeader>
        <CardContent>
          {summary.recentSearches.length === 0 ? (
            <EmptyState
              icon={MapPinned}
              title="No searches yet"
              description="Pick a niche and a city, and the grid will be built from the city's real bounding box — not from your lead target."
              actionLabel="Find New Leads"
              actionHref="/find-leads"
            />
          ) : (
            <ul className="divide-border divide-y text-sm">
              {summary.recentSearches.map((s) => (
                <li key={s.id}>
                  <Link
                    href={`/searches/${s.id}`}
                    className="hover:bg-muted/50 -mx-2 flex items-center justify-between gap-3 rounded-md px-2 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">{s.niche}</p>
                      <p className="text-muted-foreground truncate text-xs">{s.label}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className="text-muted-foreground text-xs tabular-nums">
                        {formatNumber(s.leads_found)} leads
                      </span>
                      <SearchStatusBadge status={s.status} />
                      <span className="text-muted-foreground hidden text-xs sm:inline">
                        {formatRelative(s.created_at)}
                      </span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}
