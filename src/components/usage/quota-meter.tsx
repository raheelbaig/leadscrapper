import { QUOTA_STATE_META, type QuotaState } from "@/lib/quota";
import { cn } from "@/lib/utils";

/**
 * A quota bar that carries its state.
 *
 * Deliberately not the shared `Progress` component: this one is a plain server
 * -rendered element with an explicit `role="meter"`, so a screen reader is told
 * the value, the range, and what the range means -- and so the fill colour can
 * follow the safety state rather than the theme's single accent.
 *
 * The reserve is drawn as a hatched strip at the end of the track. It is the
 * part of the free allowance the application refuses to spend, and showing it
 * to scale is the clearest way to say why "remaining" is smaller than the free
 * limit minus what has been used.
 */
export function QuotaMeter({
  used,
  effectiveLimit,
  freeLimit,
  percent,
  state,
  className,
}: {
  used: number;
  effectiveLimit: number;
  freeLimit: number;
  /** Already clamped to 0-100 by the quota calculation. */
  percent: number;
  state: QuotaState;
  className?: string;
}) {
  const meta = QUOTA_STATE_META[state];
  // The reserve strip is measured against the FREE limit, so the whole track
  // represents Google's allowance and the strip is the slice withheld from it.
  const reservePercent =
    freeLimit > 0 ? Math.min(((freeLimit - effectiveLimit) / freeLimit) * 100, 100) : 0;
  const usablePercent = 100 - reservePercent;

  return (
    <div
      role="meter"
      aria-valuenow={Math.round(used)}
      aria-valuemin={0}
      aria-valuemax={effectiveLimit}
      aria-valuetext={`${Math.round(used)} of ${effectiveLimit} usable calls used — ${meta.label}`}
      className={cn("bg-muted relative h-2 w-full overflow-hidden rounded-full", className)}
    >
      {reservePercent > 0 ? (
        <div
          aria-hidden
          title="Safety reserve — never spent"
          className="border-background/60 absolute inset-y-0 right-0 border-l bg-[repeating-linear-gradient(135deg,currentColor_0,currentColor_1px,transparent_1px,transparent_4px)] text-current/25"
          style={{ width: `${reservePercent}%` }}
        />
      ) : null}

      <div
        aria-hidden
        className={cn("h-full rounded-full transition-all", meta.meterClass)}
        // Scaled into the usable portion of the track, so a full bar lands
        // exactly where the reserve strip begins.
        style={{ width: `${(Math.min(Math.max(percent, 0), 100) / 100) * usablePercent}%` }}
      />
    </div>
  );
}
