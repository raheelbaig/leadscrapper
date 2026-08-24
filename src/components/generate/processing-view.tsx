"use client";

import { Check, ChevronDown, Circle, Loader2, Square, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { ElapsedTimer } from "@/components/generate/elapsed-timer";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { formatNumber, formatPercent } from "@/lib/format";
import { requestAdvance } from "@/lib/generate/advance-client";
import type { GenerationState, GenerationStep } from "@/lib/generate/types";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

/**
 * The processing screen: one continuous process, three visible steps.
 *
 * ---------------------------------------------------------------------------
 * THE CLIENT HOLDS NO BUSINESS LOGIC.
 *
 * It does exactly three things: ask the server to continue, render what comes
 * back, and offer Stop. It does not decide how many areas a slice may search,
 * whether quota allows a request, when the search is complete, how many email
 * batches remain, or when to move between steps. Every one of those is a server
 * conclusion that arrives in the state payload -- including the heading and the
 * step markers below, which are computed in `describeRun`.
 *
 * It also never reaches Google or a business website. The only host it talks to
 * is this application's own API.
 *
 * ONE PRESS, WHOLE LIFECYCLE. The user approved the generation, not each slice,
 * so this asks for the next slice automatically until the server stops saying
 * there is more to do. What bounds that is not the user's patience but the hard
 * limits the server enforces: the per-search call budget, the protected monthly
 * allowance, and a liveness guard that halts a run which stops progressing.
 *
 * WHAT CLOSING THE TAB DOES. It stops the asking. Nothing is lost, nothing is
 * rolled back, and everything collected stays exactly where the database has
 * it -- but work does NOT continue on its own, because the durable worker is
 * switched off. The screen says that plainly rather than implying otherwise,
 * and reopening the generation resumes it from the same point.
 * ---------------------------------------------------------------------------
 */

export function ProcessingView({ initialState }: { initialState: GenerationState }) {
  const [state, setState] = useState<GenerationState>(initialState);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [showTechnical, setShowTechnical] = useState(false);

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

  // ---- the lifecycle loop -------------------------------------------------
  // One advance at a time, re-triggered by the state it produces, until the
  // server stops saying there is more to do.
  //
  // The in-flight guard lives at MODULE scope in `requestAdvance`, not in a ref
  // here. A ref is reset by React's effect cleanup -- which runs before every
  // re-run and on every unmount -- so navigating away and back would start a
  // second advance while the first was still executing on the server. That is
  // precisely how a healthy 357-lead run came to be recorded as failed. Sharing
  // the promise means a remount JOINS the request in progress instead of racing
  // it, with no delay involved.
  useEffect(() => {
    if (state.status !== "running" || !state.canAdvance) return;

    let alive = true;

    void requestAdvance(runId).then((outcome) => {
      if (!alive || !mounted.current) return;

      if (!outcome.ok) {
        setError(outcome.error);
        return;
      }

      setError(null);
      setState(outcome.state);
    });

    return () => {
      // Stops THIS component reacting. It deliberately does not cancel the
      // request or clear the registry: the server keeps working either way, and
      // forgetting about it is what caused the overlap.
      alive = false;
    };
  }, [state, runId]);

  // ---- live progress within a slice --------------------------------------
  // A slice can take up to a minute and the search row is updated by the
  // heartbeat throughout, so the figures move while it runs instead of jumping
  // when it ends. The browser is still only a viewer: it re-reads server state.
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
    const timer = setTimeout(() => router.replace(`/generate/${runId}/results`), 1_200);
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
      toast.info("Generation stopped. Everything found so far has been kept.");
    } finally {
      setStopping(false);
    }
  }

  const working = state.status === "running";
  const searching = state.displayState === "searching";
  const findingEmails = state.displayState === "finding-emails";

  // The step that is running decides which estimate is the relevant one.
  const eta = searching ? state.search.eta : state.enrichment.eta;

  return (
    <div className="space-y-4">
      {/* ---- Heading, timer, steps, stop ---- */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <CardTitle className="text-xl">{state.title}</CardTitle>
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
                Stop generation
              </Button>
            ) : null}
          </div>
        </CardHeader>

        <CardContent className="space-y-5">
          <div className="flex flex-wrap items-center gap-x-8 gap-y-2 text-sm">
            <span className="text-muted-foreground">
              Elapsed{" "}
              <ElapsedTimer
                startedAt={state.createdAt}
                endedAt={state.completedAt}
                className="text-foreground font-mono font-semibold"
              />
            </span>
            {working ? (
              <span className="text-muted-foreground">
                Estimated remaining <span className="text-foreground font-medium">{eta.label}</span>
              </span>
            ) : null}
          </div>

          {/*
           * THE FOUR FIGURES THAT MATTER WHILE IT RUNS.
           *
           * Leads and emails are what the user came for; Google requests and
           * area searched are what tell them how far along it is and what it is
           * costing. Everything else -- sections, tiles, budgets, quota
           * mechanics -- is under Technical details.
           */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Figure label="Leads found" value={formatNumber(state.search.leadsFound)} />
            <Figure label="Emails found" value={formatNumber(state.enrichment.found)} />
            <Figure
              label="Google requests"
              value={`${formatNumber(state.budget.used)} / ${formatNumber(state.budget.ceiling)}`}
              hint={`${formatNumber(state.budget.quotaUsed)} / ${formatNumber(state.budget.quotaFreeLimit)} this month`}
            />
            <Figure label="Area searched" value={formatPercent(state.search.coveragePct, 0)} />
          </div>

          <Progress value={Math.min(state.search.coveragePct, 100)} />

          <ol className="space-y-2.5">
            {state.steps.map((step) => (
              <StepRow key={step.id} step={step} />
            ))}
          </ol>

          <p className="flex items-center gap-2 text-sm">
            {working ? <Loader2 className="text-primary size-4 animate-spin" /> : null}
            <span className="font-medium">{state.headline}</span>
          </p>
        </CardContent>
      </Card>

      {/* ---- Detail for the running step ---- */}
      {searching ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Searching businesses</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
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
                label="Sections remaining"
                value={formatNumber(state.search.areasRemaining)}
                hint={`${state.search.areaOwedKm2.toFixed(0)} km² still to search`}
              />
              <Figure
                label="Elapsed in this step"
                value={
                  <ElapsedTimer
                    startedAt={state.search.startedAt}
                    endedAt={state.search.completedAt}
                  />
                }
                mono
              />
            </div>
            <Progress value={Math.min(state.search.coveragePct, 100)} />
            {state.search.targetReached && state.search.leadsFound > state.search.targetLeads ? (
              <p className="text-muted-foreground text-xs">
                {formatNumber(state.search.leadsFound)} leads — already past the{" "}
                {formatNumber(state.search.targetLeads)} you asked for. That target is a minimum, so
                we keep going until the whole area has been searched.
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {findingEmails ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Finding business emails</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Figure
                label="Businesses with a website"
                value={formatNumber(state.enrichment.leadsWithWebsite)}
                hint={`${formatNumber(state.enrichment.leadsWithoutWebsite)} have none to check`}
              />
              <Figure
                label="Emails found"
                value={formatNumber(state.enrichment.found)}
                hint={`${formatNumber(state.enrichment.notFound)} publish no address`}
              />
              <Figure
                label="Still to check"
                value={formatNumber(state.enrichment.remaining)}
                hint={`${formatNumber(state.enrichment.failed)} could not be checked`}
              />
              <Figure
                label="Elapsed in this step"
                value={
                  <ElapsedTimer
                    startedAt={state.enrichment.startedAt}
                    endedAt={state.enrichment.completedAt}
                  />
                }
                mono
              />
            </div>
            <Progress
              value={
                state.enrichment.leadsWithWebsite > 0
                  ? (state.enrichment.checked / state.enrichment.leadsWithWebsite) * 100
                  : 0
              }
            />
            <p className="text-muted-foreground text-xs">
              Checking public business websites for contact emails, one business at a time.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {/* ---- Errors and honest endings ---- */}
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

      {state.blockedReason && !working ? (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="pt-6">
            <p className="text-sm text-amber-700 dark:text-amber-400">{state.blockedReason}</p>
          </CardContent>
        </Card>
      ) : null}

      {working ? (
        <p className="text-muted-foreground text-xs">
          Keep this tab open while it works. If you close it, nothing is lost and nothing is undone
          — but the generation pauses where it is rather than carrying on in the background, and
          reopening this page continues it.
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
            <TechRow label="Display state" value={state.displayState} />
            <TechRow label="Run status" value={state.status} />
            <TechRow label="Search status" value={state.search.searchStatus} />
            <TechRow label="Stop reason" value={state.stopReason ?? "—"} />
            <TechRow
              label="Google calls (this run)"
              value={`${state.budget.used} / ${state.budget.ceiling}`}
            />
            <TechRow
              label="Google calls (this search)"
              value={`${state.budget.searchCallsUsed} / ${state.budget.searchCallBudget}`}
            />
            <TechRow
              label="Protected quota left"
              value={`${formatNumber(state.budget.quotaRemaining)} of ${formatNumber(state.budget.quotaFreeLimit)}`}
            />
            <TechRow
              label="Sections remaining"
              value={`${state.search.areasRemaining} (${state.search.areaOwedKm2.toFixed(1)} km²)`}
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

/** One row of the three-step flow. */
function StepRow({ step }: { step: GenerationStep }) {
  const icon =
    step.state === "done" ? (
      <Check className="size-3.5" />
    ) : step.state === "active" ? (
      <Loader2 className="size-3.5 animate-spin" />
    ) : step.state === "blocked" ? (
      <X className="size-3.5" />
    ) : (
      <Circle className="size-2" />
    );

  return (
    <li className="flex items-center gap-3">
      <span
        aria-hidden
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-full border",
          step.state === "done" &&
            "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
          step.state === "active" && "border-primary/40 bg-primary/10 text-primary",
          step.state === "blocked" && "text-muted-foreground border-dashed",
          step.state === "pending" && "text-muted-foreground/50 border-dashed",
        )}
      >
        {icon}
      </span>
      <span
        className={cn(
          "text-sm",
          step.state === "active" && "font-medium",
          (step.state === "pending" || step.state === "blocked") && "text-muted-foreground",
        )}
      >
        {step.label}
      </span>
      <span className="sr-only">
        {step.state === "done"
          ? "completed"
          : step.state === "active"
            ? "in progress"
            : step.state === "blocked"
              ? "not done"
              : "waiting"}
      </span>
    </li>
  );
}

function Figure({
  label,
  value,
  hint,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  mono?: boolean;
}) {
  return (
    <div className="space-y-0.5">
      <p className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
        {label}
      </p>
      <p className={cn("text-base font-semibold tabular-nums", mono && "font-mono")}>{value}</p>
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
