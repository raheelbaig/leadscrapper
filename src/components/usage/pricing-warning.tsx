import { AlertTriangle } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { PricingStatus } from "@/lib/types/usage";
import { cn } from "@/lib/utils";

/**
 * The unverified-pricing warning.
 *
 * Shown wherever a budget decision is displayed, because every one of them is
 * made from these numbers. While the catalog is unverified the quota service
 * refuses to reserve anything at all, so this is not merely advisory -- it is
 * the reason searches cannot run.
 *
 * Renders nothing once the catalog is verified and fresh.
 */
export function PricingWarning({
  pricing,
  compact = false,
  className,
}: {
  pricing: PricingStatus;
  /** A tighter form for the dashboard card. */
  compact?: boolean;
  className?: string;
}) {
  if (!pricing.stale) return null;

  const reason = pricing.verified
    ? `The catalog was last verified ${pricing.ageDays} days ago, past the ${pricing.stalenessWarnAfterDays}-day threshold.`
    : "These free allowances and prices have never been confirmed against your Google Cloud billing account.";

  if (compact) {
    return (
      <div
        className={cn(
          "flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2.5 text-xs",
          className,
        )}
      >
        <AlertTriangle className="mt-px size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="space-y-0.5">
          <p className="font-medium text-amber-700 dark:text-amber-400">
            Pricing not verified — searches disabled
          </p>
          <p className="text-muted-foreground">
            No Google request will be made until these numbers are confirmed.
          </p>
        </div>
      </div>
    );
  }

  return (
    <Alert className={cn("border-amber-500/40 bg-amber-500/5", className)}>
      <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400" />
      <AlertTitle>Pricing information needs verification</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>
          {reason} Google searches are disabled until it is confirmed: the quota guard refuses every
          reservation while <code className="text-xs">verified</code> is false, so an unchecked free
          limit cannot authorise a billable call.
        </p>
        <p>
          Compare version <span className="font-mono">{pricing.version}</span> against{" "}
          <a
            href={pricing.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
          >
            Google&apos;s pricing page
          </a>{" "}
          and your billing account, then correct{" "}
          <code className="text-xs">src/server/pricing/catalog.json</code>. It is a config change,
          never a code change.
        </p>
      </AlertDescription>
    </Alert>
  );
}
