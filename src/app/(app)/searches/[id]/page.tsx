import { Gauge, MapPinned, Percent, Users } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { EmptyState } from "@/components/common/empty-state";
import { StatCard } from "@/components/common/stat-card";
import { ExportSearchButton } from "@/components/export/export-button";
import { PageHeader } from "@/components/layout/page-header";
import { CoveragePanel } from "@/components/search/coverage-panel";
import { RunSearchButton } from "@/components/search/run-search-button";
import {
  ContinueToFullCoverageButton,
  SearchActionsMenu,
} from "@/components/search/search-actions";
import { SearchLiveFeed, type SearchEventRow } from "@/components/search/search-live-feed";
import { SearchStatusBadge } from "@/components/search/search-status-badge";
import { TileMap } from "@/components/search/tile-map";
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
import { buildCoverageReport, type CoverageTile } from "@/lib/coverage-report";
import { formatNumber, formatPercent } from "@/lib/format";
import { TILE_STATE_META, type TileState } from "@/lib/tile-states";
import { getSupabaseServerClient } from "@/server/db/server-client";
import { getUsageSummary } from "@/server/quota/usage-report";
import { SEARCH_LIMITS } from "@/server/search/limits";

export const metadata: Metadata = { title: "Search" };

/** Every figure is read from the database on each request, so a refresh is truth. */
export const dynamic = "force-dynamic";

