import { NextResponse } from "next/server";

import { getCurrentUser } from "@/server/db/server-client";
import { ExportError, getExportFile } from "@/server/export/export-service";

/**
 * GET /api/exports/[id]/download
 *
 * Streams the stored workbook back to the browser as a real file response.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS NO LONGER REDIRECTS.
 *
 * It used to answer 307 to a short-lived signed Storage URL and let the browser
 * follow it. The storage side of that was provably fine -- the signed URL
 * returns 200, the correct spreadsheet MIME type, `Content-Disposition:
 * attachment` and 82,061 valid bytes -- but the hand-off did not reliably
 * produce a download for the user, and a redirect gives the page no way to know
 * whether anything arrived. That second point matters as much as the first:
 * the results page was showing a success message for a file that had never been
 * fetched.
 *
 * Serving it from here fixes both. The response is same-origin, so no CORS
 * policy on the storage host can affect it; the headers are the ones written
 * below rather than whatever the object store decides; and the caller gets an
 * ordinary HTTP status it can check before claiming success.
 *
 * The bytes come from the Storage SDK, NOT from a `fetch` of a signed URL. The
 * safety envelope keeps an explicit allow-list of the files allowed to call
 * `fetch`, because an unrestricted server-side fetcher in a process holding a
 * service-role key is a credential-exfiltration primitive. Reading our own
 * object store is not a reason to widen that rule.
 *
 * The bucket stays PRIVATE and no storage URL ever reaches the browser at all,
 * which is strictly less exposure than the redirect it replaces.
 * ---------------------------------------------------------------------------
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The only MIME type a .xlsx may be served as. */
export const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * A filename the browser will accept, derived from the export's own label.
 *
 * Quoted ASCII for old clients plus RFC 5987 `filename*` for everything else,
 * because the label routinely contains an em dash and commas.
 */
export function contentDispositionFor(label: string): string {
  const base =
    label
      .replace(/[^\w\-. ]+/g, "_")
      .replace(/\s+/g, " ")
      .trim() || "leads";
  const filename = `${base}.xlsx`;
  return `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function GET(_request: Request, context: RouteContext<"/api/exports/[id]/download">) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const { id } = await context.params;

  try {
    // Ownership is re-checked here, against the row, before anything is read.
    const { bytes, label } = await getExportFile({ exportId: id, userId: user.id });

    return new Response(bytes, {
      status: 200,
      headers: {
        "content-type": XLSX_CONTENT_TYPE,
        "content-disposition": contentDispositionFor(label),
        "content-length": String(bytes.byteLength),
        // The file is private to one account and must not be cached anywhere
        // between here and the browser.
        "cache-control": "no-store, max-age=0",
      },
    });
  } catch (error) {
    if (error instanceof ExportError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    console.error(`GET /api/exports/${id}/download failed`, error);
    return NextResponse.json({ error: "Could not prepare the download." }, { status: 500 });
  }
}
