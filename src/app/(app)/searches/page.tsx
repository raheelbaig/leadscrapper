import { Search } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/layout/page-header";
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

export const metadata: Metadata = { title: "Searches" };

export default async function SearchesPage() {
  const searches = await listSearches();

  return (
    <>
      <PageHeader
        title="Searches"
        description="Every search is a durable job. Pausing, closing the browser, or a server restart does not lose progress."
        actions={
          <Link href="/find-leads" className={buttonVariants({ size: "lg" })}>
            Find New Leads
          </Link>
        }
      />

      {searches.length === 0 ? (
        <EmptyState
          icon={Search}
          title="No searches yet"
          description="Your first search will tile the city, work through the tiles on the server, and report exactly how much of the area it managed to cover."
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
                    <TableHead>Niche</TableHead>
                    <TableHead>Location</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Leads</TableHead>
                    <TableHead className="text-right">Coverage</TableHead>
                    <TableHead className="text-right">API calls</TableHead>
                    <TableHead className="text-right">Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {searches.map((s) => (
                    <TableRow key={s.id} className="cursor-pointer">
                      <TableCell className="font-medium">
                        <Link href={`/searches/${s.id}`} className="hover:underline">
                          {s.niche}
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{s.label}</TableCell>
                      <TableCell>
                        <SearchStatusBadge status={s.status} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumber(s.leads_found)}
                        <span className="text-muted-foreground"> / {formatNumber(s.target_leads)}</span>
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
