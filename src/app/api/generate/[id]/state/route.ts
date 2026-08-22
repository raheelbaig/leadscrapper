import { NextResponse } from "next/server";

import { getCurrentUser } from "@/server/db/server-client";
import { GenerationNotFoundError, loadGenerationState } from "@/server/generate/state";

/**
 * GET /api/generate/[id]/state
 *
 * The whole progress payload for one generation run, derived from Postgres on
 * every request. Read-only and free: it makes no Google request, reaches no
 * website, reserves nothing and writes nothing.
 *
 * This is what makes the timer honest. Elapsed time and the ETA are rebuilt
 * from persisted timestamps and completed units of work, so a refresh, a
 * reopened tab, or a different device all show the same run at the same point.
 * Nothing about the display lives in the browser.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request: Request, context: RouteContext<"/api/generate/[id]/state">) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const { id } = await context.params;

  try {
    const state = await loadGenerationState({ runId: id, userId: user.id });
    return NextResponse.json(state, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof GenerationNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    console.error(`GET /api/generate/${id}/state failed`, error);
    return NextResponse.json({ error: "Could not read the generation state." }, { status: 500 });
  }
}
