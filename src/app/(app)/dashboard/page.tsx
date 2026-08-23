import { Gauge, Mail, MapPinned, Search, Sparkles, Users } from "lucide-react";
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
import { getCurrentUser } from "@/server/db/server-client";
import { getDashboardSummary } from "@/server/db/queries/dashboard";
import { loadGenerationState } from "@/server/generate/state";
import { getUsageSummary } from "@/server/quota/usage-report";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const [summary, usage, user] = await Promise.all([
    getDashboardSummary(),
    getUsageSummary(),
    getCurrentUser(),
  ]);
  const primarySku = usage.skus.find((sku) => sku.isPrimary) ?? usage.skus[0];

  // The full state for the run still open, so the card can show what it has
  // actually found rather than only that something is happening. Read from the
  // database like everything else here, and only when there is a run to read.
  const activeState =
    summary.activeGeneration && user
      ? await loadGenerationState({ runId: summary.activeGeneration.id, userId: user.id }).catch(
          () => null,
        )
      : null;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Coverage-first lead generation for your embroidery digitizing business."
        actions={
          <Link href="/generate" className={cn(buttonVariants({ size: "lg" }), "gap-2")}>
            <Sparkles className="size-4" />
            Generate New Leads
          </Link>
        }
      />

      {/*
       * AN ACTIVE GENERATION IS ALWAYS VISIBLE HERE.
       *
       * Navigating away from a generation must never lose it. Nothing about the
       * run lives in the browser, so this card is rebuilt from Postgres on every
       * request and "View progress" returns to the same stable URL, at the same
       * point, on any device.
       *
       * The wording is deliberately careful. While the durable worker is off, a
       * generation advances only when its page is open, so this says the run is
       * waiting rather than implying it is grinding away on a server somewhere.
       */}
      {summary.activeGeneration && activeState ? (
        <Card className="border-primary/40 bg-primary/[0.03]">
          <CardContent className="space-y-4 pt-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">Generation in progress</p>
                <p className="text-muted-foreground truncate text-sm">
                  {activeState.niche} · {activeState.locationLabel}
                </p>
              </div>
              <Link
                href={`/generate/${summary.activeGeneration.id}`}
                className={cn(buttonVariants({ size: "sm" }), "gap-2")}
              >
                View progress
              </Link>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <ActiveFigure
                label="Leads found"
                value={formatNumber(activeState.search.leadsFound)}
              />
              <ActiveFigure
                label="Area searched"
                value={formatPercent(activeState.search.coveragePct, 0)}
              />
              <ActiveFigure label="Step" value={activeState.headline} small />
              <ActiveFigure
                label="Estimated remaining"
                value={
                  activeState.displayState === "searching"
                    ? activeState.search.eta.label
                    : activeState.enrichment.eta.label
                }
                small
              />
            </div>

            <Progress value={Math.min(activeState.search.coveragePct, 100)} />

            <p className="text-muted-foreground text-xs">
              Waiting for its page to continue — open it and the generation picks up exactly where
              it left off. Nothing has been lost.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Total leads"
          value={formatNumber(summary.totalLeads)}
          sublabel="Across every search"
          icon={Users}
        />
        <StatCard
          label="Emails found"
          value={formatNumber(summary.emailsFound)}
          sublabel={`${formatNumber(summary.leadsThisMonth)} new leads since the 1st`}
          icon={Mail}
          tone={summary.emailsFound > 0 ? "positive" : undefined}
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
              Every area searched, every lead and every figure is stored on the server. Closing this
              tab pauses a generation where it is — nothing is lost, and reopening it continues from
              the same point.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {summary.activeSearches.length === 0 ? (
              <EmptyState
                icon={Search}
                title="Nothing running"
                description="Generate leads and this is where the run in progress appears, with the area it has covered so far."
                actionLabel="Generate New Leads"
                actionHref="/generate"
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
              description="Pick a niche and an area, and the whole area is divided into sections and searched — the size of the grid follows the area, never your lead target."
              actionLabel="Generate New Leads"
              actionHref="/generate"
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

/** One figure on the active-generation card. */
function ActiveFigure({ label, value, small }: { label: string; value: string; small?: boolean }) {
  return (
    <div className="space-y-0.5">
      <p className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
        {label}
      </p>
      <p className={cn("font-semibold tabular-nums", small ? "text-sm" : "text-base")}>{value}</p>
    </div>
  );
}
