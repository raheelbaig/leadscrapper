import { NextResponse } from "next/server";

import { getCurrentUser } from "@/server/db/server-client";
import { amendStopPolicy, SearchActionError } from "@/server/search/manage-search";

/**
 * POST /api/searches/[id]/stop-policy
 *
 * "Continue to full coverage" for a search created before 2026-08-22, when the
 * lead target still ended a run.
 *
 * Changes exactly one boolean in the frozen `grid_config`
 * (`stopOnTargetReached` -> false), preserves the geometry and every collected
 * lead, and appends a `stop_policy_amended` event. Nothing else in the
 * application calls it: an old search keeps the policy it was created under
 * until a person presses this.
 *
 * Makes no Google request and reserves no quota.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  _request: Request,
  context: RouteContext<"/api/searches/[id]/stop-policy">,
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const { id } = await context.params;

  try {
    const result = await amendStopPolicy({ searchId: id, userId: user.id });
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof SearchActionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    console.error(`POST /api/searches/${id}/stop-policy failed`, error);
    return NextResponse.json({ error: "Could not amend the stop policy." }, { status: 500 });
  }
}
