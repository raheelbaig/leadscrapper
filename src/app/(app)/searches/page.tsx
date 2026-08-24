import { Search } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/layout/page-header";
import { SearchActionsMenu } from "@/components/search/search-actions";
import { SearchStatusBadge } from "@/components/search/search-status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate, formatNumber, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";
import { listSearches } from "@/server/db/queries/dashboard";
import { getCurrentUser, getSupabaseServerClient } from "@/server/db/server-client";

export const metadata: Metadata = { title: "Searches" };

export const dynamic = "force-dynamic";

/**
 * Search history, kept.
 *
 * Looking up what you found last week is a normal thing to want, so this stays
 * in the primary navigation. What changed is where it points: a search that
 * still has a generation attached opens THAT generation, so a run the user
 * navigated away from is never stranded behind a raw search-detail view. Rows
 * without one keep going to the technical detail page, which still has the
 * coverage map, the section table and the activity log.
 */
export default async function SearchesPage() {
  const [searches, user] = await Promise.all([listSearches(), getCurrentUser()]);

  // The newest generation per search, so each row can link to the right place.
  const supabase = await getSupabaseServerClient();
  const { data: runs } = user
    ? await supabase
        .from("generation_runs")
        .select("id, search_id, status, created_at")
        .order("created_at", { ascending: false })
    : { data: [] };

  const runBySearch = new Map<string, { id: string; status: string }>();
  for (const run of runs ?? []) {
    if (!runBySearch.has(run.search_id)) runBySearch.set(run.search_id, run);
  }

  /** Where a row should go: its generation if it has one, else the detail view. */
  const hrefFor = (searchId: string) => {
    const run = runBySearch.get(searchId);
    if (!run) return `/searches/${searchId}`;
    return run.status === "running" ? `/generate/${run.id}` : `/generate/${run.id}/results`;
  };

  return (
    <>
      <PageHeader
        title="Active searches"
        description="Everything you have generated, newest first. A search finishes when its whole area has been searched — the lead target is a minimum, not a stopping point."
        actions={
          <Link href="/generate" className={buttonVariants({ size: "lg" })}>
            Generate New Leads
          </Link>
        }
      />

      {searches.length === 0 ? (
        <EmptyState
          icon={Search}
          title="No searches yet"
          description="Generate your first set of leads and it will appear here, with the businesses it found and how much of the area it searched."
          actionLabel="Generate New Leads"
          actionHref="/generate"
        />
      ) : (
        <Card className="overflow-hidden py-0">
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Niche</TableHead>
                    <TableHead>Location</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Leads</TableHead>
                    <TableHead className="text-right">Coverage</TableHead>
                    <TableHead className="text-right">API calls</TableHead>
                    <TableHead className="text-right">Created</TableHead>
                    <TableHead className="w-10" aria-label="Actions" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {searches.map((s) => (
                    <TableRow key={s.id} className="cursor-pointer">
                      <TableCell className="font-medium">
                        <Link href={hrefFor(s.id)} className="hover:underline">
                          {s.niche}
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{s.label}</TableCell>
                      <TableCell>
                        <SearchStatusBadge status={s.status} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumber(s.leads_found)}
                        <span className="text-muted-foreground">
                          {" "}
                          / {formatNumber(s.target_leads)}
                        </span>
                      </TableCell>
                      <TableCell
                        className={cn(
                          "text-right tabular-nums",
                          s.coverage_pct < 100 && "text-amber-600 dark:text-amber-400",
                        )}
                      >
                        {formatPercent(s.coverage_pct, 1)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumber(s.api_calls_run)}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-right">
                        {formatDate(s.created_at)}
                      </TableCell>
                      <TableCell className="text-right">
                        <SearchActionsMenu
                          searchId={s.id}
                          status={s.status}
                          leadCount={s.leads_found}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </>
  );
}
