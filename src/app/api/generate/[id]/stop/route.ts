import { NextResponse } from "next/server";

import { getCurrentUser } from "@/server/db/server-client";
import { stopGenerationRun } from "@/server/generate/orchestrator";
import { GenerationNotFoundError } from "@/server/generate/state";

/**
 * POST /api/generate/[id]/stop
 *
 * Ends the approval. Further advances are refused from this point.
 *
 * Stopping is not a failure and not a rollback: leads already collected, areas
 * already searched and emails already found are all kept, and the remaining
 * geography stays visibly owed. A slice already in flight finishes on its own
 * rather than being killed mid-request -- it is bounded to one short tick and
 * releases its lease on every terminal path, the same cooperative shape pause
 * and cancel already use.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(_request: Request, context: RouteContext<"/api/generate/[id]/stop">) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const { id } = await context.params;

  try {
    const state = await stopGenerationRun({ runId: id, userId: user.id });
    return NextResponse.json(state, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof GenerationNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    console.error(`POST /api/generate/${id}/stop failed`, error);
    return NextResponse.json({ error: "Could not stop the generation." }, { status: 500 });
  }
}
