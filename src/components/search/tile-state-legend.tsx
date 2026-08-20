import { LEAF_TILE_STATES, TILE_STATE_META } from "@/lib/tile-states";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function TileStateLegend({ counts }: { counts?: Partial<Record<string, number>> }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-2">
      {LEAF_TILE_STATES.map((state) => {
        const meta = TILE_STATE_META[state];
        return (
          <Tooltip key={state}>
            <TooltipTrigger render={<div className="flex items-center gap-1.5 text-xs" />}>
              <span
                aria-hidden
                className="size-2.5 rounded-[3px] ring-1 ring-black/5 dark:ring-white/10"
                style={{ background: meta.fill }}
              />
              <span className="text-muted-foreground">{meta.label}</span>
              {counts ? (
                <span className="font-medium tabular-nums">{counts[state] ?? 0}</span>
              ) : null}
            </TooltipTrigger>
            <TooltipContent className="max-w-64">{meta.description}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
