import "server-only";

import { EXPORT_COLUMNS, type ExportColumn } from "@/lib/constants";

/**
 * The lead row -> workbook cell mapping.
 *
 * Pure and separate from the workbook builder, so the column contract can be
 * asserted without constructing an xlsx file. The order is
 * `EXPORT_COLUMNS`, and it is derived from that constant rather than repeated:
 * a column added there but not mapped here fails a test rather than silently
 * exporting a blank stripe.
 *
 * Every value is a string, a number, a Date or null. ExcelJS will happily write
 * an object and produce a workbook Excel refuses to open, so the type is
 * narrowed here where it can be checked.
 */

export type ExportableLead = {
  name: string;
  phone_national: string | null;
  phone_international: string | null;
  address: string | null;
  website: string | null;
  email: string | null;
  maps_url: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  place_id: string;
  query_tile: string | null;
  email_status: string;
  email_source: string | null;
  email_confidence: number | null;
  email_checked_at: string | null;
};

export type CellValue = string | number | Date | null;

/**
 * Excel treats a cell beginning `=`, `+`, `-` or `@` as a formula, so a
 * business literally named "=SUM" or a website field carrying injected content
 * would execute on open. Prefixing with an apostrophe is the documented way to
 * force a literal, and the apostrophe is not part of the stored value.
 *
 * This matters here specifically because every one of these strings came from a
 * third party -- Google's response -- and none of it was authored by us.
 */
export function sanitizeCell(value: string | null): string | null {
  if (value === null || value === "") return value;
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function toDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * One lead as an ordered row, aligned to `EXPORT_COLUMNS`.
 *
 * Phone prefers the national format because that is what a person dials; the
 * international one is kept in the raw data and is not a separate column by
 * design -- fifteen columns that are all read is better than twenty where five
 * are ignored.
 */
export function toExportRow(lead: ExportableLead): CellValue[] {
  const byColumn: Record<ExportColumn, CellValue> = {
    "Business Name": sanitizeCell(lead.name),
    Phone: sanitizeCell(lead.phone_national ?? lead.phone_international),
    Address: sanitizeCell(lead.address),
    Website: sanitizeCell(lead.website),
    Email: sanitizeCell(lead.email),
    "Google Maps Link": sanitizeCell(lead.maps_url),
    City: sanitizeCell(lead.city),
    State: sanitizeCell(lead.state),
    Country: sanitizeCell(lead.country),
    "Place ID": sanitizeCell(lead.place_id),
    "Query Tile": sanitizeCell(lead.query_tile),
    "Email Status": lead.email_status,
    "Email Source": sanitizeCell(lead.email_source),
    "Email Confidence": lead.email_confidence,
    "Enriched At": toDate(lead.email_checked_at),
  };

  return EXPORT_COLUMNS.map((column) => byColumn[column]);
}

/** Column widths, in Excel character units. Order matches EXPORT_COLUMNS. */
export const EXPORT_COLUMN_WIDTHS: Record<ExportColumn, number> = {
  "Business Name": 38,
  Phone: 18,
  Address: 46,
  Website: 34,
  Email: 30,
  "Google Maps Link": 30,
  City: 18,
  State: 10,
  Country: 14,
  "Place ID": 30,
  "Query Tile": 12,
  "Email Status": 14,
  "Email Source": 16,
  "Email Confidence": 16,
  "Enriched At": 20,
};
