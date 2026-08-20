import { AlertTriangle, Ban, FileQuestion, ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { QUOTA_STATE_META, type QuotaState } from "@/lib/quota";
import { cn } from "@/lib/utils";

/**
 * The four reusable quota safety states, in one badge.
 *
 * Shared by `/usage`, the dashboard, and the future search preflight, so
 * "getting low" always looks the same wherever it is reported. State is never
 * carried by colour alone -- each variant has its own icon and its own words.
 */
const STATE_ICONS: Record<QuotaState, React.ComponentType<{ className?: string }>> = {
  healthy: ShieldCheck,
  warning: AlertTriangle,
  exhausted: Ban,
  unverified: FileQuestion,
};

export function QuotaStateBadge({
  state,
  label,
  className,
}: {
  state: QuotaState;
  /** Overrides the default wording, e.g. a shorter form in a dense row. */
  label?: string;
  className?: string;
}) {
  const meta = QUOTA_STATE_META[state];
  const Icon = STATE_ICONS[state];

  return (
    <Badge variant="outline" className={cn("gap-1.5", meta.badgeClass, className)}>
      <Icon className="size-3" />
      {label ?? meta.label}
    </Badge>
  );
}
