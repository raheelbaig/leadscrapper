import { NextResponse } from "next/server";

import { getCurrentUser } from "@/server/db/server-client";
import { ExportError, getExportDownloadUrl } from "@/server/export/export-service";

/**
 * GET /api/exports/[id]/download
 *
 * Redirects to a short-lived signed URL for a stored workbook.
 *
 * The `exports` bucket is PRIVATE. The link is minted here, server-side, after
 * the session is re-checked and the row's `user_id` is matched — the browser
 * never learns a durable path, and the URL it does get expires in two minutes.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request: Request, context: RouteContext<"/api/exports/[id]/download">) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const { id } = await context.params;

  try {
    const { url } = await getExportDownloadUrl({ exportId: id, userId: user.id });

    // 307 rather than 302: the signed URL is single-purpose and must not be
    // cached by anything between here and the browser.
    return NextResponse.redirect(url, {
      status: 307,
      headers: { "cache-control": "no-store, max-age=0" },
    });
  } catch (error) {
    if (error instanceof ExportError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    console.error(`GET /api/exports/${id}/download failed`, error);
    return NextResponse.json({ error: "Could not prepare the download." }, { status: 500 });
  }
}
