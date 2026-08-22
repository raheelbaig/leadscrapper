"use client";

import { Loader2, Mail, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatNumber } from "@/lib/format";

/**
 * The manual trigger for a bounded enrichment run.
 *
 * TWO buttons, and the order on screen is the order they should be used in.
 * "Check scope" is a dry run: it resolves exactly which leads would be visited
 * and writes nothing, makes no request, and cannot change a single row. Only
 * the second button reaches the internet, and it says so on its face.
 *
 * There is no "enrich everything" affordance and there will not be one. The
 * batch cap is enforced on the server; this component cannot widen it.
 */

type Outcome = {
  leadId: string;
  name: string;
  status: string;
  email: string | null;
  confidence: number | null;
  error: string | null;
};

type RunResult = {
  dryRun: boolean;
  selected: number;
  processed: number;
  found: number;
  notFound: number;
  failed: number;
  remaining: number;
  results: Outcome[];
};

const STATUS_TONE: Record<string, string> = {
  found: "text-emerald-700 dark:text-emerald-400",
  verified: "text-emerald-700 dark:text-emerald-400",
  not_found: "text-muted-foreground",
  failed: "text-red-600 dark:text-red-400",
  not_enriched: "text-muted-foreground",
};

export function EnrichmentRunner({ maxBatch, pending }: { maxBatch: number; pending: number }) {
  const [limit, setLimit] = useState(5);
  const [busy, setBusy] = useState<"dry" | "live" | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const router = useRouter();

  async function run(dryRun: boolean) {
    setBusy(dryRun ? "dry" : "live");
    try {
      const response = await fetch("/api/enrichment/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dryRun, limit }),
      });
      const payload = await response.json();

      if (!response.ok) {
        toast.error("The enrichment run failed", { description: payload.error });
        return;
      }

      const data = payload as RunResult;
      setResult(data);

      if (data.dryRun) {
        toast.info(`${formatNumber(data.selected)} lead(s) would be checked`, {
          description:
            data.selected === 0
              ? "Nothing is waiting. Every lead with a website has already been looked at."
              : `Nothing was requested and nothing was written. ${formatNumber(data.remaining)} would still be waiting afterwards.`,
        });
      } else {
        toast.success(
          `${formatNumber(data.found)} address(es) found across ${formatNumber(data.processed)} lead(s)`,
          {
            description: `${formatNumber(data.notFound)} had none published · ${formatNumber(data.failed)} could not be read · ${formatNumber(data.remaining)} still waiting.`,
          },
        );
        router.refresh();
      }
    } catch (error) {
      toast.error("The enrichment run failed", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-32 space-y-2">
          <Label htmlFor="limit">Leads this run</Label>
          <Input
            id="limit"
            type="number"
            min={1}
            max={maxBatch}
            value={limit}
            onChange={(event) =>
              setLimit(Math.min(Math.max(Number(event.target.value) || 1, 1), maxBatch))
            }
          />
        </div>

        <Button
          variant="outline"
          size="lg"
          className="gap-2"
          disabled={busy !== null || pending === 0}
          onClick={() => run(true)}
        >
          {busy === "dry" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Search className="size-4" />
          )}
          Check scope
        </Button>

        <Button
          size="lg"
          className="gap-2"
          disabled={busy !== null || pending === 0}
          onClick={() => run(false)}
        >
          {busy === "live" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Mail className="size-4" />
          )}
          Read {formatNumber(Math.min(limit, pending))} website(s)
        </Button>
      </div>

      <p className="text-muted-foreground text-xs">
        <span className="text-foreground font-medium">Check scope</span> writes nothing and requests
        nothing — it only says which leads would be visited. The second button makes real requests
        to those businesses&rsquo; own websites, one at a time, honouring robots.txt, at most{" "}
        {maxBatch} leads per run. It makes no Google request and costs nothing.
      </p>

      {result ? (
        <div className="space-y-2 rounded-lg border p-3">
          <p className="text-sm font-medium">
            {result.dryRun
              ? `Dry run — ${formatNumber(result.selected)} lead(s) in scope, nothing touched`
              : `${formatNumber(result.found)} found · ${formatNumber(result.notFound)} none published · ${formatNumber(result.failed)} unreadable`}
          </p>
          <ul className="space-y-1">
            {result.results.map((row) => (
              <li key={row.leadId} className="flex flex-wrap items-baseline gap-2 text-xs">
                <span className="font-medium">{row.name}</span>
                <span className={STATUS_TONE[row.status] ?? "text-muted-foreground"}>
                  {row.status.replace(/_/g, " ")}
                </span>
                {row.email ? <span className="font-mono">{row.email}</span> : null}
                {row.confidence !== null ? (
                  <span className="text-muted-foreground tabular-nums">
                    {(row.confidence * 100).toFixed(0)}%
                  </span>
                ) : null}
                {row.error ? <span className="text-muted-foreground">{row.error}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
