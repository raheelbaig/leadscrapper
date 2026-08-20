import { Construction } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Marks a surface whose UI exists but whose backend lands in a later phase.
 *
 * Used deliberately: a screen that looks functional but silently does nothing
 * is worse than one that says what it is waiting for.
 */
export function PhaseNotice({
  phase,
  children,
  className,
}: {
  phase: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-lg border border-dashed border-amber-500/40 bg-amber-500/5 px-3.5 py-3 text-xs",
        className,
      )}
    >
      <Construction className="mt-px size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="space-y-0.5">
        <p className="font-medium text-amber-700 dark:text-amber-400">{phase}</p>
        <p className="text-muted-foreground">{children}</p>
      </div>
    </div>
  );
}
