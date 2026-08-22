"use client";

import { Loader2, Mail, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatNumber } from "@/lib/format";

/**
 * The manual trigger for a bounded enrichment run.
 *
 * NOTHING STARTS WITHOUT A CONFIRMED SCOPE. Pressing a button runs a DRY RUN
 * first — which writes nothing and requests nothing — and shows exactly what
 * the live run would do: how many leads, how many of them have websites, the
 * worst-case number of requests to other people's servers, the provider, the
 * concurrency and the batch cap. Only an explicit confirmation on those numbers
 * starts the real thing.
 *
 * That ordering is the point. These requests go to small businesses' own web
 * hosts, and the figure a person approves should be the largest one the run
 * could actually reach, not an average that flatters it.
 */

type Outcome = {
  leadId: string;
  name: string;
  status: string;
  email: string | null;
  confidence: number | null;
  error: string | null;
};

type Scope = {
  mode: string;
  eligible: number;
  selected: number;
  withWebsite: number;
  maxExternalRequests: number;
  provider: string;
  concurrency: number;
  batchCap: number;
  remaining: number;
  skipped: { leadId: string; name: string; reason: string }[];
};

type RunResult = {
  dryRun: boolean;
  mode: string;
  selected: number;
  processed: number;
  found: number;
  notFound: number;
  failed: number;
  remaining: number;
  scope: Scope;
  results: Outcome[];
};

type Mode = "new" | "retry-failed";

const STATUS_TONE: Record<string, string> = {
  found: "text-emerald-700 dark:text-emerald-400",
  verified: "text-emerald-700 dark:text-emerald-400",
  not_found: "text-muted-foreground",
  failed: "text-red-600 dark:text-red-400",
  not_enriched: "text-muted-foreground",
};

const MODE_LABEL: Record<Mode, string> = {
  new: "leads never checked",
  "retry-failed": "leads whose last attempt failed",
};

