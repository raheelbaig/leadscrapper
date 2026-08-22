import { NextResponse } from "next/server";

import { getCurrentUser } from "@/server/db/server-client";
import { advanceGenerationRun } from "@/server/generate/orchestrator";
import { GenerationNotFoundError } from "@/server/generate/state";

/**
 * POST /api/generate/[id]/advance
 *
 * Performs ONE unit of work for a generation run and returns the whole state.
 *
 * NO OPTIONS ARE ACCEPTED, and the body is not read at all. The client says
 * only "please continue"; the server decides which phase it is in, how many
 * areas this slice may search, how many leads it may check, and whether the
 * approval has anything left to spend. That is what makes the per-generation
 * ceiling a server-side guarantee -- there is no field the browser could set to
 * widen it, because there is no field.
 *
 * THE BROWSER IS NOT THE WORKER. It asks; this runs. If the tab closes the
 * asking stops, the run stays exactly where Postgres says it is, and the UI
 * presents it as resumable rather than pretending it continues on its own. The
 * durable worker remains OFF and unchanged: when it is switched on later, it
 * calls this same orchestration instead of a second copy of it.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/**
 * Bounded by whichever phase runs. A search slice gives itself 50s and the
 * route allows 60. An email slice is five leads that could each burn the
 * provider's full ~54s worst case, so 300 covers it with room to write the
 * final state rather than being cut off mid-report.
 */
export const maxDuration = 300;

export async function POST(_request: Request, context: RouteContext<"/api/generate/[id]/advance">) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const { id } = await context.params;

  try {
    // The live fetch is handed over explicitly, and only here. `runEnrichment`
    // refuses a live run without one, so no path through this route can reach a
    // website by default.
    const state = await advanceGenerationRun(
      { runId: id, userId: user.id },
      { enrichmentFetch: globalThis.fetch },
    );

    return NextResponse.json(state, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof GenerationNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    console.error(`POST /api/generate/${id}/advance failed`, error);
    return NextResponse.json({ error: "Could not continue the generation." }, { status: 500 });
  }
}
