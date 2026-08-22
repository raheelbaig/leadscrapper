import { NextResponse } from "next/server";

import { getCurrentUser } from "@/server/db/server-client";
import { QuotaBlockedError } from "@/server/quota/quota-service";
import { ClaimError } from "@/server/search/claim";
import { SearchBlockedError } from "@/server/search/preflight";
import { runControlledTick } from "@/server/search/run-controlled-tick";

/**
 * POST /api/searches/[id]/run
 *
 * Runs ONE bounded tick of the real pipeline: up to `maxTilesPerTick` tiles,
 * each paginated to at most three pages, each page reserved separately and
 * retried at most `maxAttemptsPerPage` times. Four budgets bound it -- tiles
 * per tick, calls per tick, calls per SEARCH, and wall-clock -- and whichever
 * binds first stops the run with the remaining geography still owed.
 *
 * NO OPTIONS ARE ACCEPTED. Every limit is read from SEARCH_LIMITS on the
 * server, so nothing the browser sends can widen what a press may spend.
 *
 * This is the MANUAL trigger. The cron-driven worker at POST /api/jobs runs the
 * same `runControlledTick` with a shorter slice, but it stays off:
 * `private.worker_config.enabled` is false, and nothing in this application can
 * change it -- `private` is not exposed through PostgREST. Today a search runs
 * because a person pressed a button.
 *
 * A blocked pre-flight returns 409 with the banner text, having made no Google
 * request, taken no lease, and mutated no tile.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/**
 * A three-page tile costs ~2s of mandated token delay plus the requests
 * themselves, and the tick gives itself 50s before it pauses. 60s leaves the
 * runner room to write its final state rather than being cut off mid-report.
 */
export const maxDuration = 60;

export async function POST(_request: Request, context: RouteContext<"/api/searches/[id]/run">) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const { id } = await context.params;

  try {
    // Deliberately no options: the phase limits are the only limits.
    const result = await runControlledTick({ searchId: id, userId: user.id });
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    // The pricing gate and the budget gate. Both are refusals, not failures:
    // the run did not break, it was not allowed to start.
    if (error instanceof SearchBlockedError) {
      return NextResponse.json(
        {
          blocked: error.block,
          preflight: error.preflight,
          apiCallsMade: 0,
        },
        { status: error.status },
      );
    }

    // The second, closer guard inside the quota service. Reaching this means a
    // path bypassed the pre-flight, so it is worth surfacing distinctly.
    if (error instanceof QuotaBlockedError) {
      return NextResponse.json(
        {
          blocked: {
            code: error.reason,
            title: "GOOGLE SEARCH BLOCKED",
            message: "Pricing configuration has not been verified.",
            action: error.message,
          },
          apiCallsMade: 0,
        },
        { status: 409 },
      );
    }

    if (error instanceof ClaimError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }

    const message = error instanceof Error ? error.message : "Could not run the search.";
    console.error(`POST /api/searches/${id}/run failed`, error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
