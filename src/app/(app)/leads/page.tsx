import { Users } from "lucide-react";
import type { Metadata } from "next";

import { EmptyState } from "@/components/common/empty-state";
import { PhaseNotice } from "@/components/common/phase-notice";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmailStatusBadge } from "@/components/leads/email-status-badge";
import { getSupabaseServerClient } from "@/server/db/server-client";

export const metadata: Metadata = { title: "Leads" };

type LeadRow = {
  id: string;
  name: string;
  phone_national: string | null;
  address: string | null;
  website: string | null;
  city: string | null;
  state: string | null;
  email: string | null;
  email_status: string;
};

export default async function LeadsPage() {
  const supabase = await getSupabaseServerClient();
  const { data } = await supabase
    .from("leads")
    .select("id, name, phone_national, address, website, city, state, email, email_status")
    .order("created_at", { ascending: false })
    .limit(200);

  const leads = (data ?? []) as unknown as LeadRow[];

  return (
    <>
      <PageHeader
        title="Leads"
        description="Every business found across all searches. Duplicates are impossible within a search — the place ID is a unique constraint in the database."
      />

      {leads.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No leads yet"
          description="Run a search and businesses will land here as each tile is covered."
          actionLabel="Find New Leads"
          actionHref="/find-leads"
        />
      ) : (
        <Card className="overflow-hidden py-0">
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Business</TableHead>
                    <TableHead>Phone</TableHead>
                    <TableHead>Location</TableHead>
                    <TableHead>Website</TableHead>
                    <TableHead>Email</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {leads.map((lead) => (
                    <TableRow key={lead.id}>
                      <TableCell className="font-medium">{lead.name}</TableCell>
                      <TableCell className="tabular-nums">{lead.phone_national ?? "—"}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {[lead.city, lead.state].filter(Boolean).join(", ") || "—"}
                      </TableCell>
                      <TableCell className="max-w-56 truncate">
                        {lead.website ? (
                          <a
                            href={lead.website}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="text-primary hover:underline"
                          >
                            {lead.website.replace(/^https?:\/\//, "")}
                          </a>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell>
                        {lead.email ?? <EmailStatusBadge status={lead.email_status} />}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      <PhaseNotice phase="Phase 5 — lead management">
        Filtering, sorting, server-side pagination, the detail sheet and bulk export selection land
        here once searches are producing data.
      </PhaseNotice>
    </>
  );
}
