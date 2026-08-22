"use client";

import { useEffect, useState } from "react";

import { elapsedSeconds, formatElapsed } from "@/lib/generate/eta";

/**
 * The live elapsed clock.
 *
 * ANCHORED TO A PERSISTED TIMESTAMP, never to a moment the browser remembers.
 * The component is handed `startedAt` from Postgres and re-derives the elapsed
 * figure from it once a second, so a refresh, a reopened tab or a different
 * device all show the same number -- there is nothing to reset because there is
 * nothing accumulating in the client.
 *
 * When `endedAt` is set the clock freezes at the real duration rather than
 * continuing to run, which is what makes "Completed in 4 min 12 sec" on the
 * results page the same figure the processing screen was showing a moment
 * earlier.
 *
 * It counts UP. Nothing here counts down: see `estimateRemaining`, which is a
 * function of remaining work rather than of time passing.
 */
export function ElapsedTimer({
  startedAt,
  endedAt,
  className,
}: {
  startedAt: string | null;
  endedAt?: string | null;
  className?: string;
}) {
  // The CLOCK is the state, not the elapsed figure. Keeping it this way means
  // the displayed value is derived during render from the current props, so a
  // phase boundary arriving from the server is reflected immediately without an
  // effect writing state back into the component.
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    // A finished phase has a real duration; there is nothing left to tick.
    if (!startedAt || endedAt) return;

    const id = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [startedAt, endedAt]);

  const seconds = elapsedSeconds(startedAt, endedAt, nowMs);

  return (
    <span className={className} suppressHydrationWarning>
      {formatElapsed(seconds)}
    </span>
  );
}
