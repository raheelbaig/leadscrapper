import { afterEach, describe, expect, it, vi } from "vitest";

import { isAdvanceInFlight, requestAdvance, resetAdvanceRegistry } from "./advance-client";

/**
 * Overlapping advances, and why they must be impossible.
 *
 * Generation 2d3aacec failed in production because two advances for the same
 * run overlapped by 1.2 seconds: the second lost the race for the database
 * lease and the run was recorded as unrecoverable while the first was still
 * collecting leads. The client guard that should have prevented it was a
 * `useRef` reset by React's effect cleanup, so navigating away and back --
 * which builds a NEW component with fresh refs -- defeated it entirely.
 *
 * These cases pin the replacement: one in-flight advance per run id, shared at
 * module scope, with no timing involved.
 */

afterEach(() => {
  resetAdvanceRegistry();
  vi.restoreAllMocks();
});

/** A fetch that resolves only when the test says so. */
function deferredFetch() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;

  const impl = (async () => {
    calls += 1;
    await gate;
    return {
      ok: true,
      json: async () => ({ runId: "run-1", status: "running" }),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  return { impl, release, callCount: () => calls };
}

describe("requestAdvance", () => {
  it("issues exactly one request when called concurrently for the same run", async () => {
    const { impl, release, callCount } = deferredFetch();

    const first = requestAdvance("run-1", impl);
    const second = requestAdvance("run-1", impl);
    const third = requestAdvance("run-1", impl);

    // THE PROPERTY. Three callers, one request on the wire.
    expect(callCount()).toBe(1);
    // And they are literally the same promise, not merely equivalent ones.
    expect(second).toBe(first);
    expect(third).toBe(first);

    release();
    const [a, b, c] = await Promise.all([first, second, third]);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  /**
   * THE NAVIGATION CASE.
   *
   * A remount is just a second caller that knows nothing about the first. It
   * must join the request in progress rather than start a competing one.
   */
  it("lets a remount join the advance already in flight", async () => {
    const { impl, release, callCount } = deferredFetch();

    const beforeNavigation = requestAdvance("run-1", impl);
    expect(isAdvanceInFlight("run-1")).toBe(true);

    // The component unmounts. Nothing is cancelled and nothing is forgotten --
    // the server is still working.
    // The user comes back; a brand-new component asks again.
    const afterNavigation = requestAdvance("run-1", impl);

    expect(callCount()).toBe(1);
    expect(afterNavigation).toBe(beforeNavigation);

    release();
    await afterNavigation;
  });

  it("allows the next advance once the previous one settles", async () => {
    const first = deferredFetch();
    const firstPromise = requestAdvance("run-1", first.impl);
    first.release();
    await firstPromise;

    expect(isAdvanceInFlight("run-1")).toBe(false);

    const second = deferredFetch();
    const secondPromise = requestAdvance("run-1", second.impl);
    expect(second.callCount()).toBe(1);
    second.release();
    await secondPromise;
  });

  it("does not conflate different generations", async () => {
    const a = deferredFetch();
    const b = deferredFetch();

    const one = requestAdvance("run-1", a.impl);
    const two = requestAdvance("run-2", b.impl);

    expect(one).not.toBe(two);
    expect(a.callCount()).toBe(1);
    expect(b.callCount()).toBe(1);

    a.release();
    b.release();
    await Promise.all([one, two]);
  });

  it("clears the registry after a rejected request so the run is not wedged", async () => {
    const failing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const outcome = await requestAdvance("run-1", failing);

    expect(outcome).toEqual({ ok: false, error: "network down" });
    // A transport failure must not permanently block further advances.
    expect(isAdvanceInFlight("run-1")).toBe(false);
  });

  it("reports a server error without throwing", async () => {
    const erroring = (async () =>
      ({
        ok: false,
        json: async () => ({ error: "Could not continue the generation." }),
      }) as unknown as Response) as unknown as typeof fetch;

    const outcome = await requestAdvance("run-1", erroring);
    expect(outcome).toEqual({ ok: false, error: "Could not continue the generation." });
    expect(isAdvanceInFlight("run-1")).toBe(false);
  });

  it("resolves without any timer", async () => {
    // The fix must not be a delay. If `requestAdvance` waited on a timeout,
    // fake timers would stall it; with a shared promise it settles immediately.
    vi.useFakeTimers();
    try {
      const immediate = (async () =>
        ({
          ok: true,
          json: async () => ({ runId: "run-1" }),
        }) as unknown as Response) as unknown as typeof fetch;

      const outcome = await requestAdvance("run-1", immediate);
      expect(outcome.ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
