import { Download } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { EmptyState } from "@/components/common/empty-state";
import { DownloadExportButton } from "@/components/export/export-button";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EXPORT_COLUMNS } from "@/lib/constants";
import { formatDateTime, formatNumber } from "@/lib/format";
import { getSupabaseServerClient } from "@/server/db/server-client";

export const metadata: Metadata = { title: "Exports" };

export const dynamic = "force-dynamic";

function formatBytes(value: number | null): string {
  if (!value) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

const STATUS_TONE: Record<string, string> = {
  ready: "border-emerald-500/40 text-emerald-700 dark:text-emerald-400",
  pending: "border-amber-500/40 text-amber-700 dark:text-amber-400",
  failed: "border-red-500/40 text-red-700 dark:text-red-400",
};

export default async function ExportsPage() {
  const supabase = await getSupabaseServerClient();
  const { data } = await supabase
    .from("exports")
    .select("id, label, status, row_count, file_size, error, search_id, created_at")
    .order("created_at", { ascending: false })
    .limit(50);

  const exports = data ?? [];

  return (
    <>
      <PageHeader
        title="Exports"
        description="Generated workbooks. Every export carries a Coverage worksheet alongside the leads, including partial ones."
      />

      {exports.length === 0 ? (
        <EmptyState
          icon={Download}
          title="No exports yet"
          description="Open a search and press Export to Excel. The workbook is kept here for re-download, and the download link is signed fresh each time."
          actionLabel="Go to searches"
          actionHref="/searches"
        />
      ) : (
        <Card className="overflow-hidden py-0">
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Workbook</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Leads</TableHead>
                    <TableHead className="text-right">Size</TableHead>
                    <TableHead className="text-right">Created</TableHead>
                    <TableHead className="w-32" aria-label="Download" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {exports.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="font-medium">
                        {row.search_id ? (
                          <Link href={`/searches/${row.search_id}`} className="hover:underline">
                            {row.label}
                          </Link>
                        ) : (
                          row.label
                        )}
                        {row.error ? (
                          <p className="text-xs text-red-600 dark:text-red-400">{row.error}</p>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={STATUS_TONE[row.status]}>
                          {row.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.row_count === null ? "—" : formatNumber(row.row_count)}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-right tabular-nums">
                        {formatBytes(row.file_size)}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-right">
                        {formatDateTime(row.created_at)}
                      </TableCell>
                      <TableCell className="text-right">
                        {row.status === "ready" ? (
                          <DownloadExportButton exportId={row.id} label={row.label} />
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

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
            <p className="mb-2 text-sm font-medium">
              Leads worksheet
              <span className="text-muted-foreground ml-2 font-normal">
                {EXPORT_COLUMNS.length} columns
              </span>
            </p>
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
              their areas, failed, pending, area-weighted coverage percentage, API calls used, stop
              reason, the full search configuration and the{" "}
              <code className="text-xs">verify_search_coverage</code> invariant result. A sheet of
              leads that does not say what fraction of the city went unsearched is a misleading
              artifact, so this worksheet is written on every export, including partial ones.
            </p>
          </div>
          <div>
            <p className="mb-2 text-sm font-medium">Storage</p>
            <p className="text-muted-foreground text-sm">
              Workbooks live in a private Supabase Storage bucket under your own user folder.
              Downloads are short-lived signed URLs minted on the server for each click — no object
              is ever public, and no link outlives two minutes.
            </p>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
