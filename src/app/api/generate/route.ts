import { NextResponse } from "next/server";

import { createGenerationSchema } from "@/lib/schemas/generate";
import { getCurrentUser } from "@/server/db/server-client";
import { BboxResolutionError } from "@/server/geo/bbox-resolver";
import { createGenerationRun, GenerationConflictError } from "@/server/generate/orchestrator";
import { SearchLimitError } from "@/server/search/limits";

/**
 * POST /api/generate
 *
 * Starts the guided flow: creates the search, lays down its complete seed grid,
 * and records ONE approval to spend at most `call_ceiling` Google calls on it.
 *
 * MAKES NO GOOGLE REQUEST. Planning is free -- only searching bills -- so the
 * whole plan and the whole approval exist before anything is authorised. The
 * first billable call happens when the client asks this run to advance.
 *
 * The pre-flight comes back with the response so the processing screen can
 * state the estimate, the guaranteed maximum for this approval, and the
 * protected quota remaining without a second round trip.
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

  const parsed = createGenerationSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid generation request.",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      { status: 400 },
    );
  }

  try {
    const result = await createGenerationRun(parsed.data, { userId: user.id });

    return NextResponse.json(
      {
        runId: result.runId,
        searchId: result.searchId,
        preflight: result.preflight,
        grid: result.search.grid,
        areaKm2: result.search.areaKm2,
        location: result.search.location,
      },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof GenerationConflictError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof SearchLimitError) {
      return NextResponse.json(
        { error: error.message, limit: error.limit },
        { status: error.status },
      );
    }

    // The area could not be turned into a rectangle. Not a technical failure to
    // put in front of a normal user: the resolvable list is finite while
    // external geocoding stays switched off, so the answer is to name the
    // alternative rather than to print the provider chain that was tried.
    if (error instanceof BboxResolutionError) {
      return NextResponse.json(
        {
          error:
            "We do not have the boundaries for that area yet. Pick one of the listed areas, or " +
            "draw the area yourself under Advanced.",
          code: "location-unresolved",
        },
        { status: 422 },
      );
    }

    console.error("POST /api/generate failed", error);
    return NextResponse.json({ error: "Could not start the generation." }, { status: 500 });
  }
}
