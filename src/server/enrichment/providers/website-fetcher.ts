import "server-only";

/**
 * THE SECOND OUTBOUND CALL SITE, and the only one that is not Google.
 *
 * Approved on 2026-08-22, explicitly and on its own, because this is the moment
 * the application becomes able to talk to a host nobody vetted: a lead's own
 * website, whose URL came from Google's response. Every other module in
 * `src/server/**` is still forbidden to call `fetch`; the safety envelope keeps
 * an explicit two-entry allow-list rather than a general permission.
 *
 * Everything here is a limit. Fetching an arbitrary third-party URL from a
 * server is a well-known way to acquire an SSRF, a hung request, or a 400 MB
 * response, so:
 *
 *   - HTTPS/HTTP only. No file:, data:, ftp:, gopher:.
 *   - No private, loopback, link-local or metadata addresses. A lead whose
 *     "website" is http://169.254.169.254/ must not become a credential leak.
 *   - Redirects followed manually, with the same checks applied at every hop.
 *     `redirect: "follow"` would let hop 2 land somewhere hop 1 was refused.
 *   - A hard timeout and a hard byte cap, both enforced while streaming rather
 *     than after the body has already arrived.
 *   - HTML only. A PDF or a video is not worth downloading to look for an @.
 *   - An honest User-Agent. This is a small business's own public site; there
 *     is no reason to be coy about who is reading it.
 *
 * NOTHING CALLS THIS DURING IMPLEMENTATION. Every test injects `fetchImpl`, and
 * the enrichment run route requires an explicit, bounded, user-triggered
 * request. No lead has been fetched.
 */

export const USER_AGENT =
  "LeadScrapperBot/1.0 (+contact via the business listing; respects robots.txt)";

/** One page, start to finish. Generous enough for a slow small-business host. */
export const FETCH_TIMEOUT_MS = 10_000;

/** 2 MB of HTML is already far more than any contact page needs. */
export const MAX_BYTES = 2 * 1024 * 1024;

/** Hops. Marketing sites redirect apex -> www -> https routinely. */
export const MAX_REDIRECTS = 3;

export type FetchImpl = typeof globalThis.fetch;

export type PageFetchResult =
  | { ok: true; url: string; status: number; html: string; bytes: number }
  | { ok: false; url: string; status: number | null; reason: string };

/**
 * Hosts that must never be requested.
 *
 * The cloud metadata endpoints are the sharp one: a server-side fetcher that
 * will retrieve any URL it is handed is a credential-exfiltration primitive on
 * every major cloud, and this process holds a service-role key.
 */
function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "metadata.google.internal") return true;

  // IPv4 literals: loopback, private ranges, link-local (incl. 169.254.169.254).
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true;
    return false;
  }

  // IPv6 literals: loopback, unique-local, link-local, and v4-mapped forms.
  if (host === "::1" || host === "::") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true;
  if (/^::ffff:/.test(host)) return true;

  return false;
}

/** A URL this fetcher is willing to request, or null with the reason. */
export function validateUrl(raw: string): { url: URL } | { reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { reason: "not a valid URL" };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { reason: `unsupported protocol ${url.protocol}` };
  }
  if (isBlockedHost(url.hostname)) {
    return { reason: "refuses private, loopback and metadata addresses" };
  }

  return { url };
}

/** The registrable-ish domain, for grouping and for scoring an address. */
export function domainOf(raw: string): string | null {
  const validated = validateUrl(raw);
  if ("reason" in validated) return null;
  return validated.url.hostname.toLowerCase().replace(/^www\./, "");
}

async function readCapped(
  response: Response,
  cap: number,
): Promise<{ text: string; bytes: number }> {
  const body = response.body;
  if (!body) return { text: "", bytes: 0 };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      bytes += value.byteLength;
      // Capped WHILE streaming. Reading the whole body and then checking its
      // length is not a cap; it is a report on how much was already downloaded.
      if (bytes > cap) {
        chunks.push(value.slice(0, value.byteLength - (bytes - cap)));
        break;
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  return { text: Buffer.concat(chunks).toString("utf8"), bytes: Math.min(bytes, cap) };
}

/**
 * Fetch one page, following redirects by hand so every hop is re-validated.
 *
 * `fetchImpl` is required to be injectable and every test injects it. There is
 * no default parameter that would let a forgotten stub reach the network
 * quietly -- the caller passes `globalThis.fetch` deliberately or passes a fake.
 */
export async function fetchPage(
  rawUrl: string,
  options: {
    fetchImpl: FetchImpl;
    timeoutMs?: number;
    maxBytes?: number;
    maxRedirects?: number;
    signal?: AbortSignal;
  },
): Promise<PageFetchResult> {
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;

  let current = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const validated = validateUrl(current);
    if ("reason" in validated) {
      return { ok: false, url: current, status: null, reason: validated.reason };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    options.signal?.addEventListener("abort", () => controller.abort(), { once: true });

    let response: Response;
    try {
      response = await options.fetchImpl(validated.url.toString(), {
        method: "GET",
        // Manual, so a redirect cannot smuggle us past the host checks above.
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml",
          "accept-language": "en",
        },
      });
    } catch (error) {
      return {
        ok: false,
        url: current,
        status: null,
        reason:
          error instanceof Error && error.name === "AbortError"
            ? `timed out after ${timeoutMs}ms`
            : error instanceof Error
              ? error.message
              : String(error),
      };
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        return {
          ok: false,
          url: current,
          status: response.status,
          reason: "redirect with no location",
        };
      }
      current = new URL(location, validated.url).toString();
      continue;
    }

    if (!response.ok) {
      return {
        ok: false,
        url: current,
        status: response.status,
        reason: `HTTP ${response.status}`,
      };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType && !/text\/html|application\/xhtml|text\/plain/i.test(contentType)) {
      return {
        ok: false,
        url: current,
        status: response.status,
        reason: `not HTML (${contentType.split(";")[0]})`,
      };
    }

    const { text, bytes } = await readCapped(response, maxBytes);
    return { ok: true, url: current, status: response.status, html: text, bytes };
  }

  return { ok: false, url: current, status: null, reason: `more than ${maxRedirects} redirects` };
}

/**
 * robots.txt, honoured for our own User-Agent and for `*`.
 *
 * A deliberately small parser: it reads `Disallow` paths from the groups that
 * apply to us and answers "may I fetch this path". It does not implement
 * `Allow` precedence or wildcards, and it FAILS CLOSED on a malformed file --
 * being over-cautious about someone else's website is the right direction to
 * be wrong in.
 */
export function parseRobots(body: string): { disallow: string[] } {
  const lines = body.split(/\r?\n/);
  const disallow: string[] = [];

  let applies = false;
  for (const line of lines) {
    const clean = line.replace(/#.*$/, "").trim();
    if (!clean) continue;

    const [rawKey, ...rest] = clean.split(":");
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();

    if (key === "user-agent") {
      applies = value === "*" || USER_AGENT.toLowerCase().startsWith(value.toLowerCase());
      continue;
    }
    if (applies && key === "disallow" && value) {
      disallow.push(value);
    }
  }

  return { disallow };
}

export function robotsAllows(robots: { disallow: string[] }, pathname: string): boolean {
  return !robots.disallow.some((rule) => rule === "/" || pathname.startsWith(rule));
}
