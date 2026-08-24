import { describe, expect, it, vi } from "vitest";

import { downloadExport, filenameFromDisposition } from "./download-export";

/**
 * The download, and the promise the UI makes about it.
 *
 * The bug these cover: the results page announced "Excel file is ready" whenever
 * an export row had been created, while the click that was supposed to fetch the
 * file did nothing observable. Success now has to mean bytes arrived.
 */

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** A response carrying a plausible workbook. */
function fileResponse(bytes = 82_061, filename = "Embroidery shops.xlsx") {
  return {
    ok: true,
    status: 200,
    headers: new Headers({
      "content-type": XLSX,
      "content-disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    }),
    blob: async () => ({ size: bytes }) as Blob,
  } as unknown as Response;
}

describe("filenameFromDisposition", () => {
  it("prefers the RFC 5987 form, which survives spaces and punctuation", () => {
    const header = `attachment; filename="Embroidery shops _ Houston.xlsx"; filename*=UTF-8''${encodeURIComponent("Embroidery shops — Houston.xlsx")}`;
    expect(filenameFromDisposition(header, "leads.xlsx")).toBe("Embroidery shops — Houston.xlsx");
  });

  it("falls back to the quoted form", () => {
    expect(filenameFromDisposition('attachment; filename="leads-2026.xlsx"', "x.xlsx")).toBe(
      "leads-2026.xlsx",
    );
  });

  it("falls back again when the header is missing or unusable", () => {
    expect(filenameFromDisposition(null, "leads.xlsx")).toBe("leads.xlsx");
    expect(filenameFromDisposition("attachment", "leads.xlsx")).toBe("leads.xlsx");
  });
});

describe("downloadExport", () => {
  it("hands the file to the browser and reports what arrived", async () => {
    const saved: { filename: string; size: number }[] = [];
    const fetchImpl = vi.fn(async () => fileResponse()) as unknown as typeof fetch;

    const outcome = await downloadExport("export-1", {
      fetchImpl,
      save: (blob, filename) => saved.push({ filename, size: blob.size }),
    });

    expect(outcome).toEqual({
      ok: true,
      filename: "Embroidery shops.xlsx",
      bytes: 82_061,
    });

    // THE POINT: a real save happened, with a real .xlsx name.
    expect(saved).toEqual([{ filename: "Embroidery shops.xlsx", size: 82_061 }]);
    expect(saved[0].filename.endsWith(".xlsx")).toBe(true);
  });

  it("requests the download endpoint uncached", async () => {
    const fetchImpl = vi.fn(async () => fileResponse()) as unknown as typeof fetch;
    await downloadExport("export-42", { fetchImpl, save: () => {} });

    expect(fetchImpl).toHaveBeenCalledWith("/api/exports/export-42/download", {
      cache: "no-store",
    });
  });

  /**
   * THE REGRESSION. A failure must never be reported as a success, because that
   * is exactly what the user saw: a cheerful toast and no file.
   */
  it("reports a server error instead of claiming success", async () => {
    const fetchImpl = (async () =>
      ({
        ok: false,
        status: 409,
        headers: new Headers(),
        json: async () => ({ error: "This export is pending; there is no file to download." }),
      }) as unknown as Response) as unknown as typeof fetch;

    const saved: string[] = [];
    const outcome = await downloadExport("export-1", {
      fetchImpl,
      save: (_blob, filename) => saved.push(filename),
    });

    expect(outcome).toEqual({
      ok: false,
      error: "This export is pending; there is no file to download.",
    });
    // Nothing was handed to the browser.
    expect(saved).toEqual([]);
  });

  it("treats a zero-byte body as a failure even though the status was 200", async () => {
    const fetchImpl = (async () => fileResponse(0)) as unknown as typeof fetch;
    const saved: string[] = [];

    const outcome = await downloadExport("export-1", {
      fetchImpl,
      save: (_blob, filename) => saved.push(filename),
    });

    expect(outcome).toEqual({ ok: false, error: "The downloaded file was empty." });
    expect(saved).toEqual([]);
  });

  it("survives a transport failure without throwing", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const outcome = await downloadExport("export-1", { fetchImpl, save: () => {} });
    expect(outcome).toEqual({ ok: false, error: "network down" });
  });

  it("still fails cleanly when the error body is not JSON", async () => {
    const fetchImpl = (async () =>
      ({
        ok: false,
        status: 500,
        headers: new Headers(),
        json: async () => {
          throw new Error("not json");
        },
      }) as unknown as Response) as unknown as typeof fetch;

    const outcome = await downloadExport("export-1", { fetchImpl, save: () => {} });
    expect(outcome).toEqual({ ok: false, error: "The download failed (500)." });
  });
});
