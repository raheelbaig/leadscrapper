import { Globe, Info, Mail, ShieldQuestion } from "lucide-react";
import type { Metadata } from "next";

import { PhaseNotice } from "@/components/common/phase-notice";
import { StatCard } from "@/components/common/stat-card";
import { PageHeader } from "@/components/layout/page-header";
import { EmailStatusBadge } from "@/components/leads/email-status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatNumber } from "@/lib/format";
import { getSupabaseServerClient } from "@/server/db/server-client";

export const metadata: Metadata = { title: "Enrichment" };

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

  const [{ count: total }, { count: withWebsite }] = await Promise.all([
    supabase.from("leads").select("id", { count: "exact", head: true }),
    supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .not("website", "is", null),
  ]);

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

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Total leads" value={formatNumber(total ?? 0)} icon={Mail} />
        <StatCard
          label="Enrichable"
          value={formatNumber(withWebsite ?? 0)}
          sublabel="Leads that have a website"
          icon={Globe}
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
          <CardTitle>Pipeline</CardTitle>
          <CardDescription>Website → discovery → verification → confidence → lead</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {STATUS_ORDER.map((s) => (
              <EmailStatusBadge key={s} status={s} />
            ))}
          </div>
          <p className="text-muted-foreground text-sm">
            Providers register behind one interface, so website extraction, Hunter, Snov or anything
            else can be added later without touching the Places search engine. Each provider is
            metered through the same quota service, which means free-limit protection extends to
            paid email APIs automatically.
          </p>
        </CardContent>
      </Card>

      <PhaseNotice phase="Phase 7 — enrichment">
        The database columns, the attempt log and these statuses exist now. No provider is
        registered, and the application makes no network request to any host other than Google&apos;s
        API endpoints until a provider is explicitly chosen and approved.
      </PhaseNotice>
    </>
  );
}
