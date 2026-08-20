import { ShieldCheck } from "lucide-react";
import type { Metadata } from "next";

import { PhaseNotice } from "@/components/common/phase-notice";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DEFAULT_GRID_CONFIG, MAX_PAGES, PAGE_SIZE, RESULT_CEILING } from "@/lib/constants";
import { getPricingCatalog } from "@/server/pricing/catalog.schema";
import { getCurrentUser } from "@/server/db/server-client";

export const metadata: Metadata = { title: "Settings" };

function Row({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b py-2.5 last:border-0">
      <div className="space-y-0.5">
        <p className="text-sm">{label}</p>
        {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
      </div>
      <span className="shrink-0 font-mono text-sm tabular-nums">{value}</span>
    </div>
  );
}

export default async function SettingsPage() {
  const user = await getCurrentUser();
  const catalog = getPricingCatalog();

  return (
    <>
      <PageHeader
        title="Settings"
        description="Personal, single-account configuration. No organizations, teams, or plans."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Account</CardTitle>
            <CardDescription>One account, sign-ups disabled.</CardDescription>
          </CardHeader>
          <CardContent>
            <Row label="Signed in as" value={user?.email ?? "—"} />
            <Row
              label="Google API mode"
              value={
                <Badge
                  variant="outline"
                  className="gap-1.5 border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                >
                  <ShieldCheck className="size-3" />
                  FREE ONLY
                </Badge>
              }
              hint="Not a toggle. There is no paid path in this application."
            />
            <Row label="Billing timezone" value={catalog.billingTimezone} hint="Monthly quota reset" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Google Places contract</CardTitle>
            <CardDescription>Hard ceilings, not preferences.</CardDescription>
          </CardHeader>
          <CardContent>
            <Row label="Results per page" value={PAGE_SIZE} />
            <Row label="Max pages per query" value={MAX_PAGES} hint="Each page is a billable call" />
            <Row label="Result ceiling per tile" value={RESULT_CEILING} />
            <Row
              label="Saturation threshold"
              value={Math.ceil(DEFAULT_GRID_CONFIG.saturationRatio * RESULT_CEILING)}
              hint="Google sometimes returns 18–19 per page; demanding exactly 60 would misread truncation as coverage"
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Default grid</CardTitle>
          <CardDescription>
            Starting values for new searches. Each one is frozen into the search when it is created,
            so changing a default never rewrites the geometry of a search already under way.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Row
            label="Sizing strategy"
            value={DEFAULT_GRID_CONFIG.sizingStrategy}
            hint="Tile count comes from the bounding box; the lead target has no influence on geometry"
          />
          <Row
            label="Seed tile edge"
            value={`${DEFAULT_GRID_CONFIG.seedTileEdgeKm} km`}
            hint="The biggest cost and coverage lever"
          />
          <Row label="Max subdivision depth" value={DEFAULT_GRID_CONFIG.maxSubdivisionDepth} />
          <Row
            label="Min tile edge"
            value={`${DEFAULT_GRID_CONFIG.minTileEdgeKm} km`}
            hint="A saturated tile at this size becomes a permanent recorded gap"
          />
          <Row label="Seed tile clamp" value={`${DEFAULT_GRID_CONFIG.minSeedTiles}–${DEFAULT_GRID_CONFIG.maxSeedTiles}`} />
          <Row label="Stop when target reached" value={String(DEFAULT_GRID_CONFIG.stopOnTargetReached)} />
        </CardContent>
      </Card>

      <PhaseNotice phase="Phase 2+ — editable settings">
        These read from the shared defaults today. Saving per-account overrides and managing custom
        areas (for example Greater Houston instead of Houston city proper) is wired alongside the
        bounding-box resolver.
      </PhaseNotice>
    </>
  );
}
