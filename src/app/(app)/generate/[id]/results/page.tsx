import { CheckCircle2, Gauge, Mail, MailX, Percent, Users } from "lucide-react";
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
import { getCurrentUser, getSupabaseServerClient } from "@/server/db/server-client";
import { GenerationNotFoundError, loadGenerationState } from "@/server/generate/state";

export const metadata: Metadata = { title: "Your leads" };

export const dynamic = "force-dynamic";

/**
 * The centre of the product.
 *
 * Everything the generation produced, in one place, with the export as the
 * primary action. The user does not go to Leads to read the list, to Searches
 * to see coverage, to Enrichment to retry an address, or to Exports to get the
 * file.
 *
 * COVERAGE IS THE COMPLETION CRITERION, AND THE PAGE SAYS SO. The lead target
 * appears as a minimum that was met or not met; it never appears as a progress
 * bar toward "done". A run that found 51 leads against a target of 20 while
 * searching 83% of its area is presented as 51 leads and 83% searched -- not as
 * a success with a footnote.
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

  const finished = state.status === "completed";
  const ceilingReached = state.stopReason === "generation_call_ceiling";
  const enrichmentSkipped = state.stopReason === "enrichment_not_consented";

  return (
    <>
      <PageHeader
        title={finished ? "Your leads are ready" : "Your leads so far are ready"}
        description={`${state.niche} · ${state.locationLabel}`}
        actions={
          <Button variant="outline" size="sm" render={<Link href="/generate" />}>
            Generate more leads
          </Button>
        }
      />

      {/* ---- Headline figures ---- */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
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
          sublabel={`${formatNumber(state.enrichment.leadsWithWebsite)} of these businesses have a website`}
          icon={Mail}
          tone={state.enrichment.found > 0 ? "positive" : undefined}
        />
        <StatCard
          label="Area searched"
          value={formatPercent(state.search.coveragePct, 1)}
          sublabel={
            state.search.fullyCovered
              ? "the whole selected area"
              : `${state.search.areaOwedKm2.toFixed(1)} km² not searched`
          }
          icon={Percent}
          tone={state.search.fullyCovered ? "positive" : "warning"}
        />
        <StatCard
          label="No email on the site"
          value={formatNumber(state.enrichment.notFound)}
          sublabel="checked, but no address published"
          icon={MailX}
        />
        <StatCard
          label="Could not be checked"
          value={formatNumber(state.enrichment.failed)}
          sublabel="the site blocked or did not answer"
          icon={MailX}
          tone={state.enrichment.failed > 0 ? "warning" : undefined}
        />
        <StatCard
          label="Google requests used"
          value={`${formatNumber(state.budget.used)} / ${formatNumber(state.budget.ceiling)}`}
          sublabel={`${formatNumber(state.budget.quotaRemaining)} left in this month's protected allowance`}
          icon={Gauge}
        />
      </div>

      {/* ---- Completed in ---- */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-8 gap-y-2 pt-6 text-sm">
          <span className="flex items-center gap-2">
            <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />
            <span className="text-muted-foreground">Completed in</span>
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

      {/* ---- Why it stopped, when it is not simply finished ---- */}
      {ceilingReached ? (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="space-y-1 pt-6">
            <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
              This generation reached its current safety limit.
            </p>
            <p className="text-muted-foreground text-xs">
              {formatNumber(state.budget.used)} of {formatNumber(state.budget.ceiling)} Google
              requests were used, and {formatNumber(state.search.areasRemaining)} section(s) —{" "}
              {state.search.areaOwedKm2.toFixed(1)} km² — have not been searched. Continuing starts
              a new approval for another {formatNumber(state.budget.ceiling)} requests. Nothing
              continues without you.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {enrichmentSkipped ? (
        <Card>
          <CardContent className="space-y-1 pt-6">
            <p className="text-sm font-medium">Email discovery is available.</p>
            <p className="text-muted-foreground text-xs">
              This generation collected businesses only. Starting email discovery will visit the{" "}
              {formatNumber(state.enrichment.remaining)} business website(s) that have not been
              checked yet.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {/* ---- Actions ---- */}
      <div className="flex flex-wrap gap-3">
        <ExportExcelButton searchId={state.searchId} leadCount={leads.length} />

        {state.search.areasRemaining > 0 ? (
          <ContinueGenerationButton
            searchId={state.searchId}
            label={ceilingReached ? "Continue generation" : "Continue searching"}
            areasRemaining={state.search.areasRemaining}
          />
        ) : null}

        {state.enrichment.remaining > 0 ? (
          <ContinueGenerationButton
            searchId={state.searchId}
            label="Find emails"
            icon="mail"
            enrichEmails
          />
        ) : null}

        {state.enrichment.failed > 0 ? (
          <RetryFailedEmailsButton
            searchId={state.searchId}
            failedCount={state.enrichment.failed}
          />
        ) : null}
      </div>

      {/* ---- Coverage explanation ---- */}
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

          {!state.search.fullyCovered ? (
            <Accordion>
              <AccordionItem value="why">
                <AccordionTrigger className="text-sm">
                  Why isn&rsquo;t coverage 100%?
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground space-y-2 text-sm">
                  <p>
                    Your area is divided into sections and each one is searched separately, so we
                    always know exactly which parts have been looked at. This run stopped before
                    reaching every section — usually because it reached the number of Google
                    requests you approved.
                  </p>
                  <p>
                    Nothing was skipped silently. {formatNumber(state.search.areasRemaining)}{" "}
                    section(s) covering {state.search.areaOwedKm2.toFixed(1)} km² are still owed,
                    and Continue searching picks up exactly there.
                  </p>
                  <p>
                    Finding more leads than you asked for does not end a search. The target is a
                    minimum; the area being covered is what finishes it.
                  </p>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          ) : (
            <p className="text-muted-foreground text-sm">
              Every section of the selected area was searched.
            </p>
          )}
        </CardContent>
      </Card>

      {/* ---- The leads ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Leads</CardTitle>
        </CardHeader>
        <CardContent>
          <ResultsLeadTable leads={leads} />
        </CardContent>
      </Card>

      <p className="text-muted-foreground text-xs">
        Need the finer detail? The{" "}
        <Link href={`/searches/${state.searchId}`} className="underline">
          search view
        </Link>{" "}
        has the coverage map, the section-by-section table and the full activity log.
      </p>
    </>
  );
}
