"use client";

import { ChevronDown, Loader2, Mail, Search, Square } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { ElapsedTimer } from "@/components/generate/elapsed-timer";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { formatNumber, formatPercent } from "@/lib/format";
import type { GenerationState } from "@/lib/generate/types";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

/**
 * The processing screen.
 *
 * ---------------------------------------------------------------------------
 * THE BROWSER IS A TRIGGER, NOT A WORKER.
 *
 * This component does exactly two things: it asks the server to continue, and
 * it renders what the server says. It never reaches Google, never reaches a
 * business website, never decides a budget, never chooses an area or a lead,
 * and never holds a figure Postgres does not already hold. Every number below
 * arrived from `/api/generate/[id]/state`.
 *
 * Closing the tab stops the ASKING. It does not roll anything back and it does
 * not corrupt anything: the run stays exactly where the database says it is,
 * with its remaining area still owed, and reopening the page resumes from
 * there. The screen says so in plain words rather than implying that work
 * continues on its own — the durable worker that would make that true is built
 * but switched off.
 *
 * Two concurrent advances are prevented by the database lease, not by the
 * `inFlight` ref below. The ref is a courtesy that avoids a pointless request;
 * the guarantee is `claim_search_job_by_id`, which a second caller simply would
 * not win.
 * ---------------------------------------------------------------------------
 */
