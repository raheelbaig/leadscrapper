import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EXPORT_COLUMNS } from "@/lib/constants";
import { observeGoogleRequests, type GoogleObserver } from "@/test/google-observer";

/**
 * Export generation against the REAL database. OPT-IN:
 *
 *     LEAD_SCRAPPER_DB_TESTS=1 npx vitest run src/server/export/export.db.test.ts
 *
 * THE REGRESSION THIS EXISTS FOR
 * ------------------------------
 * Generating a document must not change the thing it documents.
 *
 * The first live export validation caught `createSearchExport` mutating the
 * search it was describing: it called `verify_search_coverage()` for the
 * Coverage sheet, which WRITES `searches.coverage_report` and so trips the
 * `updated_at` trigger. Because `searches` is in the Realtime publication, every
 * export also nudged open browser tabs into a refresh.
 *
 * A unit test could not have caught it -- the write happens inside a Postgres
 * function, and a mock would only have proved the mock agrees with itself. So
 * this reads the WHOLE search row before and after and fails on any difference.
 *
 * It makes no Google request, no Geocoding request, no email request and no
 * worker call. Two taps watch for that: the Places-endpoint observer and a
 * host-level tap that records every outbound host.
 *
 * Everything it writes -- one `exports` row and one Storage object -- is
 * deleted afterwards, so running it leaves no residue.
 */

const ENABLED = process.env.LEAD_SCRAPPER_DB_TESTS === "1";

type Db = ReturnType<typeof import("@/server/db/admin").getSupabaseAdminClient>;

/** Every outbound host, so a non-Google request cannot pass unnoticed. */
function tapAllHosts() {
  const previous = globalThis.fetch;
  const hosts: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    try {
      hosts.push(new URL(url).host);
    } catch {
      hosts.push("<unparsable>");
    }
    return previous(input, init);
  }) as typeof fetch;

  return {
    unique: () => [...new Set(hosts)].sort(),
    restore: () => {
      globalThis.fetch = previous;
    },
  };
}

