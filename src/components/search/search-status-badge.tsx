import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Plain-English statuses.
 *
 * `queued` reads as "Starting" and `running` as "Searching" because those are
 * what the user is waiting for; `failed` reads as "Needs attention" because a
 * failed section returns to pending and retries, so the run is recoverable
 * rather than lost. The underlying enum is unchanged -- this is presentation.
 */
const STATUS_META: Record<string, { label: string; className: string }> = {
  draft: { label: "Draft", className: "bg-muted text-muted-foreground border-border" },
  queued: {
    label: "Starting",
    className: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400",
  },
  running: {
    label: "Searching",
    className: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400",
  },
  paused: {
    label: "Paused",
    className: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
  completed: {
    label: "Complete",
    className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  },
  failed: {
    label: "Needs attention",
    className: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
  },
  canceled: {
    label: "Canceled",
    className: "bg-muted text-muted-foreground border-border",
  },
};

export function SearchStatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? STATUS_META.draft;

  return (
    <Badge variant="outline" className={cn("gap-1.5", meta.className)}>
      {status === "running" ? (
        <span className="relative flex size-1.5">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-75" />
          <span className="relative inline-flex size-1.5 rounded-full bg-current" />
        </span>
      ) : null}
      {meta.label}
    </Badge>
  );
}
