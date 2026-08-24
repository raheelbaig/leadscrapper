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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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

      {/*
       * THE EMAIL OUTCOMES, AND WHY THEY MUST ALL BE SHOWN.
       *
       * A real run reported 204 found, 111 with no public address and 77
       * unreachable. Those sum to 392 -- every lead that HAD a website -- while
       * the other 93 had none at all and appeared only as "Not checked". A user
       * adding the first three up was left with 93 apparently outstanding on a
       * run that had genuinely finished. Naming the website-less bucket is what
       * makes the arithmetic close.
       */}
      <div className="text-muted-foreground flex flex-wrap gap-x-8 gap-y-1 px-1 text-xs">
        <span>
          Emails found{" "}
          <span className="text-foreground font-semibold tabular-nums">
            {formatNumber(state.enrichment.found)}
          </span>
        </span>
        <span>
          No public email{" "}
          <span className="text-foreground font-semibold tabular-nums">
            {formatNumber(state.enrichment.notFound)}
          </span>
        </span>
        <span>
          Could not check{" "}
          <span className="text-foreground font-semibold tabular-nums">
            {formatNumber(state.enrichment.failed)}
          </span>
        </span>
        <span>
          No website{" "}
          <span className="text-foreground font-semibold tabular-nums">
            {formatNumber(state.enrichment.leadsWithoutWebsite)}
          </span>
        </span>
        {state.enrichment.remaining > 0 ? (
          <span>
            Still to check{" "}
            <span className="text-foreground font-semibold tabular-nums">
              {formatNumber(state.enrichment.remaining)}
            </span>
          </span>
        ) : null}
      </div>

      <p className="text-muted-foreground px-1 text-xs">
        A business with no website has nothing to check — Google returns no email address at any
        tier, so the site is the only place a public one could be found.
      </p>

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

      {/* ---- SEARCH AREA ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Search area</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-base font-medium">{state.area.label}</p>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Figure
              label="Selected area"
              value={`${formatNumber(Math.round(state.area.totalKm2))} km²`}
            />
            <Figure label="Coverage" value={formatPercent(state.area.coveragePct, 1)} />
            <Figure
              label="Searched"
              value={`${formatNumber(Math.round(state.area.searchedKm2))} km²`}
            />
            <Figure
              label="Remaining"
              value={`${formatNumber(Math.round(state.area.remainingKm2))} km²`}
            />
          </div>

          {state.area.fullyCovered ? (
            <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="size-4" />
              Entire selected area searched
            </p>
          ) : (
            <p className="text-muted-foreground text-sm">
              Some of the selected area still needs to be searched.
            </p>
          )}

          <Accordion>
            <AccordionItem value="bounds">
              <AccordionTrigger className="text-sm">Area details</AccordionTrigger>
              <AccordionContent className="text-muted-foreground space-y-3 text-sm">
                {/*
                 * The EXACT persisted rectangle, not a description of the city.
                 * While external boundary lookups are off, this comes from a
                 * stored bounding box for the area, so it is labelled as the
                 * area that was selected and searchable rather than implying
                 * every square kilometre of the metro is inside it.
                 */}
                <p>
                  This is the rectangle the search was built from. It is the area that was selected
                  and searched — not necessarily every part of the wider metro area.
                </p>
                <dl className="grid grid-cols-2 gap-x-8 gap-y-1 font-mono text-xs sm:grid-cols-4">
                  <Bound label="North" value={state.area.bounds.north} />
                  <Bound label="South" value={state.area.bounds.south} />
                  <Bound label="East" value={state.area.bounds.east} />
                  <Bound label="West" value={state.area.bounds.west} />
                </dl>
                <p>
                  Divided into {formatNumber(state.search.areasTotal)} sections, of which{" "}
                  {formatNumber(state.search.areasSearched)} were searched
                  {state.search.areasRemaining > 0
                    ? ` and ${formatNumber(state.search.areasRemaining)} were not`
                    : ""}
                  .
                </p>
                {!state.search.fullyCovered ? (
                  <p>
                    A search ends when its whole area has been covered. This one stopped earlier —
                    usually on the limit for how many Google requests a single search may make — and
                    the part it did not reach is recorded rather than quietly dropped.
                  </p>
                ) : null}
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </CardContent>
      </Card>

      {/* ---- REQUEST USAGE ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Request usage</CardTitle>
          <CardDescription>
            Google Places and business-website checks are different things and are counted
            separately.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Figure
              label="Google Places"
              value={`${formatNumber(state.requests.googlePlacesThisSearch)} / ${formatNumber(state.requests.googleSearchBudget)}`}
              hint="this search"
            />
            <Figure
              label="Monthly Google"
              value={`${formatNumber(state.requests.googleMonthlyUsed)} / ${formatNumber(state.requests.googleMonthlyLimit)}`}
              hint="free usage only"
            />
            <Figure
              label="Website checks"
              value={formatNumber(state.requests.websitesChecked)}
              hint="business sites read for an email"
            />
            <Figure
              label="Geocoding"
              value={formatNumber(state.requests.geocoding)}
              hint="turned off"
            />
          </div>

          <p className="text-muted-foreground text-xs">
            Website checks are ordinary requests to the businesses&rsquo; own sites — they are not
            Google usage and cost nothing. Third-party email lookup services:{" "}
            <span className="text-foreground font-medium">
              {formatNumber(state.requests.thirdPartyEmail)}
            </span>{" "}
            — this product does not use any.
          </p>
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

/** One labelled figure. */
function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="space-y-0.5">
      <p className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
        {label}
      </p>
      <p className="text-base font-semibold tabular-nums">{value}</p>
      {hint ? <p className="text-muted-foreground text-[11px]">{hint}</p> : null}
    </div>
  );
}

/** One edge of the persisted rectangle, shown to six decimal places as stored. */
function Bound({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-foreground tabular-nums">{value.toFixed(4)}</dd>
    </div>
  );
}
