import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/server/db/server-client";
import { createSearchExport, ExportError } from "@/server/export/export-service";

/**
 * POST /api/exports
 *
 * Generates an .xlsx workbook for one search and stores it in the private
 * `exports` bucket. Reads rows that were already paid for — it makes NO Google
 * request, reserves no quota and cannot spend anything.
 *
 * The response reports `partialCoverage` explicitly. A workbook for a search
 * that covered 83% of its area is a legitimate thing to want, and the Coverage
 * worksheet says so in the file itself; the flag lets the UI say so at the
 * moment of export too.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/** A large search pages through thousands of rows and then writes a workbook. */
export const maxDuration = 60;

const createExportSchema = z.object({
  searchId: z.string().uuid(),
  label: z.string().trim().max(200).optional(),
});

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

  const parsed = createExportSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Expected { searchId: uuid, label?: string }." },
      { status: 400 },
    );
  }

  try {
    const result = await createSearchExport({
      searchId: parsed.data.searchId,
      userId: user.id,
      label: parsed.data.label,
    });

    return NextResponse.json(result, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof ExportError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    console.error("POST /api/exports failed", error);
    return NextResponse.json({ error: "Could not generate the export." }, { status: 500 });
  }
}
