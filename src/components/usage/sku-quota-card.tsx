import { Star } from "lucide-react";

import { QuotaMeter } from "@/components/usage/quota-meter";
import { QuotaStateBadge } from "@/components/usage/quota-state-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatNumber } from "@/lib/format";
import { QUOTA_STATE_META } from "@/lib/quota";
import type { SkuUsage } from "@/lib/types/usage";
import { cn } from "@/lib/utils";

function Figure({
  label,
  value,
  hint,
  className,
}: {
  label: string;
  value: string;
  hint?: string;
  className?: string;
}) {
  return (
    <div className="space-y-0.5">
      <dt className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
        {label}
      </dt>
      <dd className={cn("text-sm font-semibold tabular-nums", className)}>{value}</dd>
      {hint ? <p className="text-muted-foreground text-[11px]">{hint}</p> : null}
    </div>
  );
}

/**
 * One SKU's position for the current billing month.
 *
 * Every number is read from the database and the pricing catalog; none of them
 * is written into this component. `Remaining` is the PROTECTED figure -- what
 * may actually be spent -- which is smaller than free-limit-minus-used by
 * exactly the reserve, and that is the whole point of showing the reserve on
 * the same card.
 */
export function SkuQuotaCard({ sku }: { sku: SkuUsage }) {
  const meta = QUOTA_STATE_META[sku.state];
  const drifted = sku.protectedRemaining < 0;

  return (
    <Card className={cn("gap-4", sku.isPrimary && "ring-primary/15 ring-1")}>
      <CardHeader className="gap-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 space-y-1">
            <CardTitle className="flex items-center gap-1.5 truncate text-sm">
              {sku.label}
              {sku.isPrimary ? (
                <Tooltip>
                  <TooltipTrigger render={<span aria-label="Primary search SKU" />}>
                    <Star className="text-primary size-3.5 fill-current" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-64">
                    Every lead search bills against this SKU. Phone and website are Enterprise
                    fields and both are required, and one Enterprise field bills the whole request
                    at Enterprise.
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </CardTitle>
            <p className="text-muted-foreground truncate font-mono text-[11px]">{sku.sku}</p>
          </div>
          <QuotaStateBadge state={sku.state} />
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <QuotaMeter
            used={sku.used}
            effectiveLimit={sku.effectiveLimit}
            freeLimit={sku.freeLimit}
            percent={sku.percentUsedClamped}
            state={sku.state}
          />
          <div className="flex items-baseline justify-between text-xs">
            <span className={cn("font-semibold tabular-nums", meta.textClass)}>
              {sku.percentUsed.toFixed(1)}% used
            </span>
            <span className="text-muted-foreground tabular-nums">
              {formatNumber(sku.used)} / {formatNumber(sku.effectiveLimit)}
            </span>
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
          <Figure label="Free limit" value={formatNumber(sku.freeLimit)} hint="Google, per month" />
          <Figure label="Used" value={formatNumber(sku.used)} hint="This billing month" />
          <Figure
            label="Remaining"
            value={formatNumber(sku.remaining)}
            hint={
              drifted ? `${formatNumber(-sku.protectedRemaining)} past the ceiling` : "Protected"
            }
            className={drifted ? meta.textClass : undefined}
          />
          <Figure
            label="Reserved"
            value={formatNumber(sku.reserve)}
            hint="Never spent"
            className="text-muted-foreground"
          />
        </dl>

        <p className="text-muted-foreground border-t pt-3 text-[11px]">
          {sku.pricePer1000 > 0
            ? `Past the free allowance Google charges $${sku.pricePer1000.toFixed(2)} per 1,000 — which is why this application stops instead.`
            : "No charge past the free allowance, but the allowance is still finite."}
        </p>
      </CardContent>
    </Card>
  );
}
