import "server-only";

import ExcelJS from "exceljs";

import { EXPORT_COLUMNS } from "@/lib/constants";
import type { CoverageReport } from "@/lib/coverage-report";
import { TILE_STATE_META, type TileState } from "@/lib/tile-states";

import { EXPORT_COLUMN_WIDTHS, toExportRow, type ExportableLead } from "./columns";

/**
 * The workbook.
 *
 * TWO worksheets, always. A sheet of leads that does not say what fraction of
 * the requested area went unsearched is a misleading artifact: it looks like
 * "the embroidery shops in Houston" when it is actually "the embroidery shops
 * in 83% of Houston, and here is the 17% nobody looked at". So Coverage is
 * written on EVERY export, including partial ones, and it is written second so
 * it sits right next to the data it qualifies.
 *
 * Pure: it takes rows and a coverage report and returns a buffer. It reads no
 * database, mints no URL and uploads nothing, which is what lets the whole
 * layout be asserted from an in-memory workbook in the tests.
 *
 * The coverage numbers come from `buildCoverageReport`, the same pure function
 * the search page renders and the tick writes to the activity log, so the
 * workbook cannot tell a different story from the screen it was exported from.
 */

export type ExportMeta = {
  searchLabel: string;
  niche: string;
  queryText: string;
  city: string;
  state: string | null;
  country: string;
  bbox: { minLat: number; minLng: number; maxLat: number; maxLng: number };
  status: string;
  stopReason: string | null;
  apiCallsRun: number;
  callBudget: number;
  sku: string;
  pricingVersion: string;
  gridConfig: Record<string, unknown>;
  createdAt: string;
  finishedAt: string | null;
  generatedAt: Date;
  /** `verify_search_coverage`'s answer: the structural soundness of the grid. */
  invariant: Record<string, unknown> | null;
};

const HEADER_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF1F2933" },
};

const WARN_FONT: Partial<ExcelJS.Font> = { color: { argb: "FFB45309" }, bold: true };

function styleHeaderRow(row: ExcelJS.Row): void {
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = HEADER_FILL;
  row.alignment = { vertical: "middle" };
  row.height = 20;
}

export function buildLeadsSheet(workbook: ExcelJS.Workbook, leads: ExportableLead[]): void {
  const sheet = workbook.addWorksheet("Leads", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  sheet.columns = EXPORT_COLUMNS.map((column) => ({
    header: column,
    key: column,
    width: EXPORT_COLUMN_WIDTHS[column],
  }));

  styleHeaderRow(sheet.getRow(1));

  for (const lead of leads) {
    sheet.addRow(toExportRow(lead));
  }

  // Date formatting for `Enriched At`, which is the only Date column.
  const enrichedAt = sheet.getColumn(EXPORT_COLUMNS.indexOf("Enriched At") + 1);
  enrichedAt.numFmt = "yyyy-mm-dd hh:mm";

  const confidence = sheet.getColumn(EXPORT_COLUMNS.indexOf("Email Confidence") + 1);
  confidence.numFmt = "0.000";

  if (leads.length > 0) {
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: EXPORT_COLUMNS.length },
    };
  }
}

type Line = [label: string, value: string | number, note?: string];

