import { beforeEach, describe, expect, it, vi } from "vitest";

const getCurrentUser = vi.fn();
const getExportFile = vi.fn();

vi.mock("@/server/db/server-client", () => ({ getCurrentUser: () => getCurrentUser() }));
vi.mock("@/server/export/export-service", async () => {
  const actual = await vi.importActual<typeof import("@/server/export/export-service")>(
    "@/server/export/export-service",
  );
  return {
    ...actual,
    getExportFile: (args: unknown) => getExportFile(args),
  };
});

import { contentDispositionFor, GET, XLSX_CONTENT_TYPE } from "./route";

/**
 * The download endpoint, end to end but without a network.
 *
 * The storage side was never the problem -- reading the stored object returns
 * 82,061 valid bytes with the right MIME type. What the browser did with the
 * 307 that used to be returned was, and a redirect also left the page unable to
 * tell whether anything arrived. These pin the response the route now produces
 * itself, from bytes the Storage SDK hands it.
 */

/** The first four bytes of every .xlsx: a zip local file header. */
const ZIP_MAGIC = Uint8Array.from([0x50, 0x4b, 0x03, 0x04]);

function workbookBytes(size = 2_048): ArrayBuffer {
  const bytes = new Uint8Array(size);
  bytes.set(ZIP_MAGIC, 0);
  return bytes.buffer;
}

function context(id = "export-1") {
  return { params: Promise.resolve({ id }) } as never;
}

beforeEach(() => {
  vi.restoreAllMocks();
  // `restoreAllMocks` does not clear call history on module-scope `vi.fn()`s,
  // so an assertion about "never called" would inherit the previous test.
  getCurrentUser.mockClear();
  getExportFile.mockClear();
  getCurrentUser.mockResolvedValue({ id: "user-1" });
  getExportFile.mockResolvedValue({
    bytes: workbookBytes(),
    label: "Embroidery shops — Houston, Texas, United States",
  });
});

describe("contentDispositionFor", () => {
  it("produces a .xlsx filename the browser will accept", () => {
    const header = contentDispositionFor("Embroidery shops — Houston, Texas, United States");

    expect(header).toMatch(/^attachment; /);
    expect(header).toMatch(/filename="[^"]+\.xlsx"/);
    // The RFC 5987 form carries the punctuation the quoted form cannot.
    expect(header).toMatch(/filename\*=UTF-8''/);
    expect(header).toMatch(/\.xlsx/);
  });

  it("never yields an empty filename", () => {
    // An empty label would otherwise produce a bare ".xlsx", which some
    // browsers refuse to save.
    expect(contentDispositionFor("")).toMatch(/filename="leads\.xlsx"/);
    expect(contentDispositionFor("   ")).toMatch(/filename="leads\.xlsx"/);
    // A label of pure punctuation still yields something saveable.
    expect(contentDispositionFor("///")).toMatch(/filename="[^"]+\.xlsx"/);
  });
});

describe("GET /api/exports/[id]/download", () => {
  it("serves the workbook with the right type, disposition and bytes", async () => {
    const bytes = workbookBytes();
    getExportFile.mockResolvedValue({ bytes, label: "Embroidery shops — Houston" });

    const response = await GET(new Request("http://localhost/x"), context());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(XLSX_CONTENT_TYPE);
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; /);
    expect(response.headers.get("content-disposition")).toMatch(/\.xlsx/);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");

    // NOT a redirect, and NOT JSON -- either of those is how the file failed to
    // reach the browser before.
    expect(response.status).not.toBe(307);
    expect(response.headers.get("location")).toBeNull();

    const body = new Uint8Array(await response.arrayBuffer());
    expect(body.length).toBe(bytes.byteLength);
    expect(body.length).toBeGreaterThan(0);
    // Real workbook bytes, not an error page.
    expect(Array.from(body.subarray(0, 4))).toEqual(Array.from(ZIP_MAGIC));
  });

  it("declares the real content length", async () => {
    getExportFile.mockResolvedValue({ bytes: workbookBytes(4_096), label: "Leads" });

    const response = await GET(new Request("http://localhost/x"), context());
    expect(response.headers.get("content-length")).toBe("4096");
  });

  it("refuses an unauthenticated request before signing anything", async () => {
    getCurrentUser.mockResolvedValue(null);

    const response = await GET(new Request("http://localhost/x"), context());

    expect(response.status).toBe(401);
    expect(getExportFile).not.toHaveBeenCalled();
  });

  it("checks ownership through the service, with the caller's own id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(workbookBytes(), { status: 200 })),
    );

    await GET(new Request("http://localhost/x"), context("export-99"));

    expect(getExportFile).toHaveBeenCalledWith({
      exportId: "export-99",
      userId: "user-1",
    });
  });

  it("reports a storage failure as an error rather than an empty file", async () => {
    const { ExportError } = await import("@/server/export/export-service");
    getExportFile.mockRejectedValue(new ExportError("The stored file is empty.", 502));

    const response = await GET(new Request("http://localhost/x"), context());

    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
    // A 200 with an error page inside would be the worst outcome: the client
    // would save it as a .xlsx.
    expect(response.status).not.toBe(200);
  });

  it("surfaces a service refusal with its own status", async () => {
    const { ExportError } = await import("@/server/export/export-service");
    getExportFile.mockRejectedValue(
      new ExportError("This export is pending; there is no file to download.", 409),
    );

    const response = await GET(new Request("http://localhost/x"), context());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "This export is pending; there is no file to download.",
    });
  });
});
