import { Gauge, MapPinned, Percent, Users } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { EmptyState } from "@/components/common/empty-state";
import { PhaseNotice } from "@/components/common/phase-notice";
import { StatCard } from "@/components/common/stat-card";
import { PageHeader } from "@/components/layout/page-header";
import { RunSearchButton } from "@/components/search/run-search-button";
import { SearchLiveFeed, type SearchEventRow } from "@/components/search/search-live-feed";
import { SearchStatusBadge } from "@/components/search/search-status-badge";
import { TileStateLegend } from "@/components/search/tile-state-legend";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatNumber, formatPercent } from "@/lib/format";
import { TILE_STATE_META, type TileState } from "@/lib/tile-states";
import { getSupabaseServerClient } from "@/server/db/server-client";
import { getUsageSummary } from "@/server/quota/usage-report";

export const metadata: Metadata = { title: "Search" };

/** Every figure is read from the database on each request, so a refresh is truth. */
export const dynamic = "force-dynamic";

function RunFigure({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="space-y-0.5">
      <p className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
        {label}
      </p>
      <p className="text-base font-semibold tabular-nums">{value}</p>
      {hint ? <p className="text-muted-foreground text-[11px]">{hint}</p> : null}
    </div>
  );
}

export default async function SearchDetailPage(props: PageProps<"/searches/[id]">) {
  const { id } = await props.params;

  const supabase = await getSupabaseServerClient();

  const [{ data: search }, { data: tiles }, { data: events }, { data: leads }, usage] =
    await Promise.all([
      supabase.from("searches").select("*").eq("id", id).maybeSingle(),
      supabase.from("search_tiles").select("*").eq("search_id", id).order("path"),
      supabase
        .from("search_events")
        .select("id, level, code, message, created_at")
        .eq("search_id", id)
        .order("id", { ascending: false })
        .limit(100),
      supabase
        .from("leads")
        .select("id, name, phone_national, address, website, maps_url, place_id, email_status")
        .eq("search_id", id)
        .order("created_at", { ascending: false })
        .limit(200),
      getUsageSummary(),
    ]);

  if (!search) {
    notFound();
  }

  const s = search;
  const leadPct = s.target_leads > 0 ? Math.min((s.leads_found / s.target_leads) * 100, 100) : 0;
  const enterprise = usage.skus.find((sku) => sku.isPrimary) ?? usage.skus[0];
  const currentTile = (tiles ?? []).find((t) => t.id === s.current_tile_id);
  const firstTile = (tiles ?? [])[0];

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

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Run status</CardTitle>
          <CardDescription>
            Read from the database on every request, so closing the tab or refreshing changes
            nothing.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            <RunFigure label="Search" value={s.niche} hint={`Query sent: “${s.query_text}”`} />
            <RunFigure label="Target" value={formatNumber(s.target_leads)} hint="leads" />
            <RunFigure
              label="Leads found"
              value={`${formatNumber(s.leads_found)} / ${formatNumber(s.target_leads)}`}
            />
            <RunFigure
              label="Current tile"
              value={currentTile?.label ?? firstTile?.label ?? "—"}
              hint={s.current_page ? `page ${s.current_page}` : "idle"}
            />
            <RunFigure
              label="API calls this run"
              value={formatNumber(s.api_calls_run)}
              hint={s.search_sku.replace("places-text-search-", "")}
            />
            <RunFigure
              label="Monthly Enterprise usage"
              value={
                enterprise
                  ? `${formatNumber(enterprise.used)} / ${formatNumber(enterprise.freeLimit)}`
                  : "—"
              }
              hint={enterprise ? `${formatNumber(enterprise.remaining)} protected calls left` : ""}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t pt-4">
            <span className="text-muted-foreground text-xs">Status</span>
            <Badge variant="outline" className="font-normal">
              {s.status_text ?? (s.stop_reason ? s.stop_reason.replace(/_/g, " ") : "idle")}
            </Badge>
            {s.last_error ? (
              <span className="text-xs text-red-600 dark:text-red-400">{s.last_error}</span>
            ) : null}
          </div>

          <RunSearchButton searchId={s.id} status={s.status} />
        </CardContent>
      </Card>

      <Tabs defaultValue="progress">
        <TabsList>
          <TabsTrigger value="progress">Progress</TabsTrigger>
          <TabsTrigger value="tiles">Tiles</TabsTrigger>
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

          <PhaseNotice phase="Phase 3B — pagination and subdivision">
            This run fetches a single page of a single tile. A tile that still has a page token is
            returned to <code className="text-xs">pending</code> rather than being marked covered,
            so the outstanding work stays visible instead of being written off.
          </PhaseNotice>
        </TabsContent>

        <TabsContent value="tiles" className="pt-4">
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Tile</TableHead>
                      <TableHead>State</TableHead>
                      <TableHead className="text-right">Results</TableHead>
                      <TableHead className="text-right">New</TableHead>
                      <TableHead className="text-right">Pages</TableHead>
                      <TableHead className="text-right">Calls</TableHead>
                      <TableHead>Reason</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(tiles ?? []).map((tile) => {
                      const meta = TILE_STATE_META[tile.state as TileState];
                      return (
                        <TableRow key={tile.id}>
                          <TableCell className="font-medium">{tile.label}</TableCell>
                          <TableCell>
                            <Badge variant="outline" className={meta?.badgeClass}>
                              {meta?.label ?? tile.state}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatNumber(tile.results_count)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatNumber(tile.unique_new_count)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatNumber(tile.pages_fetched)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatNumber(tile.api_calls)}
                          </TableCell>
                          <TableCell className="text-muted-foreground max-w-md text-xs">
                            {tile.last_reason ?? "—"}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="leads" className="pt-4">
          {(leads ?? []).length === 0 ? (
            <EmptyState
              icon={Users}
              title="No leads yet"
              description="Leads appear here as tiles are searched. Email stays empty until the enrichment subsystem runs — the Places API returns no email address at any tier."
            />
          ) : (
            <Card>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Business</TableHead>
                        <TableHead>Phone</TableHead>
                        <TableHead>Address</TableHead>
                        <TableHead>Website</TableHead>
                        <TableHead>Email</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(leads ?? []).map((lead) => (
                        <TableRow key={lead.id}>
                          <TableCell className="font-medium">
                            {lead.maps_url ? (
                              <a
                                href={lead.maps_url}
                                target="_blank"
                                rel="noreferrer"
                                className="hover:underline"
                              >
                                {lead.name}
                              </a>
                            ) : (
                              lead.name
                            )}
                          </TableCell>
                          <TableCell className="tabular-nums">
                            {lead.phone_national ?? "—"}
                          </TableCell>
                          <TableCell className="text-muted-foreground max-w-xs truncate text-xs">
                            {lead.address ?? "—"}
                          </TableCell>
                          <TableCell className="max-w-[12rem] truncate text-xs">
                            {lead.website ? (
                              <a
                                href={lead.website}
                                target="_blank"
                                rel="noreferrer"
                                className="hover:underline"
                              >
                                {lead.website.replace(/^https?:\/\//, "")}
                              </a>
                            ) : (
                              "—"
                            )}
                          </TableCell>
                          <TableCell className="text-muted-foreground text-xs">
                            not enriched
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="log" className="pt-4">
          <Card>
            <CardContent className="pt-6">
              <SearchLiveFeed
                searchId={s.id}
                initialEvents={(events ?? []) as SearchEventRow[]}
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </>
  );
}
