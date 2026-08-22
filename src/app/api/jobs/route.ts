import { NextResponse } from "next/server";

import { authenticateWorkerRequest } from "@/server/worker/authenticate";
import { runWorkerTick } from "@/server/worker/worker-tick";

/**
 * POST /api/jobs — the durable worker endpoint.
 *
 * pg_cron calls this through pg_net every 30 seconds, presenting the shared
 * secret in `x-worker-secret`. There is no session: the cron job is not a user.
 *
 * ---------------------------------------------------------------------------
 * THE WORKER IS CURRENTLY OFF, and this route existing does not change that.
 *
 * `private.dispatch_worker_tick()` returns without making any HTTP call unless
 * `private.worker_config.enabled` is true AND `worker_url` is set. Both are
 * unset. Nothing in this application writes that table -- it lives in the
 * `private` schema, which PostgREST does not expose, so there is no application
 * path to the switch at all. Turning it on is a deliberate SQL statement run by
 * the owner; see docs/worker-activation.md.
 *
 * Independently of that, this handler refuses every request while
 * `WORKER_SECRET` is unset, and an unconfigured deployment answers 503 rather
 * than treating "no secret" as "no authentication required".
 * ---------------------------------------------------------------------------
 *
 * One request runs at most ONE slice of ONE search, bounded by
 * `WORKER_SLICE_MS`. It cannot widen any limit: every option it passes is
 * clamped by SEARCH_LIMITS inside the runner, so the worker's ceiling is the
 * same ceiling the Run button has.
 *
 * There is no self-chain. `WORKER_SELF_CHAIN` defaults to false and nothing
 * here reads it: a chain is a latency optimisation, and correctness must never
 * depend on one. The next cron tick continues the work.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/** WORKER_SLICE_MS is 25s by default; 60 leaves room to write the final state. */
export const maxDuration = 60;

export async function POST(request: Request) {
  const auth = authenticateWorkerRequest(request, process.env.WORKER_SECRET);

  if (!auth.ok) {
    // Deliberately terse. A worker endpoint should not help anyone work out
    // whether they were close.
    return NextResponse.json({ error: auth.reason }, { status: auth.status });
  }

  try {
    const result = await runWorkerTick();

    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    // Never echo the underlying message to an unauthenticated-by-session
    // caller; it can carry connection details.
    console.error("POST /api/jobs failed", error);
    return NextResponse.json({ error: "The worker tick failed." }, { status: 500 });
  }
}

/**
 * A liveness probe that reveals nothing and does no work.
 *
 * Useful when wiring the cron job up for the first time: it confirms the URL
 * and the secret without running a tick or spending anything.
 */
export async function GET(request: Request) {
  const auth = authenticateWorkerRequest(request, process.env.WORKER_SECRET);

  if (!auth.ok) {
    return NextResponse.json({ error: auth.reason }, { status: auth.status });
  }

  return NextResponse.json(
    { ok: true, note: "Worker endpoint reachable. POST to run one slice." },
    { headers: { "cache-control": "no-store" } },
  );
}
