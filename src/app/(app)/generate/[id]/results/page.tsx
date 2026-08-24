import { CheckCircle2, Gauge, Mail, Percent, ShieldAlert, Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { StatCard } from "@/components/common/stat-card";
import { ElapsedTimer } from "@/components/generate/elapsed-timer";
import {
  ContinueGenerationButton,
  ExportExcelButton,
  RetryFailedEmailsButton,
} from "@/components/generate/results-actions";
import { ResultsLeadTable, type ResultLead } from "@/components/generate/results-lead-table";
import { PageHeader } from "@/components/layout/page-header";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatNumber, formatPercent } from "@/lib/format";
import type { GenerationDisplayState } from "@/lib/generate/types";
import { getCurrentUser, getSupabaseServerClient } from "@/server/db/server-client";
import { GenerationNotFoundError, loadGenerationState } from "@/server/generate/state";

export const metadata: Metadata = { title: "Your leads" };

export const dynamic = "force-dynamic";

/**
 * The centre of the product.
 *
 * THE HEADING IS THE SERVER'S CONCLUSION, NOT THIS PAGE'S GUESS. `state.title`
 * is computed in `describeRun` from coverage and email progress, which is what
 * makes "Your leads are ready" impossible to render over an incomplete run. The
 * previous build said "Your leads so far are ready" above a run that had
 * searched 23% of its area and stopped at a call ceiling; that wording is gone,
 * and the states that replace it each say what actually happened.
 *
 * COVERAGE IS PART OF COMPLETION. 117 leads against a target of 15 with 23% of
 * the area searched is not a finished job, and nothing on this page presents it
 * as one.
 *
 * Continuing a run is NOT here as a primary action. The generation drives
 * itself to a real ending now, so a Continue button on the happy path would be
 * asking the user to do the orchestrator's job. It survives only inside the
 * Advanced disclosure, for a run that a safety limit genuinely halted.
 */
