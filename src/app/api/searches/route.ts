import { NextResponse } from "next/server";

import { createSearchSchema } from "@/lib/schemas/search";
import { getCurrentUser } from "@/server/db/server-client";
import { createSearch } from "@/server/search/create-search";
import { Phase3aLimitError } from "@/server/search/limits";
import { runPreflight } from "@/server/search/preflight";

/**
 * POST /api/searches
 *
 * Creates a search and its seed tile. Makes NO Google request: planning is free
 * and only searching bills, so the whole plan exists before a single call is
 * authorised. Running it is a separate, explicit action.
 *
 * The pre-flight result is returned alongside so the UI can show the estimate,
 * the worst case, and any block before the user reaches for the Run button.
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

  const parsed = createSearchSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid search request.",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      { status: 400 },
    );
  }

  try {
    const created = await createSearch(parsed.data, { userId: user.id });
    const preflight = await runPreflight();

    return NextResponse.json(
      { search: created, preflight },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof Phase3aLimitError) {
      return NextResponse.json(
        { error: error.message, limit: error.limit },
        { status: error.status },
      );
    }

    console.error("POST /api/searches failed", error);
    return NextResponse.json({ error: "Could not create the search." }, { status: 500 });
  }
}
