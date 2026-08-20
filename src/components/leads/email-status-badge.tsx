import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const EMAIL_STATUS_META: Record<string, { label: string; className: string }> = {
  not_enriched: {
    label: "Not enriched",
    className: "bg-muted text-muted-foreground border-border",
  },
  queued: {
    label: "Queued",
    className: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400",
  },
  found: {
    label: "Email found",
    className: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400",
  },
  verified: {
    label: "Verified",
    className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  },
  unverified: {
    label: "Unverified",
    className: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
  not_found: {
    label: "Not found",
    className: "bg-muted text-muted-foreground border-border",
  },
  failed: {
    label: "Failed",
    className: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
  },
};

export function EmailStatusBadge({ status }: { status: string }) {
  const meta = EMAIL_STATUS_META[status] ?? EMAIL_STATUS_META.not_enriched;
  return (
    <Badge variant="outline" className={cn("text-xs", meta.className)}>
      {meta.label}
    </Badge>
  );
}
