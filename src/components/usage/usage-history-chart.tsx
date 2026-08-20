"use client";

import { BarChart3, Table2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { EmptyState } from "@/components/common/empty-state";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatNumber } from "@/lib/format";
import type { UsageHistory } from "@/lib/types/usage";
import { cn } from "@/lib/utils";

/**
 * Daily Google API calls for the billing month.
 *
 * ONE series at a time, by choice. Days are bucketed in the billing timezone on
 * the server, so what is drawn here is what Google's month contains -- the
 * browser's timezone is never involved. Stacking three or four SKUs on a
 * monochrome design system would need invented hues to distinguish series that
 * are, in practice, one series and three flat zeros; a filter answers the same
 * question without them.
 *
 * The bar colour is a validated aqua, stepped separately for light and dark so
 * it clears 3:1 against both card surfaces.
 */
type SkuLabels = Record<string, string>;

export function UsageHistoryChart({
  history,
  skuLabels,
  periodLabel,
  timeZone,
}: {
  history: UsageHistory;
  skuLabels: SkuLabels;
  periodLabel: string;
  timeZone: string;
}) {
  const [selectedSku, setSelectedSku] = useState<string>("all");
  const [asTable, setAsTable] = useState(false);

  const data = useMemo(
    () =>
      history.days.map((day) => ({
        day: day.day,
        label: day.label,
        calls: selectedSku === "all" ? day.total : (day.bySku[selectedSku] ?? 0),
      })),
    [history.days, selectedSku],
  );

  const total = useMemo(() => data.reduce((sum, d) => sum + d.calls, 0), [data]);
  const peak = useMemo(() => Math.max(...data.map((d) => d.calls), 0), [data]);

  if (!history.hasData) {
    return (
      <EmptyState
        icon={BarChart3}
        title="No Google API calls yet"
        description={`Nothing has been billed in ${periodLabel}. Every call this application makes is recorded here the moment it happens, so an empty chart means an empty bill.`}
      />
    );
  }

  // A month is up to 31 bars; label roughly eight of them and let the tooltip
  // carry the rest. A number on every bar is noise, not information.
  const tickInterval = Math.max(Math.ceil(data.length / 8) - 1, 0);
  const seriesName = selectedSku === "all" ? "All SKUs" : (skuLabels[selectedSku] ?? selectedSku);

  return (
    <div className="[--usage-bar:#199e70] dark:[--usage-bar:#1baf7a]">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1">
          {history.skusPresent.length > 1 ? (
            <>
              <FilterButton
                active={selectedSku === "all"}
                onClick={() => setSelectedSku("all")}
                label="All SKUs"
              />
              {history.skusPresent.map((sku) => (
                <FilterButton
                  key={sku}
                  active={selectedSku === sku}
                  onClick={() => setSelectedSku(sku)}
                  label={skuLabels[sku] ?? sku}
                />
              ))}
            </>
          ) : (
            <p className="text-muted-foreground text-xs">
              {skuLabels[history.skusPresent[0]] ?? history.skusPresent[0]} · daily calls
            </p>
          )}
        </div>

        <div className="flex items-center gap-3">
          <span className="text-muted-foreground text-xs tabular-nums">
            {formatNumber(total)} calls · peak {formatNumber(peak)}/day
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setAsTable((v) => !v)}
            aria-pressed={asTable}
          >
            {asTable ? <BarChart3 className="size-3.5" /> : <Table2 className="size-3.5" />}
            {asTable ? "Chart" : "Table"}
          </Button>
        </div>
      </div>

      {asTable ? (
        <div className="max-h-80 overflow-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Day ({timeZone})</TableHead>
                <TableHead className="text-right">{seriesName}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((row) => (
                <TableRow key={row.day}>
                  <TableCell className="font-mono text-xs">{row.day}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(row.calls)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: -18 }} barGap={2}>
              <CartesianGrid vertical={false} stroke="var(--color-border)" strokeDasharray="2 4" />
              <XAxis
                dataKey="label"
                interval={tickInterval}
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                tick={{ fill: "var(--color-muted-foreground)", fontSize: 11 }}
              />
              <YAxis
                allowDecimals={false}
                width={52}
                tickLine={false}
                axisLine={false}
                tick={{ fill: "var(--color-muted-foreground)", fontSize: 11 }}
              />
              <Tooltip
                cursor={{ fill: "var(--color-muted)", opacity: 0.5 }}
                content={<UsageTooltip seriesName={seriesName} timeZone={timeZone} />}
              />
              <Bar
                dataKey="calls"
                name={seriesName}
                fill="var(--usage-bar)"
                radius={[4, 4, 0, 0]}
                maxBarSize={22}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

function FilterButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <Button
      variant={active ? "secondary" : "ghost"}
      size="sm"
      onClick={onClick}
      aria-pressed={active}
      className={cn("h-7 px-2.5 text-xs", active && "font-medium")}
    >
      {label}
    </Button>
  );
}

type TooltipPayload = { payload?: { day?: string; calls?: number } };

function UsageTooltip({
  active,
  payload,
  seriesName,
  timeZone,
}: {
  active?: boolean;
  payload?: TooltipPayload[];
  seriesName: string;
  timeZone: string;
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;

  return (
    <div className="bg-popover text-popover-foreground rounded-lg border px-3 py-2 text-xs shadow-md">
      <p className="font-medium">{point.day}</p>
      <p className="text-muted-foreground mb-1.5 text-[11px]">{timeZone}</p>
      <p className="flex items-center gap-2">
        <span
          aria-hidden
          className="size-2 rounded-full bg-[var(--usage-bar)] ring-2 ring-[var(--color-popover)]"
        />
        <span className="text-muted-foreground">{seriesName}</span>
        <span className="ml-auto font-semibold tabular-nums">{formatNumber(point.calls ?? 0)}</span>
      </p>
    </div>
  );
}