describe.skipIf(!ENABLED)("export generation", () => {
  let db: Db;
  let searchId: string;
  let userId: string;
  let googleTap: GoogleObserver;
  let hostTap: ReturnType<typeof tapAllHosts>;

  /** The complete search row, as it stood before anything was exported. */
  let searchBefore: Record<string, unknown>;
  let tilesBefore: unknown;
  let leadsBefore: unknown;

  /** Every export this suite creates, so afterAll can remove all of them. */
  const created: { id: string; path: string }[] = [];

  let firstExportId = "";
  let workbook: ExcelJS.Workbook;

  beforeAll(async () => {
    const { getSupabaseAdminClient } = await import("@/server/db/admin");
    db = getSupabaseAdminClient();

    // Any completed search with leads will do. The suite is about the
    // read-only property, not about one particular row.
    const { data: candidate } = await db
      .from("searches")
      .select("id, user_id")
      .gt("leads_found", 0)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!candidate) throw new Error("No search with leads to export. Cannot run this suite.");

    searchId = candidate.id;
    userId = candidate.user_id;

    const [search, tiles, leads] = await Promise.all([
      db.from("searches").select("*").eq("id", searchId).single(),
      db.from("search_tiles").select("*").eq("search_id", searchId).order("path"),
      db.from("leads").select("*").eq("search_id", searchId).order("place_id"),
    ]);

    searchBefore = search.data as unknown as Record<string, unknown>;
    tilesBefore = tiles.data;
    leadsBefore = leads.data;

    hostTap = tapAllHosts();
    googleTap = observeGoogleRequests();

    const { createSearchExport } = await import("./export-service");
    const result = await createSearchExport({ searchId, userId });

    firstExportId = result.exportId;
    created.push({ id: result.exportId, path: result.storagePath });

    // Read the workbook back out of Storage through a signed URL, so the
    // assertions describe the stored artifact rather than an in-memory buffer.
    const { getExportDownloadUrl } = await import("./export-service");
    const signed = await getExportDownloadUrl({ exportId: result.exportId, userId });
    const response = await fetch(signed.url);
    const buffer = Buffer.from(await response.arrayBuffer());

    workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  }, 120_000);

  afterAll(async () => {
    googleTap?.restore();
    hostTap?.restore();

    // Leave nothing behind. The Storage object goes first: an orphaned object
    // with no row pointing at it is the harder thing to notice later.
    for (const { id, path } of created) {
      await db.storage.from("exports").remove([path]);
      await db.from("exports").delete().eq("id", id);
    }
  }, 60_000);

  // -----------------------------------------------------------------------
  // THE REGRESSION.
  // -----------------------------------------------------------------------
  describe("exporting does not mutate the search it describes", () => {
    it("leaves the search row byte-for-byte identical", async () => {
      const { data } = await db.from("searches").select("*").eq("id", searchId).single();

      // The WHOLE row, updated_at and coverage_report included. Listing the
      // fields that may change is how the original defect survived review, so
      // this compares everything and permits nothing.
      expect(data).toEqual(searchBefore);
    });

    it("does not touch updated_at, so no Realtime update is published", async () => {
      // `searches` is in the Realtime publication and `tg_set_updated_at` fires
      // on every UPDATE. An unchanged updated_at is therefore proof that no
      // UPDATE statement ran against this row at all.
      const { data } = await db.from("searches").select("updated_at").eq("id", searchId).single();

      expect(data!.updated_at).toBe(searchBefore.updated_at);
    });

    it("does not rewrite the stored coverage_report", async () => {
      const { data } = await db
        .from("searches")
        .select("coverage_report")
        .eq("id", searchId)
        .single();

      expect(data!.coverage_report).toEqual(searchBefore.coverage_report);
    });

    it("leaves every tile untouched", async () => {
      const { data } = await db
        .from("search_tiles")
        .select("*")
        .eq("search_id", searchId)
        .order("path");

      expect(data).toEqual(tilesBefore);
    });

    it("leaves every lead untouched", async () => {
      const { data } = await db
        .from("leads")
        .select("*")
        .eq("search_id", searchId)
        .order("place_id");

      expect(data).toEqual(leadsBefore);
    });

    it("stays unchanged across REPEATED exports of the same search", async () => {
      // The defect was idempotent-looking: each export moved the timestamp by a
      // few seconds and nothing else. Exporting twice more and re-comparing is
      // what turns "looks fine" into "cannot drift".
      const { createSearchExport } = await import("./export-service");

      for (let i = 0; i < 2; i += 1) {
        const result = await createSearchExport({ searchId, userId });
        created.push({ id: result.exportId, path: result.storagePath });
      }

      const { data } = await db.from("searches").select("*").eq("id", searchId).single();
      expect(data).toEqual(searchBefore);
    }, 60_000);
  });

  // -----------------------------------------------------------------------
  // It still has to produce a correct workbook.
  // -----------------------------------------------------------------------
  describe("the generated workbook", () => {
    it("reaches status ready with a row count and a size", async () => {
      const { data } = await db
        .from("exports")
        .select("status, row_count, file_size, storage_path, error")
        .eq("id", firstExportId)
        .single();

      expect(data!.status).toBe("ready");
      expect(data!.error).toBeNull();
      expect(data!.row_count).toBeGreaterThan(0);
      expect(data!.file_size).toBeGreaterThan(0);
      expect(data!.storage_path).toBe(`${userId}/${firstExportId}.xlsx`);
    });

    it("carries both worksheets", () => {
      expect(workbook.worksheets.map((w) => w.name)).toEqual(["Leads", "Coverage"]);
    });

    it("carries all 15 approved columns in order", () => {
      const header = workbook.getWorksheet("Leads")!.getRow(1).values as unknown[];
      expect(header.slice(1)).toEqual([...EXPORT_COLUMNS]);
    });

    it("puts the STORED grid invariant on the Coverage sheet", async () => {
      // Read from `searches.coverage_report`, never recomputed -- which is the
      // whole point of the fix. If the stored report says the grid is sound,
      // the sheet must say so too, without having asked the database again.
      const stored = searchBefore.coverage_report as Record<string, unknown> | null;

      const sheet = workbook.getWorksheet("Coverage")!;
      const parts: string[] = [];
      sheet.eachRow((row) => {
        row.eachCell({ includeEmpty: false }, (cell) => {
          if (cell.value !== null && cell.value !== undefined) parts.push(String(cell.value));
        });
      });
      const text = parts.join("\n");

      expect(text).toContain("Grid invariant");

      if (stored) {
        expect(text).toContain("Grid sound");
        expect(text).toContain(String(stored.ok));
      } else {
        // A search that never ran has no verdict, and the sheet says so rather
        // than inventing one.
        expect(text).toContain("Not available");
      }
    });
  });

  // -----------------------------------------------------------------------
  // The prohibitions.
  // -----------------------------------------------------------------------
  describe("nothing forbidden happened", () => {
    it("made zero Google requests", () => {
      expect(googleTap.count()).toBe(0);
    });

    it("contacted no host except Supabase", () => {
      for (const host of hostTap.unique()) {
        expect(host).toMatch(/supabase\.(co|in)$/);
      }
    });

    it("never calls verify_search_coverage", async () => {
      // Asserted against the source as well as against behaviour: the RPC is a
      // write dressed as a read, and the export path must not reach for it
      // again even if someone is only trying to be helpful.
      const { readFileSync } = await import("node:fs");
      const path = await import("node:path");
      const source = readFileSync(
        path.resolve(process.cwd(), "src/server/export/export-service.ts"),
        "utf8",
      ).replace(/\/\*[\s\S]*?\*\//g, " ");

      expect(source).not.toMatch(/rpc\(\s*["']verify_search_coverage["']/);
    });

    it("issues no write to any table but exports", async () => {
      const { readFileSync } = await import("node:fs");
      const path = await import("node:path");
      const source = readFileSync(
        path.resolve(process.cwd(), "src/server/export/export-service.ts"),
        "utf8",
      ).replace(/\/\*[\s\S]*?\*\//g, " ");

      // Every mutating call in this module must target `exports`.
      const mutations = [
        ...source.matchAll(/\.from\("(\w+)"\)\s*\.\s*(insert|update|delete|upsert)/g),
      ];

      expect(mutations.length).toBeGreaterThan(0);
      for (const match of mutations) {
        expect(match[1]).toBe("exports");
      }
    });
  });
});
