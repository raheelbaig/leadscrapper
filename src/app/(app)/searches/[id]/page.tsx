import { Gauge, MapPinned, Percent, Users } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { EmptyState } from "@/components/common/empty-state";
import { PhaseNotice } from "@/components/common/phase-notice";
import { StatCard } from "@/components/common/stat-card";
import { PageHeader } from "@/components/layout/page-header";
import { SearchStatusBadge } from "@/components/search/search-status-badge";
import { TileStateLegend } from "@/components/search/tile-state-legend";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatNumber, formatPercent } from "@/lib/format";
import { getSupabaseServerClient } from "@/server/db/server-client";

export const metadata: Metadata = { title: "Search" };

export default async function SearchDetailPage(props: PageProps<"/searches/[id]">) {
  const { id } = await props.params;

  const supabase = await getSupabaseServerClient();
  const { data: search } = await supabase
    .from("searches")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (!search) {
    notFound();
  }

  // Fully typed from the generated schema -- no hand-written shape to drift.
  const s = search;

  const leadPct = s.target_leads > 0 ? Math.min((s.leads_found / s.target_leads) * 100, 100) : 0;

  const tileCounts = {
    covered: s.tiles_covered,
    empty: s.tiles_empty,
    saturated_floor: s.tiles_saturated_floor,
    failed: s.tiles_failed,
    skipped_quota: s.tiles_skipped_quota,
    pending: s.tiles_pending,
    in_progress: s.tiles_in_progress,
  };

  return (
    <>
      <PageHeader
        title={s.niche}
        description={s.label}
        actions={<SearchStatusBadge status={s.status} />}
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Leads"
          value={`${formatNumber(s.leads_found)} / ${formatNumber(s.target_leads)}`}
          sublabel={`${Math.round(leadPct)}% of target`}
          icon={Users}
        />
        <StatCard
          label="Geographic coverage"
          value={formatPercent(s.coverage_pct, 1)}
          sublabel="Area-weighted, not tile count"
          icon={Percent}
          tone={s.coverage_pct >= 99.5 ? "positive" : "warning"}
        />
        <StatCard
          label="Tiles"
          value={formatNumber(s.tiles_total)}
          sublabel={`${formatNumber(s.tiles_pending)} still pending`}
          icon={MapPinned}
        />
        <StatCard
          label="API calls"
          value={formatNumber(s.api_calls_run)}
          sublabel="This search"
          icon={Gauge}
        />
      </div>

      <Tabs defaultValue="progress">
        <TabsList>
          <TabsTrigger value="progress">Progress</TabsTrigger>
          <TabsTrigger value="coverage">Coverage</TabsTrigger>
          <TabsTrigger value="leads">Leads</TabsTrigger>
          <TabsTrigger value="log">Log</TabsTrigger>
        </TabsList>

        <TabsContent value="progress" className="space-y-4 pt-4">
          <Card>
            <CardHeader>
              <CardTitle>Lead progress</CardTitle>
              <CardDescription>
                {formatNumber(s.leads_found)} of {formatNumber(s.target_leads)} target leads
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Progress value={leadPct} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Grid</CardTitle>
              <CardDescription>Leaf tiles by state</CardDescription>
            </CardHeader>
            <CardContent>
              <TileStateLegend counts={tileCounts} />
            </CardContent>
          </Card>

          <PhaseNotice phase="Phase 4 — live progress">
            Live tile-by-tile updates, the current-tile card and the pause/resume controls arrive
            with the worker. The progress figures above already come from the database, so they stay
            correct across refreshes.
          </PhaseNotice>
        </TabsContent>

        <TabsContent value="coverage" className="space-y-4 pt-4">
          <PhaseNotice phase="Phase 3 — coverage map">
            The tile map, the itemised list of unsearched tiles and the permanent-gap report land
            with the grid engine.
          </PhaseNotice>
        </TabsContent>

        <TabsContent value="leads" className="pt-4">
          <EmptyState
            icon={Users}
            title="No leads yet"
            description="Leads appear here as tiles are searched."
          />
        </TabsContent>

        <TabsContent value="log" className="pt-4">
          <EmptyState title="No events yet" description="The activity log starts when a search runs." />
        </TabsContent>
      </Tabs>
    </>
  );
}
