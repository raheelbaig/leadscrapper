import { Clock, Globe, Info, Mail, ShieldQuestion } from "lucide-react";
import type { Metadata } from "next";

import { StatCard } from "@/components/common/stat-card";
import { EnrichmentRunner } from "@/components/enrichment/enrichment-runner";
import { PageHeader } from "@/components/layout/page-header";
import { EmailStatusBadge } from "@/components/leads/email-status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatNumber } from "@/lib/format";
import { getSupabaseServerClient } from "@/server/db/server-client";
import { MAX_ENRICHMENT_BATCH } from "@/server/enrichment/run-enrichment";

export const metadata: Metadata = { title: "Enrichment" };

export const dynamic = "force-dynamic";

const STATUS_ORDER = [
  "not_enriched",
  "queued",
  "found",
  "verified",
  "unverified",
  "not_found",
  "failed",
] as const;

export default async function EnrichmentPage() {
  const supabase = await getSupabaseServerClient();

  const [{ count: total }, { count: withWebsite }, { count: pending }, { count: attempts }] =
    await Promise.all([
      supabase.from("leads").select("id", { count: "exact", head: true }),
      supabase
        .from("leads")
        .select("id", { count: "exact", head: true })
        .not("website", "is", null),
      supabase
        .from("leads")
        .select("id", { count: "exact", head: true })
        .not("website", "is", null)
        .neq("website", "")
        .eq("email_status", "not_enriched"),
      supabase.from("lead_enrichment_attempts").select("id", { count: "exact", head: true }),
    ]);

  // Per-status counts, for the pipeline row.
  const statusCounts = await Promise.all(
    STATUS_ORDER.map(async (status) => {
      const { count } = await supabase
        .from("leads")
        .select("id", { count: "exact", head: true })
        .eq("email_status", status);
      return [status, count ?? 0] as const;
    }),
  );

  return (
    <>
      <PageHeader
        title="Email enrichment"
        description="Turning a business website into a contact address, as a separate subsystem that never runs inside the Places search loop."
      />

      <Alert>
        <Info className="size-4" />
        <AlertTitle>The Google Places API does not return email addresses</AlertTitle>
        <AlertDescription>
          Not in any field, tier, or endpoint. What Google does give us is the business website, and
          that website is the input to email discovery. Any lead without a website has no starting
          point for enrichment at all.
        </AlertDescription>
      </Alert>

      <div className="grid gap-4 sm:grid-cols-4">
        <StatCard label="Total leads" value={formatNumber(total ?? 0)} icon={Mail} />
        <StatCard
          label="Enrichable"
          value={formatNumber(withWebsite ?? 0)}
          sublabel="Leads that have a website"
          icon={Globe}
        />
        <StatCard
          label="Never checked"
          value={formatNumber(pending ?? 0)}
          sublabel="Have a website, not yet looked at"
          icon={Clock}
        />
        <StatCard
          label="No website"
          value={formatNumber((total ?? 0) - (withWebsite ?? 0))}
          sublabel="No path to an email"
          icon={ShieldQuestion}
          tone="warning"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Run enrichment</CardTitle>
          <CardDescription>
            Reads each business&rsquo;s own public website — homepage, then the usual contact pages
            — looking for a published address. One lead at a time, robots.txt honoured, at most{" "}
            {MAX_ENRICHMENT_BATCH} per run. No third-party email API is involved and nothing is
            billed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <EnrichmentRunner maxBatch={MAX_ENRICHMENT_BATCH} pending={pending ?? 0} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Pipeline</CardTitle>
          <CardDescription>
            Website → discovery → confidence → lead. {formatNumber(attempts ?? 0)} attempt(s)
            recorded so far.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-3">
            {statusCounts.map(([status, count]) => (
              <div key={status} className="flex items-center gap-1.5">
                <EmailStatusBadge status={status} />
                <span className="text-sm font-medium tabular-nums">{formatNumber(count)}</span>
              </div>
            ))}
          </div>

          <div className="text-muted-foreground space-y-2 text-sm">
            <p>
              <span className="text-foreground font-medium">not found</span> and{" "}
              <span className="text-foreground font-medium">not enriched</span> are different facts
              and are kept apart deliberately: one means the site was read and published no address,
              the other means nobody has looked yet. A status is only ever written after a real
              attempt, and every attempt — including the ones that found nothing — is recorded in
              the attempt log.
            </p>
            <p>
              Nothing is ever marked <span className="text-foreground font-medium">verified</span>{" "}
              by this provider. Verification means asking a mail server whether a mailbox exists,
              and reading a well-formed string off a web page is not that.
            </p>
            <p>
              Providers register behind one interface ordered cheapest-first, so a paid discovery
              API can be added later without touching the Places search engine — and it would meter
              through the same quota service, which means free-limit protection extends to it
              automatically.
            </p>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
