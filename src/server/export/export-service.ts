import "server-only";

import { buildCoverageReport, type CoverageTile } from "@/lib/coverage-report";
import type { Json } from "@/lib/database.types";
import type { TileState } from "@/lib/tile-states";
import { getSupabaseAdminClient } from "@/server/db/admin";
import { SEARCH_LIMITS } from "@/server/search/limits";

import type { ExportableLead } from "./columns";
import { buildWorkbook, type ExportMeta } from "./workbook";

/**
 * Generating a workbook, from database rows to a private object in Storage.
 *
 * The `exports` row is written FIRST, as `pending`, before any work is done.
 * That is deliberate: a generation that dies halfway leaves a visible failed
 * row rather than nothing at all, and the user finds out from the exports list
 * instead of from a download that never arrives.
 *
 * Storage paths are `{user_id}/{export_id}.xlsx` and that shape is load-bearing
 * -- the `exports_read_own` policy in migration 0008 authorises on
 * `(storage.foldername(name))[1] = auth.uid()`, so a file written anywhere else
 * would be unreadable by its own owner.
 *
 * The bucket is private. Downloads are short-lived signed URLs minted
 * server-side; no object is ever public.
 *
 * MAKES NO GOOGLE REQUEST. Exporting reads rows that were already paid for.
 */

type AdminDb = ReturnType<typeof getSupabaseAdminClient>;

export const EXPORTS_BUCKET = "exports";

/** How long a download link lives. Long enough to click, short enough to leak. */
export const SIGNED_URL_TTL_SECONDS = 120;

/**
 * Rows read per page when loading leads.
 *
 * PostgREST caps a single response, so a search with thousands of leads has to
 * be paged or the workbook silently ends at the cap -- which is exactly the
 * class of quiet truncation this project refuses everywhere else.
 */
const LEAD_PAGE_SIZE = 1_000;

export class ExportError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ExportError";
    this.status = status;
  }
}

const LEAD_COLUMNS =
  "name, phone_national, phone_international, address, website, email, maps_url, city, state, " +
  "country, place_id, query_tile, email_status, email_source, email_confidence, email_checked_at";

async function loadAllLeads(db: AdminDb, searchId: string): Promise<ExportableLead[]> {
  const leads: ExportableLead[] = [];

  for (let from = 0; ; from += LEAD_PAGE_SIZE) {
    const { data, error } = await db
      .from("leads")
      .select(LEAD_COLUMNS)
      .eq("search_id", searchId)
      .order("name", { ascending: true })
      .range(from, from + LEAD_PAGE_SIZE - 1);

    if (error) throw new Error(`Could not read the leads: ${error.message}`);
    if (!data || data.length === 0) break;

    leads.push(...(data as unknown as ExportableLead[]));
    if (data.length < LEAD_PAGE_SIZE) break;
  }

  return leads;
}

export type ExportResult = {
  exportId: string;
  label: string;
  storagePath: string;
  rowCount: number;
  fileSize: number;
  /** True when the workbook describes an area that was not fully searched. */
  partialCoverage: boolean;
  coveragePct: number;
};

