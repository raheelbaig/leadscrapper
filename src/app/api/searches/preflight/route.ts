import { NextResponse } from "next/server";

import { getCurrentUser } from "@/server/db/server-client";
import { runPreflight } from "@/server/search/preflight";

/**
 * GET /api/searches/preflight
 *
 * The pre-flight estimate and the gate status, with no side effects at all.
 * Lets the UI show what a run WOULD cost, and whether it is currently blocked,
 * before anyone commits to it.
 *
 * Reads the counter in Postgres. It does not ask Google how much Google quota
 * is left -- that would itself be a billable request.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  try {
    const preflight = await runPreflight();
    return NextResponse.json(preflight, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("GET /api/searches/preflight failed", error);
    return NextResponse.json({ error: "Could not compute the pre-flight." }, { status: 500 });
  }
}
