import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { EXPORT_COLUMNS } from "@/lib/constants";
import { buildCoverageReport, type CoverageTile } from "@/lib/coverage-report";

import { sanitizeCell, toExportRow, type ExportableLead } from "./columns";
import { buildWorkbook, type ExportMeta } from "./workbook";

/**
 * The workbook, asserted by reading it back.
 *
 * `buildWorkbook` returns a real .xlsx buffer, so these tests parse it with
 * ExcelJS rather than trusting the builder's own bookkeeping. What is actually
 * being defended:
 *
 *   - the Coverage worksheet EXISTS on every export, including partial ones;
 *   - it states the shortfall in words a reader cannot skim past;
 *   - the lead target is presented as a benchmark, never as an ending;
 *   - a business name that looks like a formula stays text.
 *
 * No network, no database, no Google. ExcelJS runs entirely in-process.
 */

function lead(overrides: Partial<ExportableLead> = {}): ExportableLead {
  return {
    name: "Bayou City Embroidery",
    phone_national: "(713) 555-0143",
    phone_international: "+1 713-555-0143",
    address: "1200 Main St, Houston, TX 77002, USA",
    website: "https://bayoucityembroidery.test",
    email: null,
    maps_url: "https://maps.google.com/?cid=1",
    city: "Houston",
    state: "TX",
    country: "USA",
    place_id: "ChIJtest0001",
    query_tile: "Tile #1",
    email_status: "not_enriched",
    email_source: null,
    email_confidence: null,
    email_checked_at: null,
    ...overrides,
  };
}

function tile(state: CoverageTile["state"], areaKm2: number, label = "Tile"): CoverageTile {
  return { label, state, area_km2: areaKm2, depth: 0 };
}

const META: ExportMeta = {
  searchLabel: "Houston, TX, United States",
  niche: "Embroidery Shops",
  queryText: "Embroidery Shops",
  city: "Houston",
  state: "TX",
  country: "United States",
  bbox: { minLat: 29.69, minLng: -95.45, maxLat: 29.83, maxLng: -95.28 },
  status: "paused",
  stopReason: "call_budget_reached",
  apiCallsRun: 5,
  callBudget: 150,
  sku: "places-text-search-enterprise",
  pricingVersion: "2026.08.1",
  gridConfig: { seedTileEdgeKm: 8, maxSubdivisionDepth: 3, stopOnTargetReached: false },
  createdAt: "2026-08-21T22:00:00.000Z",
  finishedAt: null,
  generatedAt: new Date("2026-08-22T09:00:00.000Z"),
  invariant: { ok: true, disjoint: true, area_matches: true },
};

/** The Phase 3B run exactly: target 40, found 51, 83.34% covered. */
const PARTIAL = buildCoverageReport({
  tiles: [
    tile("covered", 42.37, "Tile #1"),
    tile("covered", 42.37, "Tile #2"),
    tile("covered", 42.37, "Tile #3"),
    tile("covered", 42.37, "Tile #4"),
    tile("covered", 42.37, "Tile #5"),
    tile("pending", 42.37, "Tile #6"),
  ],
  target: 40,
  leadsFound: 51,
});

const COMPLETE = buildCoverageReport({
  tiles: [tile("covered", 50, "Tile #1"), tile("empty", 50, "Tile #2")],
  target: 40,
  leadsFound: 87,
});

async function readBack(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  return workbook;
}

/** Every string in a sheet, flattened, for "does it say X anywhere" checks. */
function sheetText(sheet: ExcelJS.Worksheet): string {
  const parts: string[] = [];
  sheet.eachRow((row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (cell.value !== null && cell.value !== undefined) parts.push(String(cell.value));
    });
  });
  return parts.join("\n");
}

describe("the leads worksheet", () => {
  it("writes the fixed column order, header first", async () => {
    const workbook = await readBack(
      await buildWorkbook({ leads: [lead()], coverage: COMPLETE, meta: META }),
    );

    const sheet = workbook.getWorksheet("Leads")!;
    const header = sheet.getRow(1).values as unknown[];

    // `values` is 1-indexed with a leading hole.
    expect(header.slice(1)).toEqual([...EXPORT_COLUMNS]);
  });

  it("carries the fifteenth column, Enriched At", async () => {
    expect(EXPORT_COLUMNS).toContain("Enriched At");
    expect(EXPORT_COLUMNS).toHaveLength(15);
  });

  it("maps a lead onto exactly as many cells as there are columns", () => {
    expect(toExportRow(lead())).toHaveLength(EXPORT_COLUMNS.length);
  });

  it("writes one row per lead", async () => {
    const leads = [lead(), lead({ place_id: "ChIJtest0002", name: "Second Stitch" })];
    const workbook = await readBack(await buildWorkbook({ leads, coverage: COMPLETE, meta: META }));

    // Header + two data rows.
    expect(workbook.getWorksheet("Leads")!.rowCount).toBe(3);
  });

  it("writes an enriched lead's email and timestamp", async () => {
    const workbook = await readBack(
      await buildWorkbook({
        leads: [
          lead({
            email: "hello@bayoucity.test",
            email_status: "verified",
            email_source: "website",
            email_confidence: 0.92,
            email_checked_at: "2026-08-22T08:30:00.000Z",
          }),
        ],
        coverage: COMPLETE,
        meta: META,
      }),
    );

    const text = sheetText(workbook.getWorksheet("Leads")!);
    expect(text).toContain("hello@bayoucity.test");
    expect(text).toContain("verified");
  });

  it("still produces a valid workbook with no leads at all", async () => {
    const workbook = await readBack(
      await buildWorkbook({ leads: [], coverage: PARTIAL, meta: META }),
    );

    expect(workbook.getWorksheet("Leads")).toBeDefined();
    // A zero-lead export still has to say what was not searched.
    expect(workbook.getWorksheet("Coverage")).toBeDefined();
  });
});