export function ProcessingView({ initialState }: { initialState: GenerationState }) {
  const [state, setState] = useState<GenerationState>(initialState);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [showTechnical, setShowTechnical] = useState(false);

  const inFlight = useRef(false);
  const mounted = useRef(true);
  const router = useRouter();

  const runId = state.runId;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Re-reads the whole state. Free: no Google request, no external request. */
  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/generate/${runId}/state`, { cache: "no-store" });
      if (!response.ok) return;
      const next = (await response.json()) as GenerationState;
      if (mounted.current) setState(next);
    } catch {
      // A failed refresh is not worth interrupting the run for; the next
      // advance returns the authoritative state anyway.
    }
  }, [runId]);

  // ---- the advance loop ---------------------------------------------------
  // One request at a time, re-triggered by the state it produces. Written as a
  // reaction to state rather than as a `while` loop so that a stop, an error or
  // a phase change ends it by simply being the new state.
  useEffect(() => {
    if (inFlight.current) return;
    if (state.status !== "running" || !state.canAdvance) return;

    inFlight.current = true;
    let alive = true;

    (async () => {
      try {
        const response = await fetch(`/api/generate/${runId}/advance`, { method: "POST" });
        const payload = await response.json();

        if (!response.ok) {
          if (alive && mounted.current) {
            setError(payload.error ?? "We could not continue this generation.");
          }
          return;
        }

        if (alive && mounted.current) {
          setError(null);
          setState(payload as GenerationState);
        }
      } catch (cause) {
        if (alive && mounted.current) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        inFlight.current = false;
      }
    })();

    return () => {
      alive = false;
    };
  }, [state, runId]);

  // ---- live progress within a slice --------------------------------------
  // An advance can take up to a minute, and the search row is updated by the
  // heartbeat throughout. Subscribing means the figures move while a slice is
  // running rather than jumping once it ends. The browser is still only a
  // viewer here: it re-reads server state, it does not compute any of it.
  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    const channel = supabase
      .channel(`generation:${runId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "searches",
          filter: `id=eq.${state.searchId}`,
        },
        () => {
          void refresh();
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [runId, state.searchId, refresh]);

  // ---- finished -----------------------------------------------------------
  useEffect(() => {
    if (state.status === "running") return;
    const timer = setTimeout(() => router.replace(`/generate/${runId}/results`), 900);
    return () => clearTimeout(timer);
  }, [state.status, runId, router]);

  async function stop() {
    setStopping(true);
    try {
      const response = await fetch(`/api/generate/${runId}/stop`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok) {
        toast.error("Could not stop this generation", { description: payload.error });
        return;
      }
      setState(payload as GenerationState);
      toast.info("Stopped. Everything found so far has been kept.");
    } finally {
      setStopping(false);
    }
  }

  const searching = state.phase === "searching";
  const working = state.status === "running";

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-xl">
                {working ? "Generating your leads" : "Generation finished"}
              </CardTitle>
              <CardDescription>
                {state.niche} · {state.locationLabel}
              </CardDescription>
            </div>
            {working ? (
              <Button
                variant="outline"
                size="sm"
                onClick={stop}
                disabled={stopping}
                className="gap-1.5"
              >
                {stopping ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Square className="size-3.5" />
                )}
                Stop
              </Button>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="space-y-1">
          <div className="flex items-center gap-2 text-sm">
            {working ? <Loader2 className="text-primary size-4 animate-spin" /> : null}
            <span className="font-medium">{state.headline}</span>
          </div>
          <p className="text-muted-foreground text-xs">
            Total elapsed <ElapsedTimer startedAt={state.createdAt} endedAt={state.completedAt} />
          </p>
        </CardContent>
      </Card>

      {/* ---- Phase 1: searching ---- */}
      <PhaseCard
        icon={Search}
        title="Searching businesses"
        active={searching && working}
        done={!searching}
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Figure
            label="Leads found"
            value={formatNumber(state.search.leadsFound)}
            hint={`minimum target ${formatNumber(state.search.targetLeads)}`}
          />
          <Figure
            label="Area searched"
            value={formatPercent(state.search.coveragePct, 0)}
            hint={`${formatNumber(state.search.areasSearched)} of ${formatNumber(state.search.areasTotal)} sections`}
          />
          <Figure
            label="Elapsed"
            value={
              <ElapsedTimer startedAt={state.search.startedAt} endedAt={state.search.completedAt} />
            }
            raw
          />
          <Figure label="Remaining" value={state.search.eta.label} raw small />
        </div>

        <Progress value={Math.min(state.search.coveragePct, 100)} className="mt-4" />

        {state.search.targetReached && state.search.leadsFound > state.search.targetLeads ? (
          <p className="text-muted-foreground mt-3 text-xs">
            {formatNumber(state.search.leadsFound)} leads — past the{" "}
            {formatNumber(state.search.targetLeads)} you asked for. The target is a minimum, so the
            search keeps going until the area is covered.
          </p>
        ) : null}
      </PhaseCard>

      {/* ---- Phase 2: emails ---- */}
      <PhaseCard
        icon={Mail}
        title="Finding business emails"
        active={!searching && working}
        done={state.phase === "ready"}
        muted={searching}
      >
        {searching ? (
          <p className="text-muted-foreground text-sm">
            {state.enrichment.consented
              ? "Starts automatically once the area has been searched."
              : "Not part of this generation — you can start it afterwards."}
          </p>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Figure
                label="Emails found"
                value={formatNumber(state.enrichment.found)}
                hint={`${formatNumber(state.enrichment.leadsWithWebsite)} leads have a website`}
              />
              <Figure
                label="Checked"
                value={`${formatNumber(state.enrichment.checked)} / ${formatNumber(state.enrichment.leadsWithWebsite)}`}
                hint={`${formatNumber(state.enrichment.notFound)} without an address · ${formatNumber(state.enrichment.failed)} unreachable`}
              />
              <Figure
                label="Elapsed"
                value={
                  <ElapsedTimer
                    startedAt={state.enrichment.startedAt}
                    endedAt={state.enrichment.completedAt}
                  />
                }
                raw
              />
              <Figure label="Remaining" value={state.enrichment.eta.label} raw small />
            </div>

            <Progress
              value={
                state.enrichment.leadsWithWebsite > 0
                  ? (state.enrichment.checked / state.enrichment.leadsWithWebsite) * 100
                  : 0
              }
              className="mt-4"
            />

            <p className="text-muted-foreground mt-3 text-xs">
              Checking public business websites for contact emails, one business at a time.
            </p>
          </>
        )}
      </PhaseCard>

      {/* ---- Approval budget ---- */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 pt-6 text-xs">
          <span className="text-muted-foreground">
            Google requests used in this approval{" "}
            <span className="text-foreground font-semibold tabular-nums">
              {formatNumber(state.budget.used)} / {formatNumber(state.budget.ceiling)}
            </span>
          </span>
          <span className="text-muted-foreground">
            Remaining in this approval{" "}
            <span className="text-foreground font-semibold tabular-nums">
              {formatNumber(state.budget.remaining)}
            </span>
          </span>
          <span className="text-muted-foreground">
            Protected monthly quota{" "}
            <span className="text-foreground font-semibold tabular-nums">
              {formatNumber(state.budget.quotaRemaining)} left
            </span>
          </span>
        </CardContent>
      </Card>

      {error ? (
        <Card className="border-red-500/40 bg-red-500/5">
          <CardContent className="space-y-2 pt-6">
            <p className="text-sm font-medium text-red-700 dark:text-red-400">
              This generation hit a problem.
            </p>
            <p className="text-muted-foreground text-xs">{error}</p>
          </CardContent>
        </Card>
      ) : null}

      {/* ---- Honest note about the tab ---- */}
      {working ? (
        <p className="text-muted-foreground text-xs">
          Keep this tab open while it works. If you close it, nothing is lost and nothing is undone
          — the generation simply pauses where it is, and reopening this page continues it.
        </p>
      ) : null}

      <div>
        <button
          type="button"
          onClick={() => setShowTechnical((value) => !value)}
          className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs"
        >
          <ChevronDown
            className={cn("size-3.5 transition-transform", showTechnical && "rotate-180")}
          />
          Technical details
        </button>

        {showTechnical ? (
          <dl className="text-muted-foreground mt-3 grid gap-x-6 gap-y-1 rounded-lg border p-4 text-xs sm:grid-cols-2">
            <TechRow label="Run" value={state.runId} />
            <TechRow label="Search" value={state.searchId} />
            <TechRow label="Phase" value={state.phase} />
            <TechRow label="Run status" value={state.status} />
            <TechRow label="Search status" value={state.search.searchStatus} />
            <TechRow label="Stop reason" value={state.stopReason ?? "—"} />
            <TechRow
              label="Sections remaining"
              value={`${state.search.areasRemaining} (${state.search.areaOwedKm2.toFixed(1)} km² unsearched)`}
            />
            <TechRow
              label="Search call budget"
              value={`${state.budget.searchCallsUsed} / ${state.budget.searchCallBudget}`}
            />
            <TechRow
              label="ETA basis (search)"
              value={`${state.search.eta.basis}, ${state.search.eta.samples} sample(s)`}
            />
            <TechRow
              label="ETA basis (email)"
              value={`${state.enrichment.eta.basis}, ${state.enrichment.eta.samples} sample(s)`}
            />
            <TechRow
              label="Worst case remaining"
              value={
                [state.search.eta.worstCaseLabel, state.enrichment.eta.worstCaseLabel]
                  .filter(Boolean)
                  .join(" · ") || "—"
              }
            />
            <TechRow
              label="Max further website requests"
              value={formatNumber(state.enrichment.maxExternalRequestsRemaining)}
            />
          </dl>
        ) : null}
      </div>
    </div>
  );
}

function PhaseCard({
  icon: Icon,
  title,
  active,
  done,
  muted,
  children,
}: {
  icon: typeof Search;
  title: string;
  active: boolean;
  done: boolean;
  muted?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card className={cn(active && "border-primary/40", muted && "opacity-70")}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Icon className={cn("size-4", active ? "text-primary" : "text-muted-foreground")} />
          {title}
          {done ? <span className="text-muted-foreground text-xs font-normal">· done</span> : null}
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function Figure({
  label,
  value,
  hint,
  raw,
  small,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  raw?: boolean;
  small?: boolean;
}) {
  return (
    <div className="space-y-0.5">
      <p className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
        {label}
      </p>
      <p
        className={cn(
          "font-semibold tabular-nums",
          small ? "text-sm" : "text-base",
          raw && "font-mono",
        )}
      >
        {value}
      </p>
      {hint ? <p className="text-muted-foreground text-[11px]">{hint}</p> : null}
    </div>
  );
}

function TechRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 py-0.5">
      <dt>{label}</dt>
      <dd className="text-foreground truncate font-mono">{value}</dd>
    </div>
  );
}
