import { NextResponse } from "next/server";

import { continueGenerationSchema } from "@/lib/schemas/generate";
import { getCurrentUser } from "@/server/db/server-client";
import { continueGenerationRun, GenerationConflictError } from "@/server/generate/orchestrator";
import { GenerationNotFoundError } from "@/server/generate/state";

/**
 * POST /api/generate/continue
 *
 * A NEW approval over a search that already exists -- what "Continue
 * Generation" and "Continue Searching" press.
 *
 * Deliberately a new generation run rather than a raised ceiling on the old
 * one. The previous approval was for a stated number of Google calls and it was
 * honoured; carrying on is a fresh decision, taken with a fresh watermark, so
 * the next run's ceiling is counted from where the last one stopped rather than
 * inheriting its spending.
 *
 * MAKES NO GOOGLE REQUEST. It records permission; advancing is what spends.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const parsed = continueGenerationSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Expected { searchId: uuid, enrichEmails?: boolean }." },
      { status: 400 },
    );
  }

  try {
    const result = await continueGenerationRun({
      searchId: parsed.data.searchId,
      userId: user.id,
      enrichEmails: parsed.data.enrichEmails,
    });

    return NextResponse.json(
      { runId: result.runId, preflight: result.preflight },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof GenerationConflictError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof GenerationNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    console.error("POST /api/generate/continue failed", error);
    return NextResponse.json({ error: "Could not continue the generation." }, { status: 500 });
  }
}
