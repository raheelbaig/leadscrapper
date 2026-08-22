import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/server/db/server-client";
import {
  EnrichmentError,
  MAX_ENRICHMENT_BATCH,
  runEnrichment,
} from "@/server/enrichment/run-enrichment";

/**
 * POST /api/enrichment/run
 *
 * Looks for email addresses on the leads' own public websites.
 *
 * This is the ONLY path in the application that reaches a host other than
 * Google's, and every request it makes goes to a site whose URL Google already
 * gave us. It makes NO Google request and reserves no Google quota; the
 * provider is free and reports zero cost units.
 *
 * Bounded by construction:
 *   - `dryRun` (the default) resolves the scope and writes nothing at all;
 *   - `limit` is clamped to MAX_ENRICHMENT_BATCH;
 *   - leads are processed one at a time with politeness delays;
 *   - only leads that have never been looked at are selected, unless specific
 *     `leadIds` are named, so re-running is idempotent.
 *
 * Nothing schedules this. It runs because a person pressed a button.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/** 25 leads x up to 4 pages each, with delays. The batch cap keeps this true. */
export const maxDuration = 300;

const runEnrichmentSchema = z
  .object({
    searchId: z.string().uuid().optional(),
    leadIds: z.array(z.string().uuid()).max(MAX_ENRICHMENT_BATCH).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_ENRICHMENT_BATCH).optional(),
    /**
     * Defaults to TRUE. A caller that omits this gets the inert version — the
     * safe default is the one that makes no request.
     */
    dryRun: z.boolean().default(true),
  })
  .strict();

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  let payload: unknown = {};
  try {
    const text = await request.text();
    if (text) payload = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const parsed = runEnrichmentSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid enrichment request.",
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
      { status: 400 },
    );
  }

  try {
    const result = await runEnrichment({
      userId: user.id,
      searchId: parsed.data.searchId,
      leadIds: parsed.data.leadIds,
      limit: parsed.data.limit,
      dryRun: parsed.data.dryRun,
      // Passed explicitly, and only for a live run. `runEnrichment` throws
      // rather than guessing one, so a dry run structurally cannot reach the
      // network even if this line were wrong.
      fetchImpl: parsed.data.dryRun ? undefined : globalThis.fetch,
    });

    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof EnrichmentError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    console.error("POST /api/enrichment/run failed", error);
    return NextResponse.json({ error: "The enrichment run failed." }, { status: 500 });
  }
}
