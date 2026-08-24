import { Gauge, Mail, Sparkles, Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { StatCard } from "@/components/common/stat-card";
import { PageHeader } from "@/components/layout/page-header";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { formatNumber, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";
import { getDashboardSummary } from "@/server/db/queries/dashboard";
import { getCurrentUser } from "@/server/db/server-client";
import { loadGenerationState } from "@/server/generate/state";
import { getUsageSummary } from "@/server/quota/usage-report";

export const metadata: Metadata = { title: "Dashboard" };

export const dynamic = "force-dynamic";

/**
 * A deliberately small home.
 *
 * This page used to carry an active-searches list, a quota meter with its
 * reserve arithmetic, a pricing-staleness warning and a recent-searches table
 * -- an operations console for a product whose entire job is "type a niche,
 * press a button". It is now four figures, the run in progress, and the button.
 *
 * It is no longer in the navigation and `/` goes straight to Generate Leads;
 * the page is kept because a bookmark to it should not 404, and because the
 * one thing worth glancing at -- is anything running right now -- belongs
 * somewhere. Search history moved to Active Searches, where it is easier to
 * find and does not need summarising twice.
 */
export default async function DashboardPage() {
  const [summary, usage, user] = await Promise.all([
    getDashboardSummary(),
    getUsageSummary(),
    getCurrentUser(),
  ]);
  const primarySku = usage.skus.find((sku) => sku.isPrimary) ?? usage.skus[0];

  const activeState =
    summary.activeGeneration && user
      ? await loadGenerationState({ runId: summary.activeGeneration.id, userId: user.id }).catch(
          () => null,
        )
      : null;

  return (
    <>
      <PageHeader
        title="Overview"
        description="Find local businesses and their public contact emails."
        actions={
          <Link href="/generate" className={cn(buttonVariants({ size: "lg" }), "gap-2")}>
            <Sparkles className="size-4" />
            Generate New Leads
          </Link>
        }
      />

      {/*
       * THE RUN IN PROGRESS IS ALWAYS FINDABLE.
       *
       * Rebuilt from Postgres on every request, so navigating away and coming
       * back -- on this device or another -- shows the same run at the same
       * point. Nothing about it lives in the browser.
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

            <div className="text-muted-foreground flex flex-wrap gap-x-8 gap-y-1 text-sm">
              <span>
                <span className="text-foreground font-semibold tabular-nums">
                  {formatNumber(activeState.search.leadsFound)}
                </span>{" "}
                leads found
              </span>
              <span>
                <span className="text-foreground font-semibold tabular-nums">
                  {formatPercent(activeState.search.coveragePct, 0)}
                </span>{" "}
                area searched
              </span>
              <span>{activeState.headline}</span>
            </div>

            <Progress value={Math.min(activeState.search.coveragePct, 100)} />

            <p className="text-muted-foreground text-xs">
              Waiting for its page to continue — open it and the generation picks up exactly where
              it left off. Nothing has been lost.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
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
          label="Google requests"
          value={
            primarySku
              ? `${formatNumber(primarySku.used)} / ${formatNumber(primarySku.freeLimit)}`
              : "—"
          }
          sublabel="Used this month · free usage only"
          icon={Gauge}
        />
      </div>

      <p className="text-muted-foreground text-sm">
        Looking for something you ran before?{" "}
        <Link href="/searches" className="underline">
          Active Searches
        </Link>{" "}
        has every search with its leads, coverage and results.
      </p>
    </>
  );
}