describe("formula injection", () => {
  it("neutralises a value that Excel would execute", () => {
    // Every one of these strings came from Google, not from us.
    expect(sanitizeCell("=1+1")).toBe("'=1+1");
    expect(sanitizeCell("+44 20 7946 0000")).toBe("'+44 20 7946 0000");
    expect(sanitizeCell("-Bargain Stitches")).toBe("'-Bargain Stitches");
    expect(sanitizeCell("@home Embroidery")).toBe("'@home Embroidery");
  });

  it("leaves ordinary text alone", () => {
    expect(sanitizeCell("Bayou City Embroidery")).toBe("Bayou City Embroidery");
    expect(sanitizeCell("")).toBe("");
    expect(sanitizeCell(null)).toBeNull();
  });

  it("applies to the row builder, not just the helper", () => {
    const row = toExportRow(lead({ name: "=cmd|' /c calc'!A0" }));
    expect(String(row[0])).toMatch(/^'=/);
  });
});

describe("the coverage worksheet is written on EVERY export", () => {
  it("exists for a complete search", async () => {
    const workbook = await readBack(
      await buildWorkbook({ leads: [lead()], coverage: COMPLETE, meta: META }),
    );
    expect(workbook.getWorksheet("Coverage")).toBeDefined();
  });

  it("exists for a partial one", async () => {
    const workbook = await readBack(
      await buildWorkbook({ leads: [lead()], coverage: PARTIAL, meta: META }),
    );
    expect(workbook.getWorksheet("Coverage")).toBeDefined();
  });

  it("states INCOMPLETE, with the percentage, when area was skipped", async () => {
    const workbook = await readBack(
      await buildWorkbook({ leads: [lead()], coverage: PARTIAL, meta: META }),
    );
    const text = sheetText(workbook.getWorksheet("Coverage")!);

    expect(text).toContain("INCOMPLETE");
    expect(text).toMatch(/16\.6\d%/);
  });

  it("states COMPLETE only when every leaf tile is accounted for", async () => {
    const workbook = await readBack(
      await buildWorkbook({ leads: [lead()], coverage: COMPLETE, meta: META }),
    );
    const text = sheetText(workbook.getWorksheet("Coverage")!);

    expect(text).toContain("COMPLETE");
    expect(text).not.toContain("INCOMPLETE");
  });

  it("names the unsearched tiles individually", async () => {
    const workbook = await readBack(
      await buildWorkbook({ leads: [lead()], coverage: PARTIAL, meta: META }),
    );
    const text = sheetText(workbook.getWorksheet("Coverage")!);

    // The one tile the Phase 3B run never reached.
    expect(text).toContain("Tile #6");
  });

  it("records the grid invariant result", async () => {
    const workbook = await readBack(
      await buildWorkbook({ leads: [lead()], coverage: COMPLETE, meta: META }),
    );
    const text = sheetText(workbook.getWorksheet("Coverage")!);

    expect(text).toContain("Grid sound");
    expect(text).toContain("Tiles disjoint");
    expect(text).toContain("Area matches bbox");
  });

  it("records what the run cost and which SKU it billed", async () => {
    const workbook = await readBack(
      await buildWorkbook({ leads: [lead()], coverage: PARTIAL, meta: META }),
    );
    const text = sheetText(workbook.getWorksheet("Coverage")!);

    expect(text).toContain("places-text-search-enterprise");
    expect(text).toContain("150-call per-search budget");
    expect(text).toContain("call_budget_reached");
  });
});

describe("the coverage worksheet never conflates the target with completion", () => {
  it("labels the target as a minimum", async () => {
    const workbook = await readBack(
      await buildWorkbook({ leads: [lead()], coverage: PARTIAL, meta: META }),
    );
    const text = sheetText(workbook.getWorksheet("Coverage")!);

    expect(text).toContain("Minimum target");
    expect(text).toMatch(/benchmark, not a stopping point/i);
  });

  it("does not call a target-met search complete when area is owed", async () => {
    // Target 40, found 51 — met. Coverage 83.34% — not complete.
    expect(PARTIAL.targetReached).toBe(true);
    expect(PARTIAL.fullyCovered).toBe(false);

    const workbook = await readBack(
      await buildWorkbook({ leads: [lead()], coverage: PARTIAL, meta: META }),
    );
    const text = sheetText(workbook.getWorksheet("Coverage")!);

    expect(text).toContain("INCOMPLETE");
    expect(text).toMatch(/It is never the reason a search ended/);
  });

  it("reports a target exceeded on a fully covered search as a plain result", async () => {
    // Target 40 · found 87 · coverage 100% — the specified successful outcome.
    expect(COMPLETE.targetReached).toBe(true);
    expect(COMPLETE.fullyCovered).toBe(true);

    const workbook = await readBack(
      await buildWorkbook({ leads: [lead()], coverage: COMPLETE, meta: META }),
    );
    const text = sheetText(workbook.getWorksheet("Coverage")!);

    expect(text).toContain("COMPLETE");
    expect(text).toContain("87");
  });
});
