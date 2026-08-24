import type { GenerationState } from "./types";

/**
 * One advance in flight per generation, across every component that asks.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS MODULE-SCOPED AND NOT A REF.
 *
 * The processing screen used a `useRef` guard, and its effect cleanup reset the
 * ref to false. React runs cleanup BEFORE re-running an effect, so any change
 * to the state it depends on -- a Realtime heartbeat, a re-render, and above
 * all navigating away and back -- cleared the guard while a request was still
 * executing on the server. A second advance then went out for the same run.
 *
 * That is what broke generation 2d3aacec on 2026-08-23. Two advances overlapped
 * by 1.2 seconds, the second lost the race for the lease, and the run was
 * recorded as failed while the first was still working -- it went on to collect
 * 357 leads that the UI had already declared unreachable.
 *
 * A ref cannot fix it, because navigating away and back builds a NEW component
 * instance with fresh refs while the old request is still running on the
 * server. The in-flight set therefore lives at MODULE scope, keyed by run id,
 * so every mount of every component sees the same truth.
 *
 * NO DELAYS ARE INVOLVED. A second caller does not wait a fixed interval and
 * hope: it is handed the promise that is already running and settles when that
 * one does. Correctness comes from sharing the request, not from timing.
 *
 * The database lease remains the real mutual-exclusion primitive. This only
 * stops the client from making a race it does not need to make.
 * ---------------------------------------------------------------------------
 */
const inFlight = new Map<string, Promise<AdvanceOutcome>>();

export type AdvanceOutcome = { ok: true; state: GenerationState } | { ok: false; error: string };

/**
 * Asks the server to continue a generation.
 *
 * Concurrent callers for the same `runId` share one request rather than
 * issuing competing ones. The promise is removed from the registry as soon as
 * it settles, so the next advance starts cleanly.
 */
export function requestAdvance(
  runId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AdvanceOutcome> {
  const existing = inFlight.get(runId);
  if (existing) return existing;

  const request = (async (): Promise<AdvanceOutcome> => {
    try {
      const response = await fetchImpl(`/api/generate/${runId}/advance`, { method: "POST" });
      const payload = await response.json();

      if (!response.ok) {
        return {
          ok: false,
          error: (payload as { error?: string }).error ?? "We could not continue this generation.",
        };
      }

      return { ok: true, state: payload as GenerationState };
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
  })();

  inFlight.set(runId, request);

  // Cleared on settle, not in a React cleanup -- an unmount must never make the
  // browser forget that a request is still running on the server.
  void request.finally(() => {
    if (inFlight.get(runId) === request) inFlight.delete(runId);
  });

  return request;
}

/** Whether an advance for this run is already on the wire. */
export function isAdvanceInFlight(runId: string): boolean {
  return inFlight.has(runId);
}

/** Test-only reset, so one case cannot leak an in-flight entry into the next. */
export function resetAdvanceRegistry(): void {
  inFlight.clear();
}
