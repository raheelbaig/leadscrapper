import { NextResponse } from "next/server";

import { getCurrentUser } from "@/server/db/server-client";
import { getUsageOverview, getUsageSummary } from "@/server/quota/usage-report";

/**
 * GET /api/usage
 *
 * The sanitized usage payload for the topbar indicator and any client that
 * needs live quota figures. Reads only -- there is no PUT, PATCH or POST here,
 * because a usage number supplied by a browser is never trusted.
 *
 * `?summary=1` omits the daily chart and the per-run breakdown. The topbar
 * polls, and it has no use for a month of log rows.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  // The proxy guards navigation, not authorization. Route handlers re-check.
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const summaryOnly = new URL(request.url).searchParams.get("summary") === "1";

  try {
    const data = summaryOnly ? await getUsageSummary() : await getUsageOverview();
    return NextResponse.json(data, {
      headers: { "cache-control": "no-store, max-age=0" },
    });
  } catch (error) {
    // Never echo the underlying message: it can carry connection details.
    console.error("GET /api/usage failed", error);
    return NextResponse.json({ error: "Could not read API usage." }, { status: 500 });
  }
}
