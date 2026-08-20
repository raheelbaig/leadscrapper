import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function StatCard({
  label,
  value,
  sublabel,
  icon: Icon,
  tone = "default",
  className,
}: {
  label: string;
  value: React.ReactNode;
  sublabel?: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  tone?: "default" | "positive" | "warning" | "danger";
  className?: string;
}) {
  const toneClass = {
    default: "text-foreground",
    positive: "text-emerald-600 dark:text-emerald-400",
    warning: "text-amber-600 dark:text-amber-400",
    danger: "text-red-600 dark:text-red-400",
  }[tone];

  return (
    <Card className={cn("gap-0", className)}>
      <CardContent className="flex items-start justify-between gap-3 p-4">
        <div className="min-w-0 space-y-1">
          <p className="text-muted-foreground truncate text-xs font-medium tracking-wide uppercase">
            {label}
          </p>
          <p className={cn("text-2xl font-semibold tabular-nums", toneClass)}>{value}</p>
          {sublabel ? (
            <p className="text-muted-foreground truncate text-xs">{sublabel}</p>
          ) : null}
        </div>
        {Icon ? (
          <div className="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-md">
            <Icon className="size-4" />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
