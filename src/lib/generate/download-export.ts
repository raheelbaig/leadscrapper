/**
 * Downloading a stored workbook, with a success signal that means something.
 *
 * ---------------------------------------------------------------------------
 * THE BUG THIS REPLACES.
 *
 * The old path built a detached `<a href="/api/exports/…/download">`, clicked
 * it, and removed it from the DOM in the same tick. Two things were wrong with
 * that. The navigation did not reliably produce a file for the user; and
 * nothing about it could be observed, so the page announced success whenever a
 * signed URL had been minted -- whether or not a single byte ever arrived.
 *
 * Fetching the file instead makes the outcome checkable. A non-OK status is an
 * error the user is told about, and the "downloaded" message is only shown
 * after the bytes are in hand and handed to the browser.
 *
 * The response is same-origin (the route streams the file rather than
 * redirecting), so no cross-origin policy is involved and the filename comes
 * from our own `Content-Disposition`.
 * ---------------------------------------------------------------------------
 */

export type DownloadOutcome =
  { ok: true; filename: string; bytes: number } | { ok: false; error: string };

/** Pulls the filename out of a `Content-Disposition`, preferring RFC 5987. */
export function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;

  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1].trim());
    } catch {
      // Malformed encoding: fall through to the plain form.
    }
  }

  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain ? plain[1].trim() : fallback;
}

/**
 * Fetches the workbook and hands it to the browser.
 *
 * Split from the component so the whole path is testable without a DOM: the
 * fetch and the "save" step are both injectable.
 */
export async function downloadExport(
  exportId: string,
  options: {
    fetchImpl?: typeof fetch;
    /** Receives the finished blob. Defaults to a real browser download. */
    save?: (blob: Blob, filename: string) => void;
  } = {},
): Promise<DownloadOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const save = options.save ?? saveBlob;

  let response: Response;
  try {
    response = await fetchImpl(`/api/exports/${exportId}/download`, { cache: "no-store" });
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }

  if (!response.ok) {
    // The route answers JSON on failure. Read it if we can, but never let a
    // parsing problem masquerade as a successful download.
    let message = `The download failed (${response.status}).`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload?.error) message = payload.error;
    } catch {
      // Keep the status-based message.
    }
    return { ok: false, error: message };
  }

  const blob = await response.blob();

  // An empty body is a failed download wearing a 200. Callers must not treat
  // it as success.
  if (blob.size === 0) {
    return { ok: false, error: "The downloaded file was empty." };
  }

  const filename = filenameFromDisposition(
    response.headers.get("content-disposition"),
    "leads.xlsx",
  );

  save(blob, filename);
  return { ok: true, filename, bytes: blob.size };
}

/**
 * The browser save step.
 *
 * The object URL is revoked on a later tick rather than immediately: revoking
 * it in the same tick as the click is what makes this kind of helper flaky.
 */
function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();

  setTimeout(() => {
    anchor.remove();
    URL.revokeObjectURL(url);
  }, 0);
}
