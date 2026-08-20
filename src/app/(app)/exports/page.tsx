import { Download } from "lucide-react";
import type { Metadata } from "next";

import { EmptyState } from "@/components/common/empty-state";
import { PhaseNotice } from "@/components/common/phase-notice";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EXPORT_COLUMNS } from "@/lib/constants";
import { getSupabaseServerClient } from "@/server/db/server-client";

export const metadata: Metadata = { title: "Exports" };

export default async function ExportsPage() {
  const supabase = await getSupabaseServerClient();
  const { data } = await supabase
    .from("exports")
    .select("id, label, status, row_count, created_at")
    .order("created_at", { ascending: false })
    .limit(50);

  const exports = data ?? [];

  return (
    <>
      <PageHeader
        title="Exports"
        description="Generated workbooks. Every export carries a Coverage worksheet alongside the leads."
      />

      {exports.length === 0 ? (
        <EmptyState
          icon={Download}
          title="No exports yet"
          description="Export a search once it has leads, and the workbook will be kept here for re-download."
        />
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Workbook layout</CardTitle>
          <CardDescription>
            Fixed column order, identical before and after enrichment, so a sheet exported today
            lines up with one exported next month.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <p className="mb-2 text-sm font-medium">Leads worksheet</p>
            <div className="flex flex-wrap gap-1.5">
              {EXPORT_COLUMNS.map((c) => (
                <span
                  key={c}
                  className="bg-muted text-muted-foreground rounded px-2 py-1 font-mono text-xs"
                >
                  {c}
                </span>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-2 text-sm font-medium">Coverage worksheet</p>
            <p className="text-muted-foreground text-sm">
              Location, target, leads found, total leaf tiles, covered, empty, partial gaps with
              coordinates, failed, pending, area-weighted coverage percentage, API calls used, stop
              reason, search configuration and the invariant-check result. A sheet of leads that does
              not say what fraction of the city went unsearched is a misleading artifact, so this
              worksheet is written on every export, including partial ones.
            </p>
          </div>
        </CardContent>
      </Card>

      <PhaseNotice phase="Phase 6 — Excel export">
        Workbook generation, private storage and signed-URL downloads land after lead management.
      </PhaseNotice>
    </>
  );
}