export async function createSearchExport(
  args: { searchId: string; userId: string; label?: string },
  db: AdminDb = getSupabaseAdminClient(),
): Promise<ExportResult> {
  // ---------------------------------------------------------------------
  // 1. The search, and that it belongs to the caller. The service-role client
  //    bypasses RLS, so ownership is a predicate rather than an assumption.
  // ---------------------------------------------------------------------
  const { data: search, error: searchError } = await db
    .from("searches")
    .select("*")
    .eq("id", args.searchId)
    .eq("user_id", args.userId)
    .maybeSingle();

  if (searchError) throw new Error(`Could not load the search: ${searchError.message}`);
  if (!search) throw new ExportError("Search not found.", 404);

  const label = args.label?.trim() || `${search.niche} — ${search.label}`;

  // ---------------------------------------------------------------------
  // 2. The pending row, BEFORE the work. A crash from here on is visible.
  // ---------------------------------------------------------------------
  const { data: exportRow, error: insertError } = await db
    .from("exports")
    .insert({
      user_id: args.userId,
      search_id: args.searchId,
      kind: "xlsx",
      label,
      status: "pending",
      filters: { searchId: args.searchId } as unknown as Json,
    })
    .select("id")
    .single();

  if (insertError || !exportRow) {
    throw new Error(`Could not start the export: ${insertError?.message ?? "no row returned"}`);
  }

  const exportId = exportRow.id;
  const storagePath = `${args.userId}/${exportId}.xlsx`;

  try {
    const [leads, { data: tiles }, { data: invariant }] = await Promise.all([
      loadAllLeads(db, args.searchId),
      db
        .from("search_tiles")
        .select("label, state, area_km2, depth")
        .eq("search_id", args.searchId),
      db.rpc("verify_search_coverage", { p_search: args.searchId }),
    ]);

    // The SAME pure function the search page renders and the tick logs, so the
    // workbook cannot disagree with the screen it was exported from.
    const coverage = buildCoverageReport({
      tiles: (tiles ?? []).map((tile): CoverageTile => ({
        label: tile.label,
        state: tile.state as TileState,
        area_km2: tile.area_km2 ?? 0,
        depth: tile.depth,
      })),
      target: search.target_leads,
      leadsFound: search.leads_found,
    });

    const meta: ExportMeta = {
      searchLabel: search.label,
      niche: search.niche,
      queryText: search.query_text,
      city: search.city,
      state: search.state,
      country: search.country,
      bbox: {
        minLat: search.min_lat,
        minLng: search.min_lng,
        maxLat: search.max_lat,
        maxLng: search.max_lng,
      },
      status: search.status,
      stopReason: search.stop_reason,
      apiCallsRun: search.api_calls_run,
      callBudget: SEARCH_LIMITS.maxCallsPerSearch,
      sku: search.search_sku,
      pricingVersion: search.pricing_version,
      gridConfig:
        search.grid_config &&
        typeof search.grid_config === "object" &&
        !Array.isArray(search.grid_config)
          ? (search.grid_config as Record<string, unknown>)
          : {},
      createdAt: search.created_at,
      finishedAt: search.finished_at,
      generatedAt: new Date(),
      invariant: (invariant as Record<string, unknown> | null) ?? null,
    };

    const buffer = await buildWorkbook({ leads, coverage, meta });

    const { error: uploadError } = await db.storage
      .from(EXPORTS_BUCKET)
      .upload(storagePath, buffer, {
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        upsert: true,
      });

    if (uploadError) throw new Error(`Could not store the workbook: ${uploadError.message}`);

    await db
      .from("exports")
      .update({
        status: "ready",
        storage_path: storagePath,
        row_count: leads.length,
        file_size: buffer.byteLength,
        error: null,
      })
      .eq("id", exportId);

    return {
      exportId,
      label,
      storagePath,
      rowCount: leads.length,
      fileSize: buffer.byteLength,
      partialCoverage: !coverage.fullyCovered,
      coveragePct: coverage.coveragePct,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // The failure is recorded on the row rather than swallowed, so the exports
    // list shows what went wrong instead of a workbook that never appears.
    await db
      .from("exports")
      .update({ status: "failed", error: message.slice(0, 500) })
      .eq("id", exportId);

    throw error;
  }
}

/**
 * A short-lived download link for a finished export.
 *
 * Minted server-side against a PRIVATE bucket, after re-checking ownership.
 * Nothing about the object is public and no link outlives its TTL.
 */
export async function getExportDownloadUrl(
  args: { exportId: string; userId: string },
  db: AdminDb = getSupabaseAdminClient(),
): Promise<{ url: string; label: string; expiresInSeconds: number }> {
  const { data: row, error } = await db
    .from("exports")
    .select("id, label, status, storage_path")
    .eq("id", args.exportId)
    .eq("user_id", args.userId)
    .maybeSingle();

  if (error) throw new Error(`Could not load the export: ${error.message}`);
  if (!row) throw new ExportError("Export not found.", 404);
  if (row.status !== "ready" || !row.storage_path) {
    throw new ExportError(`This export is ${row.status}; there is no file to download.`, 409);
  }

  const { data: signed, error: signError } = await db.storage
    .from(EXPORTS_BUCKET)
    .createSignedUrl(row.storage_path, SIGNED_URL_TTL_SECONDS, {
      download: `${row.label.replace(/[^\w\-. ]+/g, "_")}.xlsx`,
    });

  if (signError || !signed) {
    throw new Error(`Could not sign the download: ${signError?.message ?? "no URL returned"}`);
  }

  return { url: signed.signedUrl, label: row.label, expiresInSeconds: SIGNED_URL_TTL_SECONDS };
}
