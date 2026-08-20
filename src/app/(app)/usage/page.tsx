import { CalendarRange, Gauge, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/layout/page-header";
import { PricingWarning } from "@/components/usage/pricing-warning";
import { SkuQuotaCard } from "@/components/usage/sku-quota-card";
import { UsageHistoryChart } from "@/components/usage/usage-history-chart";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatNumber } from "@/lib/format";
import { getUsageOverview } from "@/server/quota/usage-report";

export const metadata: Metadata = { title: "API Usage" };

/** Reads cookies through the request client, so it is dynamic already. */
export const dynamic = "force-dynamic";

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="space-y-1">
      <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
    </div>
  );
}

export default async function UsagePage() {
  const usage = await getUsageOverview();
  const skuLabels = Object.fromEntries(usage.skus.map((sku) => [sku.sku, sku.label]));

  return (
    <>
      <PageHeader
        title="Google API usage"
        description="This application never makes a paid Google request. There is no paid mode, no override flag, and no automatic overage."
        actions={
          <Badge
            variant="outline"
            className="gap-1.5 border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
          >
            <ShieldCheck className="size-3" />
            FREE ONLY
          </Badge>
        }
      />

      <PricingWarning pricing={usage.pricing} />

      <Card>
        <CardContent className="grid gap-6 p-6 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Billing period"
            value={usage.period.label}
            hint={`Resets at midnight ${usage.period.timeZone}`}
          />
          <Stat
            label="Mode"
            value={<span className="text-emerald-600 dark:text-emerald-400">FREE ONLY</span>}
            hint="Enforced in Postgres, not by a setting"
          />
          <Stat
            label="Calls this period"
            value={formatNumber(usage.totalCallsThisPeriod)}
            hint="Every SKU combined"
          />
          <Stat
            label="Catalog version"
            value={usage.pricing.version}
            hint={
              usage.pricing.verified
                ? `Verified ${usage.pricing.lastVerified}`
                : "Not yet verified against billing"
            }
          />
        </CardContent>
      </Card>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Gauge className="text-muted-foreground size-4" />
          <h2 className="text-sm font-semibold">Free allowance by SKU</h2>
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {usage.skus.map((sku) => (
            <SkuQuotaCard key={sku.sku} sku={sku} />
          ))}
        </div>
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CalendarRange className="text-muted-foreground size-4" />
            Daily calls
          </CardTitle>
          <CardDescription>
            {usage.period.label} · days are bucketed in {usage.period.timeZone}, the same timezone
            the monthly allowance resets in — never the browser&apos;s.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <UsageHistoryChart
            history={usage.history}
            skuLabels={skuLabels}
            periodLabel={usage.period.label}
            timeZone={usage.period.timeZone}
          />
        </CardContent>
      </Card>

      {usage.runs.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Usage by search</CardTitle>
            <CardDescription>
              Billable calls this period, attributed to the run that made them.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Search</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Calls</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {usage.runs.map((run) => (
                    <TableRow key={run.searchId}>
                      <TableCell>
                        <Link href={`/searches/${run.searchId}`} className="hover:underline">
                          <div className="font-medium">{run.niche}</div>
                          <div className="text-muted-foreground text-xs">{run.label}</div>
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">{run.status}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumber(run.calls)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Why there is a reserve</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground space-y-2 text-sm">
            <p>
              The counter in this application is a local estimate. It can drift from Google&apos;s
              own count — a retried request, a response that arrived after a timeout, a call made
              from somewhere else with the same key.
            </p>
            <p>
              So the usable allowance is{" "}
              <code className="text-xs">free limit − used − max(50, 5%)</code>. The reserve is the
              margin that keeps a drifting estimate from turning into a real charge.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Why every page is a call</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground space-y-2 text-sm">
            <p>
              A Text Search response holds at most 20 results and can be paged three times, so one
              tile costs up to <strong>three</strong> billable calls, not one. Every estimate in
              this app counts pages.
            </p>
            <p>
              The field mask decides the billing tier, and a single Enterprise field bills the whole
              request at Enterprise. Phone and website are Enterprise and both are required, so
              every lead search is an Enterprise call.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Why the month resets in Pacific time</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground space-y-2 text-sm">
            <p>
              Google&apos;s free allowance resets at midnight {usage.period.timeZone}. A UTC
              rollover would zero this counter up to eight hours early, and in that window the
              application would believe it had free quota while Google was still billing the
              previous month.
            </p>
            <p>
              Counting mode is <code className="text-xs">{usage.pricing.countMode}</code>: a request
              that never produced a billable response is refunded rather than counted.
            </p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
