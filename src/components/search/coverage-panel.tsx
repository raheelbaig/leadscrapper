import { AlertTriangle, CheckCircle2, MapPinOff } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import type { CoverageReport } from "@/lib/coverage-report";
import { formatNumber } from "@/lib/format";
import { TILE_STATE_META, type TileState } from "@/lib/tile-states";

/**
 * What the run actually covered, and — more importantly — what it did not.
 *
 * `stopOnTargetReached` lets a search finish having searched a third of its
 * rectangle. That is a legitimate outcome, but only if it is stated. A run that
 * stops at its target and then presents a clean "completed" is lying by
 * omission, and every decision made from the lead list inherits the lie.
 *
 * Rendered from the SAME `buildCoverageReport` the tick writes to the activity
 * log, so the page and the ledger cannot disagree.
 */

function Row({
  label,
  tiles,
  areaKm2,
  pct,
  tone,
}: {
  label: string;
  tiles: number;
  areaKm2: number;
  pct: number;
  tone?: "positive" | "warning" | "danger";
}) {
  const toneClass =
    tone === "positive"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "danger"
        ? "text-amber-600 dark:text-amber-400"
        : tone === "warning"
          ? "text-orange-600 dark:text-orange-400"
          : "";

  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 text-sm">
      <span className={toneClass}>{label}</span>
      <span className="text-muted-foreground tabular-nums">
        <span className="text-foreground font-medium">{formatNumber(tiles)}</span> tile(s) ·{" "}
        {areaKm2.toFixed(1)} km² · {pct.toFixed(1)}%
      </span>
    </div>
  );
}

export function CoveragePanel({ report }: { report: CoverageReport }) {
  return (
    <div className="space-y-4">
      {report.fullyCovered ? (
        <Alert className="border-emerald-500/40 bg-emerald-500/5">
          <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />
          <AlertTitle>The whole area was searched</AlertTitle>
          <AlertDescription>{report.summary}</AlertDescription>
        </Alert>
      ) : (
        <Alert className="border-amber-500/40 bg-amber-500/5">
          <MapPinOff className="size-4 text-amber-600 dark:text-amber-400" />
          <AlertTitle>Part of this area was never searched</AlertTitle>
          <AlertDescription>{report.summary}</AlertDescription>
        </Alert>
      )}

      <div className="divide-border divide-y">
        <Row
          label="Searched (covered + verified empty)"
          tiles={report.covered.tiles}
          areaKm2={report.covered.areaKm2}
          pct={report.covered.pct}
          tone="positive"
        />
        <Row
          label="Still owed — resumes on the next run"
          tiles={report.owed.tiles}
          areaKm2={report.owed.areaKm2}
          pct={report.owed.pct}
          tone={report.owed.tiles > 0 ? "warning" : undefined}
        />
        <Row
          label="Permanent known gap — resuming will not help"
          tiles={report.permanentGap.tiles}
          areaKm2={report.permanentGap.areaKm2}
          pct={report.permanentGap.pct}
          tone={report.permanentGap.tiles > 0 ? "danger" : undefined}
        />
      </div>

      {report.permanentGap.tiles > 0 ? (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>{report.permanentGap.tiles} tile(s) hit the 60-result ceiling</AlertTitle>
          <AlertDescription>
            Those rectangles were already at the smallest allowed tile size, so they could not be
            split further. Some businesses inside them were never returned by Google and never will
            be. Lower <code className="text-xs">minTileEdgeKm</code> or raise{" "}
            <code className="text-xs">maxSubdivisionDepth</code> to reach them.
          </AlertDescription>
        </Alert>
      ) : null}

      {report.unsearchedTiles.length > 0 ? (
        <div className="space-y-2">
          <p className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
            Not searched ({report.unsearchedTiles.length})
          </p>
          <div className="flex flex-wrap gap-1.5">
            {report.unsearchedTiles.map((tile) => {
              const meta = TILE_STATE_META[tile.state as TileState];
              return (
                <Badge key={tile.label} variant="outline" className={meta?.badgeClass}>
                  {tile.label} · {tile.areaKm2.toFixed(1)} km² · {meta?.label ?? tile.state}
                </Badge>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
