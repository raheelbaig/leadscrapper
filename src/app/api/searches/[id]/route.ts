import { NextResponse } from "next/server";

import { searchActionSchema } from "@/lib/schemas/search";
import { getCurrentUser } from "@/server/db/server-client";
import { applySearchAction, deleteSearch, SearchActionError } from "@/server/search/manage-search";

/**
 * PATCH  /api/searches/[id]   pause | resume | cancel
 * DELETE /api/searches/[id]   permanently remove the search and its leads
 *
 * Neither verb makes a Google request, takes a worker lease, or touches a tile.
 * They move the search row between states; the tick reads the status between
 * tiles and stops itself, which is why pausing never leaves work in flight.
 *
 * The proxy guards navigation, not authorization, so the session is re-checked
 * here and ownership is re-checked again inside the service module.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PATCH(request: Request, context: RouteContext<"/api/searches/[id]">) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const { id } = await context.params;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const parsed = searchActionSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json({ error: "Expected one of: pause, resume, cancel." }, { status: 400 });
  }

  try {
    const result = await applySearchAction({
      searchId: id,
      userId: user.id,
      action: parsed.data.action,
    });

    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof SearchActionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    console.error(`PATCH /api/searches/${id} failed`, error);
    return NextResponse.json({ error: "Could not update the search." }, { status: 500 });
  }
}

export async function DELETE(_request: Request, context: RouteContext<"/api/searches/[id]">) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const { id } = await context.params;

  try {
    const result = await deleteSearch({ searchId: id, userId: user.id });

    // The month's usage record is deliberately unaffected: api_call_log and the
    // usage counters keep a null search_id rather than cascading, so deleting a
    // search can never make the billing picture look better than it is.
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof SearchActionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    console.error(`DELETE /api/searches/${id} failed`, error);
    return NextResponse.json({ error: "Could not delete the search." }, { status: 500 });
  }
}