function RunFigure({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: "warning";
}) {
  return (
    <div className="space-y-0.5">
      <p className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
        {label}
      </p>
      <p
        className={
          tone === "warning"
            ? "text-base font-semibold text-amber-600 tabular-nums dark:text-amber-400"
            : "text-base font-semibold tabular-nums"
        }
      >
        {value}
      </p>
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
  const tileRows = tiles ?? [];
  const leadPct = s.target_leads > 0 ? Math.min((s.leads_found / s.target_leads) * 100, 100) : 0;
  const enterprise = usage.skus.find((sku) => sku.isPrimary) ?? usage.skus[0];
  const currentTile = tileRows.find((t) => t.id === s.current_tile_id);
  const nextPending = tileRows.find((t) => t.state === "pending");

  // The same function the tick writes to the activity log, so the page and the
  // ledger cannot tell different stories about what was covered.
  const coverage = buildCoverageReport({
    tiles: tileRows.map((tile): CoverageTile => ({
      label: tile.label,
      state: tile.state as TileState,
      area_km2: tile.area_km2 ?? 0,
      depth: tile.depth,
    })),
    target: s.target_leads,
    leadsFound: s.leads_found,
  });

  const budgetRemaining = Math.max(SEARCH_LIMITS.maxCallsPerSearch - s.api_calls_run, 0);

  // Searches created before 2026-08-22 froze the old policy into grid_config,
  // where the lead target ended the run. Their frozen definition is honoured
  // rather than rewritten, so the page has to say so and offer the amendment.
  const gridConfig =
    s.grid_config && typeof s.grid_config === "object" && !Array.isArray(s.grid_config)
      ? (s.grid_config as Record<string, unknown>)
      : {};
  const stopsAtTarget = gridConfig.stopOnTargetReached === true;

  const tileCounts: Partial<Record<string, number>> = {
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
        actions={
          <div className="flex items-center gap-2">
            <SearchStatusBadge status={s.status} />
            <ExportSearchButton searchId={s.id} leadCount={s.leads_found} size="sm" />
            <SearchActionsMenu
              searchId={s.id}
              status={s.status}
              leadCount={s.leads_found}
              redirectTo="/searches"
            />
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Leads"
          value={`${formatNumber(s.leads_found)} / ${formatNumber(s.target_leads)}`}
          sublabel={
            coverage.targetReached
              ? `minimum target met (${Math.round(leadPct)}%)`
              : `${Math.round(leadPct)}% of the minimum target`
          }
          icon={Users}
        />
        <StatCard
          label="Geographic coverage"
          value={formatPercent(s.coverage_pct, 1)}
          sublabel="Area-weighted, not tile count"
          icon={Percent}
          tone={coverage.fullyCovered ? "positive" : "warning"}
        />
        <StatCard
          label="Tiles"
          value={`${formatNumber(coverage.tilesCompleted)} / ${formatNumber(coverage.leafTiles)}`}
          sublabel={`${formatNumber(coverage.tilesRemaining)} still owed`}
          icon={MapPinned}
        />
        <StatCard
          label="API calls"
          value={`${formatNumber(s.api_calls_run)} / ${formatNumber(SEARCH_LIMITS.maxCallsPerSearch)}`}
          sublabel={`${formatNumber(budgetRemaining)} left in this search's budget`}
          icon={Gauge}
          tone={budgetRemaining === 0 ? "warning" : undefined}
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
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            <RunFigure label="Niche" value={s.niche} hint={`Query sent: “${s.query_text}”`} />
            <RunFigure
              label="Location"
              value={s.city}
              hint={[s.state, s.country].filter(Boolean).join(", ")}
            />
            <RunFigure
              label="Target leads"
              value={formatNumber(s.target_leads)}
              hint="a minimum, not a stopping point"
            />
            <RunFigure
              label="Leads found"
              value={`${formatNumber(s.leads_found)} / ${formatNumber(s.target_leads)}`}
              hint={coverage.targetReached ? "minimum met" : "below the minimum"}
            />
            <RunFigure
              label="Tiles completed"
              value={`${formatNumber(coverage.tilesCompleted)} / ${formatNumber(coverage.leafTiles)}`}
              hint={`${formatNumber(coverage.tilesSubdivided)} subdivided`}
            />
            <RunFigure
              label="Tiles remaining"
              value={formatNumber(coverage.tilesRemaining)}
              hint={`${coverage.owed.areaKm2.toFixed(1)} km² unsearched`}
              tone={coverage.tilesRemaining > 0 ? "warning" : undefined}
            />
            <RunFigure
              label="Current tile"
              value={currentTile?.label ?? nextPending?.label ?? "—"}
              hint={currentTile ? "running" : nextPending ? "next up" : "idle"}
            />
            <RunFigure
              label="Current page"
              value={s.current_page ? `${s.current_page} / ${SEARCH_LIMITS.maxPagesPerTile}` : "—"}
              hint={s.current_page ? "of this tile" : "idle"}
            />
            <RunFigure
              label="API calls this search"
              value={`${formatNumber(s.api_calls_run)} / ${formatNumber(SEARCH_LIMITS.maxCallsPerSearch)}`}
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

          {stopsAtTarget ? (
            <div className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
              <div className="space-y-1">
                <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
                  This search still uses the old stop policy
                </p>
                <p className="text-muted-foreground text-xs">
                  It was created when reaching the lead target ended a run, so it stops at{" "}
                  {formatNumber(s.target_leads)} leads with {formatNumber(coverage.tilesRemaining)}{" "}
                  tile(s) — {coverage.owed.areaKm2.toFixed(1)} km² — never searched. Its frozen
                  configuration is left exactly as it was recorded. Continuing changes only the stop
                  policy: the geometry and every lead already collected stay untouched, and the
                  change is written to the activity log.
                </p>
              </div>
              <ContinueToFullCoverageButton
                searchId={s.id}
                tilesRemaining={coverage.tilesRemaining}
              />
            </div>
          ) : null}

          <RunSearchButton
            searchId={s.id}
            status={s.status}
            tilesRemaining={coverage.tilesRemaining}
            budgetRemaining={budgetRemaining}
          />
        </CardContent>
      </Card>

      <Tabs defaultValue="coverage">
        <TabsList>
          <TabsTrigger value="coverage">Coverage</TabsTrigger>
          <TabsTrigger value="tiles">Tiles</TabsTrigger>
          <TabsTrigger value="leads">Leads</TabsTrigger>
          <TabsTrigger value="log">Log</TabsTrigger>
        </TabsList>

        <TabsContent value="coverage" className="space-y-4 pt-4">
          <Card>
            <CardHeader>
              <CardTitle>Lead progress</CardTitle>
              <CardDescription>
                {formatNumber(s.leads_found)} against a minimum target of{" "}
                {formatNumber(s.target_leads)}. The target is a benchmark — the search finishes when
                the area is covered, not when this bar fills.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Progress value={leadPct} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Coverage map</CardTitle>
              <CardDescription>
                One rectangle per leaf tile, coloured by state. Hover for the reason.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <TileMap
                bbox={{
                  minLat: s.min_lat,
                  minLng: s.min_lng,
                  maxLat: s.max_lat,
                  maxLng: s.max_lng,
                }}
                tiles={tileRows}
                currentTileId={s.current_tile_id}
              />
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t pt-4">
                <TileStateLegend counts={tileCounts} />
                <div className="flex items-center gap-1.5 text-xs">
                  <span
                    aria-hidden
                    className="border-muted-foreground/40 size-2.5 rounded-[3px] border border-dashed"
                  />
                  <span className="text-muted-foreground">{TILE_STATE_META.subdivided.label}</span>
                  <span className="font-medium tabular-nums">{s.tiles_subdivided}</span>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>What was searched, and what was not</CardTitle>
              <CardDescription>
                Area-weighted. A subdivided tile contributes no area of its own — its four children
                cover it exactly.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CoveragePanel report={coverage} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">How this search ends</CardTitle>
              <CardDescription>
                Completion is geographic. The lead target is a minimum you asked for, and exceeding
                it is a result rather than a reason to stop.
              </CardDescription>
            </CardHeader>
            <CardContent className="text-muted-foreground space-y-2 text-sm">
              <p>
                A search is marked <span className="text-foreground font-medium">completed</span>{" "}
                only when every leaf tile is accounted for. Every other ending — the call budget,
                the free allowance, the time slice, a failed tile, a pause — leaves it{" "}
                <span className="text-foreground font-medium">paused</span> with the remaining
                geography still owed and still visible above.
              </p>
              <p>
                Each press works through pending tiles until a budget stops it: up to three pages
                per tile with a fresh quota reservation for every page, and at most{" "}
                <code className="text-xs">{SEARCH_LIMITS.maxCallsPerSearch}</code> Google calls for
                the whole search, cumulative across resumes. Subdivision is capped at depth{" "}
                <code className="text-xs">{SEARCH_LIMITS.maxSubdivisionDepth}</code>.
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="tiles" className="pt-4">
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Tile</TableHead>
                      <TableHead className="text-right">Depth</TableHead>
                      <TableHead>State</TableHead>
                      <TableHead className="text-right">Results</TableHead>
                      <TableHead className="text-right">New</TableHead>
                      <TableHead className="text-right">Pages</TableHead>
                      <TableHead className="text-right">Calls</TableHead>
                      <TableHead className="text-right">km²</TableHead>
                      <TableHead>Reason</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {tileRows.map((tile) => {
                      const meta = TILE_STATE_META[tile.state as TileState];
                      return (
                        <TableRow key={tile.id}>
                          <TableCell className="font-medium">{tile.label}</TableCell>
                          <TableCell className="text-muted-foreground text-right tabular-nums">
                            {tile.depth}
                          </TableCell>
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
                            {tile.token_after_last ? "+" : ""}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatNumber(tile.api_calls)}
                          </TableCell>
                          <TableCell className="text-muted-foreground text-right tabular-nums">
                            {(tile.area_km2 ?? 0).toFixed(1)}
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
              <SearchLiveFeed searchId={s.id} initialEvents={(events ?? []) as SearchEventRow[]} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </>
  );
}