export function buildCoverageSheet(
  workbook: ExcelJS.Workbook,
  report: CoverageReport,
  meta: ExportMeta,
): void {
  const sheet = workbook.addWorksheet("Coverage");
  sheet.columns = [
    { key: "label", width: 34 },
    { key: "value", width: 30 },
    { key: "note", width: 64 },
  ];

  const section = (title: string) => {
    const row = sheet.addRow([title]);
    row.font = { bold: true, size: 12 };
    row.height = 22;
  };

  const lines = (rows: Line[]) => {
    for (const [label, value, note] of rows) {
      const row = sheet.addRow([label, value, note ?? ""]);
      row.getCell(1).font = { bold: true };
      row.getCell(3).font = { italic: true, color: { argb: "FF6B7280" } };
    }
  };

  const km = (value: number) => `${value.toFixed(2)} km²`;
  const pct = (value: number) => `${value.toFixed(2)}%`;

  // ---- the headline, stated before any number that could soften it --------
  section("What this export covers");
  const verdict = report.fullyCovered
    ? "COMPLETE — the whole requested area was searched."
    : `INCOMPLETE — ${pct(report.owed.pct + report.permanentGap.pct)} of the requested area was NOT searched.`;

  const verdictRow = sheet.addRow(["Coverage verdict", verdict]);
  verdictRow.getCell(1).font = { bold: true };
  if (!report.fullyCovered) verdictRow.getCell(2).font = WARN_FONT;

  lines([
    ["Search", meta.searchLabel],
    ["Niche", meta.niche],
    ["Query sent to Google", meta.queryText, "The niche alone — never “niche in city”."],
    ["Location", [meta.city, meta.state, meta.country].filter(Boolean).join(", ")],
    [
      "Bounding box",
      `${meta.bbox.minLat}, ${meta.bbox.minLng} → ${meta.bbox.maxLat}, ${meta.bbox.maxLng}`,
    ],
    ["Exported at", meta.generatedAt.toISOString()],
  ]);

  sheet.addRow([]);

  // ---- leads vs the target, kept explicitly apart from coverage -----------
  section("Leads");
  lines([
    ["Leads found", report.leadsFound],
    [
      "Minimum target",
      report.target,
      "A benchmark, not a stopping point. The search runs until the area is covered.",
    ],
    [
      "Target met",
      report.targetReached ? "yes" : "no",
      "Reported as a result. It is never the reason a search ended.",
    ],
  ]);

  sheet.addRow([]);

  // ---- the area accounting ------------------------------------------------
  section("Area accounting (area-weighted, not tile count)");
  const searchedRow = sheet.addRow([
    "Area searched",
    `${km(report.covered.areaKm2)} (${pct(report.covered.pct)})`,
    `${report.covered.tiles} tile(s) verified`,
  ]);
  searchedRow.getCell(1).font = { bold: true };

  const owedRow = sheet.addRow([
    "Area NOT searched (recoverable)",
    `${km(report.owed.areaKm2)} (${pct(report.owed.pct)})`,
    "Still owed. Resuming the search covers this.",
  ]);
  owedRow.getCell(1).font = { bold: true };
  if (report.owed.tiles > 0) owedRow.getCell(2).font = WARN_FONT;

  const gapRow = sheet.addRow([
    "Permanent known gap",
    `${km(report.permanentGap.areaKm2)} (${pct(report.permanentGap.pct)})`,
    "Hit the 60-result ceiling at the smallest allowed tile. Resuming will NOT recover these.",
  ]);
  gapRow.getCell(1).font = { bold: true };
  if (report.permanentGap.tiles > 0) gapRow.getCell(2).font = WARN_FONT;

  lines([
    ["Total area", km(report.areaTotalKm2)],
    ["Leaf tiles", report.leafTiles, "Subdivided parents are containers, not coverage."],
    ["Tiles completed", report.tilesCompleted],
    ["Tiles remaining", report.tilesRemaining],
    ["Tiles subdivided", report.tilesSubdivided],
  ]);

  sheet.addRow([]);

  // ---- per-state breakdown ------------------------------------------------
  section("Tiles by state");
  const stateHeader = sheet.addRow(["State", "Tiles", "Area"]);
  styleHeaderRow(stateHeader);

  for (const state of Object.keys(TILE_STATE_META) as TileState[]) {
    const bucket = report.byState[state];
    if (bucket.tiles === 0) continue;
    sheet.addRow([
      TILE_STATE_META[state].label,
      bucket.tiles,
      state === "subdivided" ? "—" : `${km(bucket.areaKm2)} (${pct(bucket.pct)})`,
    ]);
  }

  sheet.addRow([]);

  // ---- the named gaps, with coordinates -----------------------------------
  section("Unsearched tiles, largest first");
  if (report.unsearchedTiles.length === 0) {
    sheet.addRow(["None — every leaf tile was accounted for."]);
  } else {
    const gapHeader = sheet.addRow(["Tile", "State", "Area"]);
    styleHeaderRow(gapHeader);
    for (const tile of report.unsearchedTiles) {
      sheet.addRow([tile.label, TILE_STATE_META[tile.state].label, km(tile.areaKm2)]);
    }
  }

  sheet.addRow([]);

  // ---- how it was run, and what it cost -----------------------------------
  section("Run configuration and cost");
  lines([
    ["Status", meta.status],
    ["Stop reason", meta.stopReason ?? "—"],
    ["Google API calls used", meta.apiCallsRun, `of a ${meta.callBudget}-call per-search budget`],
    ["Billing SKU", meta.sku],
    ["Pricing catalog version", meta.pricingVersion],
    ["Seed tile edge (km)", String(meta.gridConfig.seedTileEdgeKm ?? "—")],
    ["Max subdivision depth", String(meta.gridConfig.maxSubdivisionDepth ?? "—")],
    ["Min tile edge (km)", String(meta.gridConfig.minTileEdgeKm ?? "—")],
    ["Saturation ratio", String(meta.gridConfig.saturationRatio ?? "—")],
    [
      "Stop on target reached",
      String(meta.gridConfig.stopOnTargetReached ?? false),
      "False is the current product behaviour: completion is geographic.",
    ],
    ["Created", meta.createdAt],
    ["Finished", meta.finishedAt ?? "—"],
  ]);

  sheet.addRow([]);

  // ---- the structural invariant -------------------------------------------
  section("Grid invariant (verify_search_coverage)");
  if (!meta.invariant) {
    sheet.addRow(["Not available", "—", "The invariant check has not been run for this search."]);
  } else {
    lines([
      ["Grid sound", String(meta.invariant.ok ?? "—"), "Leaves tile the rectangle exactly."],
      ["Tiles disjoint", String(meta.invariant.disjoint ?? "—"), "No two leaves overlap."],
      [
        "Area matches bbox",
        String(meta.invariant.area_matches ?? "—"),
        "Union of the leaves equals the requested rectangle.",
      ],
    ]);
  }

  sheet.addRow([]);
  const footer = sheet.addRow([
    "Note",
    "",
    "Coverage and the lead target are separate measures. This sheet is written on every export, " +
      "including partial ones, so a lead list can never be mistaken for a complete survey of the area.",
  ]);
  footer.getCell(3).font = { italic: true, color: { argb: "FF6B7280" } };
}

export async function buildWorkbook(args: {
  leads: ExportableLead[];
  coverage: CoverageReport;
  meta: ExportMeta;
}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Lead Scrapper";
  workbook.created = args.meta.generatedAt;

  buildLeadsSheet(workbook, args.leads);
  buildCoverageSheet(workbook, args.coverage, args.meta);

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