export default async function GenerationResultsPage(props: PageProps<"/generate/[id]/results">) {
  const { id } = await props.params;

  const user = await getCurrentUser();
  if (!user) redirect("/login");

  let state;
  try {
    state = await loadGenerationState({ runId: id, userId: user.id });
  } catch (error) {
    if (error instanceof GenerationNotFoundError) notFound();
    throw error;
  }

  // Still working: the processing screen owns a running run.
  if (state.status === "running") {
    redirect(`/generate/${id}`);
  }

  const supabase = await getSupabaseServerClient();
  const { data: leadRows } = await supabase
    .from("leads")
    .select(
      "id, name, phone_national, website, maps_url, email, email_status, email_confidence, city, state",
    )
    .eq("search_id", state.searchId)
    .order("name");

  const leads: ResultLead[] = (leadRows ?? []).map((lead) => ({
    id: lead.id,
    name: lead.name,
    phone: lead.phone_national,
    website: lead.website,
    mapsUrl: lead.maps_url,
    email: lead.email,
    emailStatus: lead.email_status,
    emailConfidence: lead.email_confidence,
    city: lead.city,
    state: lead.state,
  }));

  return (
    <>
      <PageHeader
        title={state.lifecycleComplete ? "Your Leads" : state.title}
        description={`${state.niche} · ${state.locationLabel}`}
        actions={
          <Button variant="outline" size="sm" render={<Link href="/generate" />}>
            Generate more leads
          </Button>
        }
      />

      <OutcomeBanner
        displayState={state.displayState}
        blockedReason={state.blockedReason}
        callsUsed={state.budget.used}
        callBudget={state.budget.searchCallBudget}
        areasRemaining={state.search.areasRemaining}
        areaOwedKm2={state.search.areaOwedKm2}
        coveragePct={state.search.coveragePct}
        leadsFound={state.search.leadsFound}
      />

      {/* ---- Headline figures ---- */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Total leads"
          value={formatNumber(state.search.leadsFound)}
          sublabel={
            state.search.targetReached
              ? `minimum target of ${formatNumber(state.search.targetLeads)} met`
              : `below the minimum target of ${formatNumber(state.search.targetLeads)}`
          }
          icon={Users}
        />
        <StatCard
          label="Emails found"
          value={formatNumber(state.enrichment.found)}
          sublabel={`${formatNumber(state.enrichment.leadsWithWebsite)} of these have a website`}
          icon={Mail}
          tone={state.enrichment.found > 0 ? "positive" : undefined}
        />
        <StatCard
          label="Google requests"
          value={formatNumber(state.budget.used)}
          sublabel={`${formatNumber(state.budget.quotaUsed)} / ${formatNumber(state.budget.quotaFreeLimit)} used this month`}
          icon={Gauge}
        />
        <StatCard
          label="Coverage"
          value={formatPercent(state.search.coveragePct, 1)}
          sublabel={
            state.search.fullyCovered
              ? "the whole selected area"
              : `${state.search.areaOwedKm2.toFixed(1)} km² not searched`
          }
          icon={Percent}
          tone={state.search.fullyCovered ? "positive" : "warning"}
        />
      </div>

      {/* The email outcomes worth knowing about, only when there are any. */}
      {state.enrichment.notFound > 0 || state.enrichment.failed > 0 ? (
        <div className="text-muted-foreground flex flex-wrap gap-x-8 gap-y-1 px-1 text-xs">
          {state.enrichment.notFound > 0 ? (
            <span>
              No public email{" "}
              <span className="text-foreground font-semibold tabular-nums">
                {formatNumber(state.enrichment.notFound)}
              </span>
            </span>
          ) : null}
          {state.enrichment.failed > 0 ? (
            <span>
              Could not check{" "}
              <span className="text-foreground font-semibold tabular-nums">
                {formatNumber(state.enrichment.failed)}
              </span>
            </span>
          ) : null}
        </div>
      ) : null}

      {/* ---- Completed in ---- */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-8 gap-y-2 pt-6 text-sm">
          <span className="flex items-center gap-2">
            {state.lifecycleComplete ? (
              <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />
            ) : null}
            <span className="text-muted-foreground">
              {state.lifecycleComplete ? "Completed in" : "Ran for"}
            </span>
            <ElapsedTimer
              startedAt={state.createdAt}
              endedAt={state.completedAt}
              className="font-mono font-semibold"
            />
          </span>
          <span className="text-muted-foreground">
            Minimum target{" "}
            <span className="text-foreground font-semibold tabular-nums">
              {formatNumber(state.search.targetLeads)}
            </span>
          </span>
          <span className="text-muted-foreground">
            Leads found{" "}
            <span className="text-foreground font-semibold tabular-nums">
              {formatNumber(state.search.leadsFound)}
            </span>
          </span>
        </CardContent>
      </Card>

      {/* ---- Actions. Export is the primary one. ---- */}
      <div className="flex flex-wrap items-center gap-3">
        <ExportExcelButton searchId={state.searchId} leadCount={leads.length} />

        {state.enrichment.failed > 0 ? (
          <RetryFailedEmailsButton
            searchId={state.searchId}
            failedCount={state.enrichment.failed}
          />
        ) : null}

        <Button variant="ghost" size="lg" render={<Link href={`/searches/${state.searchId}`} />}>
          View search details
        </Button>
      </div>

      {/* ---- The leads ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Leads</CardTitle>
        </CardHeader>
        <CardContent>
          <ResultsLeadTable leads={leads} />
        </CardContent>
      </Card>

      {/* ---- Coverage ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Coverage</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-x-8 gap-y-1 text-sm">
            <span className="text-muted-foreground">
              Area searched{" "}
              <span className="text-foreground font-semibold tabular-nums">
                {formatPercent(state.search.coveragePct, 1)}
              </span>
            </span>
            <span className="text-muted-foreground">
              Remaining area{" "}
              <span className="text-foreground font-semibold tabular-nums">
                {formatPercent(Math.max(100 - state.search.coveragePct, 0), 1)}
              </span>
            </span>
            <span className="text-muted-foreground">
              Sections{" "}
              <span className="text-foreground font-semibold tabular-nums">
                {formatNumber(state.search.areasSearched)} / {formatNumber(state.search.areasTotal)}
              </span>
            </span>
          </div>

          {state.search.fullyCovered ? (
            <p className="text-muted-foreground text-sm">
              Every section of the selected area was searched.
            </p>
          ) : (
            <Accordion>
              <AccordionItem value="why">
                <AccordionTrigger className="text-sm">
                  Why isn&rsquo;t coverage 100%?
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground space-y-2 text-sm">
                  <p>
                    Your area is divided into sections and each one is searched separately, so we
                    always know exactly which parts have been looked at. This generation ended
                    before reaching every section — usually because it reached the limit on how many
                    Google requests one search may make.
                  </p>
                  <p>
                    Nothing was skipped silently. {formatNumber(state.search.areasRemaining)}{" "}
                    section(s) covering {state.search.areaOwedKm2.toFixed(1)} km² are still owed and
                    still recorded.
                  </p>
                  <p>
                    Finding more leads than you asked for does not end a search. The target is a
                    minimum; the area being covered is what finishes it.
                  </p>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          )}
        </CardContent>
      </Card>

      {/* ---- Advanced. Continuing lives here, not on the happy path. ---- */}
      <Accordion>
        <AccordionItem value="advanced">
          <AccordionTrigger className="text-muted-foreground text-xs">
            Advanced controls
          </AccordionTrigger>
          <AccordionContent className="space-y-4 pt-2">
            <p className="text-muted-foreground text-xs">
              A generation drives itself to an ending, so these are recovery actions rather than
              steps in the normal flow.
            </p>

            <div className="flex flex-wrap gap-3">
              {state.search.areasRemaining > 0 ? (
                <ContinueGenerationButton
                  searchId={state.searchId}
                  label="Search the remaining area"
                  areasRemaining={state.search.areasRemaining}
                />
              ) : null}

              {state.enrichment.remaining > 0 ? (
                <ContinueGenerationButton
                  searchId={state.searchId}
                  label="Find emails for the remaining businesses"
                  icon="mail"
                  enrichEmails
                />
              ) : null}
            </div>

            <p className="text-muted-foreground text-xs">
              Full detail — the coverage map, the section-by-section table and the activity log — is
              on the{" "}
              <Link href={`/searches/${state.searchId}`} className="underline">
                search page
              </Link>
              . Every workbook you have generated is under{" "}
              <Link href="/exports" className="underline">
                Exports
              </Link>
              .
            </p>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </>
  );
}

/**
 * One honest sentence about how the generation ended.
 *
 * Rendered from the SERVER's display state, so the banner and the page heading
 * cannot disagree about whether the job is finished.
 */
function OutcomeBanner({
  displayState,
  blockedReason,
  callsUsed,
  callBudget,
  areasRemaining,
  areaOwedKm2,
  coveragePct,
  leadsFound,
}: {
  displayState: GenerationDisplayState;
  blockedReason: string | null;
  callsUsed: number;
  callBudget: number;
  areasRemaining: number;
  areaOwedKm2: number;
  coveragePct: number;
  leadsFound: number;
}) {
  if (displayState === "ready") return null;

  if (displayState === "paused-for-safety") {
    return (
      <Card className="border-amber-500/40 bg-amber-500/5">
        <CardContent className="space-y-2 pt-6">
          <p className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
            <ShieldAlert className="size-4" />
            Generation paused for safety
          </p>
          <p className="text-muted-foreground text-xs">
            {blockedReason ??
              "Your search safety limit was reached before the selected area was fully searched."}
          </p>
          <ul className="text-muted-foreground grid gap-1 text-xs sm:grid-cols-2">
            <li>
              Leads found:{" "}
              <span className="text-foreground font-medium">{formatNumber(leadsFound)}</span>
            </li>
            <li>
              Area searched:{" "}
              <span className="text-foreground font-medium">{formatPercent(coveragePct, 1)}</span>
            </li>
            <li>
              Google requests used:{" "}
              <span className="text-foreground font-medium">
                {formatNumber(callsUsed)} of {formatNumber(callBudget)}
              </span>
            </li>
            <li>
              Area not searched:{" "}
              <span className="text-foreground font-medium">
                {formatNumber(areasRemaining)} section(s), {areaOwedKm2.toFixed(1)} km²
              </span>
            </li>
          </ul>
          <p className="text-muted-foreground text-xs">
            No paid usage was entered and nothing was requested beyond the limit. Everything
            collected so far is below and can be exported.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (displayState === "failed") {
    return (
      <Card className="border-red-500/40 bg-red-500/5">
        <CardContent className="space-y-1 pt-6">
          <p className="text-sm font-medium text-red-700 dark:text-red-400">
            This generation could not be finished
          </p>
          <p className="text-muted-foreground text-xs">
            {blockedReason ?? "Something went wrong and the generation could not continue."}{" "}
            Everything collected before it stopped is below.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="space-y-1 pt-6">
        <p className="text-sm font-medium">Generation stopped</p>
        <p className="text-muted-foreground text-xs">
          {blockedReason ?? "You stopped this generation."} Everything collected before it stopped
          is below and can be exported.
        </p>
      </CardContent>
    </Card>
  );
}