export function EnrichmentRunner({
  maxBatch,
  pending,
  failed,
  attemptCap,
}: {
  maxBatch: number;
  pending: number;
  failed: number;
  attemptCap: number;
}) {
  const [limit, setLimit] = useState(5);
  const [busy, setBusy] = useState<Mode | null>(null);
  const [confirming, setConfirming] = useState<{ mode: Mode; scope: Scope } | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const router = useRouter();

  async function post(mode: Mode, dryRun: boolean): Promise<RunResult | null> {
    const response = await fetch("/api/enrichment/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode, dryRun, limit }),
    });
    const payload = await response.json();

    if (!response.ok) {
      toast.error("The enrichment run failed", { description: payload.error });
      return null;
    }
    return payload as RunResult;
  }

  /** Step 1: resolve the scope. Writes nothing, requests nothing. */
  async function propose(mode: Mode) {
    setBusy(mode);
    try {
      const dry = await post(mode, true);
      if (!dry) return;

      setResult(dry);

      if (dry.scope.selected === 0) {
        toast.info("Nothing to do", {
          description:
            dry.scope.skipped.length > 0
              ? `${dry.scope.skipped.length} lead(s) were skipped: ${dry.scope.skipped[0].reason}`
              : `No ${MODE_LABEL[mode]} are waiting.`,
        });
        return;
      }

      setConfirming({ mode, scope: dry.scope });
    } catch (error) {
      toast.error("Could not work out the scope", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(null);
    }
  }

  /** Step 2: only after the numbers above were confirmed. */
  async function execute(mode: Mode) {
    setConfirming(null);
    setBusy(mode);
    try {
      const live = await post(mode, false);
      if (!live) return;

      setResult(live);
      toast.success(
        `${formatNumber(live.found)} address(es) found across ${formatNumber(live.processed)} lead(s)`,
        {
          description: `${formatNumber(live.notFound)} published none · ${formatNumber(live.failed)} could not be read · ${formatNumber(live.remaining)} still waiting.`,
        },
      );
      router.refresh();
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
          size="lg"
          className="gap-2"
          disabled={busy !== null || pending === 0}
          onClick={() => propose("new")}
        >
          {busy === "new" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Mail className="size-4" />
          )}
          Enrich {formatNumber(Math.min(limit, pending))} new lead(s)
        </Button>

        <Button
          variant="outline"
          size="lg"
          className="gap-2"
          disabled={busy !== null || failed === 0}
          onClick={() => propose("retry-failed")}
        >
          {busy === "retry-failed" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RotateCcw className="size-4" />
          )}
          Retry {formatNumber(Math.min(limit, failed))} failed
        </Button>
      </div>

      <p className="text-muted-foreground text-xs">
        Both buttons resolve the scope first and show it for confirmation — nothing is requested
        until you approve the numbers. Retry only ever touches leads whose last attempt{" "}
        <span className="text-foreground font-medium">failed</span>; it cannot reach one where an
        address was already found. A lead is retired after {attemptCap} attempts, so retrying is
        bounded rather than something you can hold down.
      </p>

      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirming?.mode === "retry-failed"
                ? "Retry these failed leads?"
                : "Read these websites?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              This makes real requests to other businesses&rsquo; own web servers. Nothing has been
              requested yet.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {confirming ? (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">Leads</dt>
              <dd className="text-right font-medium tabular-nums">
                {formatNumber(confirming.scope.selected)}
              </dd>

              <dt className="text-muted-foreground">With a website</dt>
              <dd className="text-right font-medium tabular-nums">
                {formatNumber(confirming.scope.withWebsite)}
              </dd>

              <dt className="text-muted-foreground">Max website requests</dt>
              <dd className="text-right font-medium tabular-nums">
                {formatNumber(confirming.scope.maxExternalRequests)}
              </dd>

              <dt className="text-muted-foreground">Provider</dt>
              <dd className="text-right font-medium">{confirming.scope.provider}</dd>

              <dt className="text-muted-foreground">Concurrency</dt>
              <dd className="text-right font-medium tabular-nums">
                {confirming.scope.concurrency} (sequential)
              </dd>

              <dt className="text-muted-foreground">Batch cap</dt>
              <dd className="text-right font-medium tabular-nums">{confirming.scope.batchCap}</dd>

              <dt className="text-muted-foreground">Google / paid calls</dt>
              <dd className="text-right font-medium">0</dd>

              {confirming.scope.remaining > 0 ? (
                <>
                  <dt className="text-muted-foreground">Left for later</dt>
                  <dd className="text-right font-medium tabular-nums">
                    {formatNumber(confirming.scope.remaining)}
                  </dd>
                </>
              ) : null}

              {confirming.scope.skipped.length > 0 ? (
                <>
                  <dt className="text-muted-foreground">Skipped</dt>
                  <dd className="text-right font-medium tabular-nums">
                    {formatNumber(confirming.scope.skipped.length)}
                  </dd>
                </>
              ) : null}
            </dl>
          ) : null}

          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirming && execute(confirming.mode)}>
              Start — {formatNumber(confirming?.scope.maxExternalRequests ?? 0)} request(s) max
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {result ? (
        <div className="space-y-2 rounded-lg border p-3">
          <p className="text-sm font-medium">
            {result.dryRun
              ? `Scope only — ${formatNumber(result.scope.selected)} lead(s), nothing touched`
              : `${formatNumber(result.found)} found · ${formatNumber(result.notFound)} published none · ${formatNumber(result.failed)} unreadable`}
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
          {result.scope.skipped.length > 0 ? (
            <ul className="border-t pt-2">
              {result.scope.skipped.map((s) => (
                <li key={s.leadId} className="text-muted-foreground text-xs">
                  <span className="font-medium">{s.name}</span> — skipped: {s.reason}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Per-lead retry, for a single failed lead shown in a list. */
export function RetryLeadButton({ leadId, name }: { leadId: string; name: string }) {
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function retry() {
    setBusy(true);
    try {
      const response = await fetch("/api/enrichment/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Explicit: this lead, retry mode, one lead. The server still refuses
        // if the lead is not actually `failed` or has hit the attempt cap.
        body: JSON.stringify({ mode: "retry-failed", leadIds: [leadId], limit: 1, dryRun: false }),
      });
      const payload = await response.json();

      if (!response.ok) {
        toast.error("Retry failed", { description: payload.error });
        return;
      }

      const run = payload as RunResult;
      if (run.processed === 0) {
        toast.info(`${name} was not retried`, {
          description: run.scope.skipped[0]?.reason ?? "It is no longer eligible for retry.",
        });
        return;
      }

      const outcome = run.results[0];
      if (outcome.email) {
        toast.success(`${name}: ${outcome.email}`, {
          description: `confidence ${((outcome.confidence ?? 0) * 100).toFixed(0)}%`,
        });
      } else {
        toast.info(`${name}: ${outcome.status.replace(/_/g, " ")}`, {
          description: outcome.error ?? "No address was published.",
        });
      }

      router.refresh();
    } catch (error) {
      toast.error("Retry failed", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button variant="ghost" size="sm" className="gap-1.5" disabled={busy} onClick={retry}>
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
      Retry
    </Button>
  );
}
