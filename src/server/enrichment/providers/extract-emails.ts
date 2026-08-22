import "server-only";

import type { EmailCandidate } from "../types";

/**
 * Pulling contact addresses out of a page of HTML.
 *
 * Pure — no network, no database — so the scoring rules can be argued with in a
 * test rather than discovered in production.
 *
 * The job is not "find strings containing @". It is to find the address a human
 * would email, and to be honest about how sure we are. Getting this wrong is
 * worse than finding nothing: an export full of `wix@support.com` and
 * `noreply@` looks like data and is not.
 */

/**
 * Deliberately stricter than RFC 5322. This runs over adversarial-ish input
 * (minified JS, tracking pixels, base64 blobs) where a permissive pattern
 * matches enormous amounts of noise.
 */
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}/g;

const MAILTO_PATTERN = /mailto:([^"'?\s>]+)/gi;

/** Local parts that are never a person, in descending order of uselessness. */
const NOISE_LOCAL_PARTS = new Set([
  "noreply",
  "no-reply",
  "donotreply",
  "do-not-reply",
  "example",
  "email",
  "your-email",
  "youremail",
  "name",
  "user",
  "username",
  "test",
  "sentry",
  "wordpress",
]);

/** Domains that belong to a platform, not to the business. */
const NOISE_DOMAINS = [
  "example.com",
  "example.org",
  "example.net",
  "domain.com",
  "yourdomain.com",
  "sentry.io",
  "wixpress.com",
  "godaddy.com",
  "squarespace.com",
  "shopify.com",
  "cloudflare.com",
  "googlemail.com",
  "schema.org",
  "w3.org",
  "sentry-cdn.com",
];

/** Local parts a business publishes on purpose, best first. */
const ROLE_PRIORITY = [
  "info",
  "contact",
  "hello",
  "sales",
  "enquiries",
  "inquiries",
  "orders",
  "office",
  "admin",
  "support",
  "mail",
];

/** File extensions that mean this was an image, not an address. */
const FILE_SUFFIX = /\.(png|jpe?g|gif|webp|svg|css|js|woff2?|ttf|ico|mp4|pdf)$/i;

export function normalizeEmail(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^mailto:/, "")
    .replace(/[.,;:)\]]+$/, "");
}

export function isPlausibleEmail(email: string): boolean {
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,24}$/i.test(email)) return false;
  if (FILE_SUFFIX.test(email)) return false;
  if (email.length > 254) return false;

  const [local, domain] = email.split("@");
  if (!local || !domain) return false;
  if (local.length > 64) return false;

  // Long hex-ish local parts are hashes, tracking ids and minified symbols.
  if (/^[0-9a-f]{16,}$/i.test(local)) return false;

  if (NOISE_LOCAL_PARTS.has(local)) return false;
  if (NOISE_DOMAINS.some((noise) => domain === noise || domain.endsWith(`.${noise}`))) return false;

  return true;
}

/**
 * How much to trust an address, 0..1.
 *
 * The single strongest signal is whether the address is ON the business's own
 * domain. `info@bayoucityembroidery.com` found on bayoucityembroidery.com is
 * almost certainly right; a gmail address on the same page might be the owner's
 * or might be their web designer's.
 */
export function scoreCandidate(
  email: string,
  args: { siteDomain: string | null; fromMailto: boolean },
): number {
  const domain = email.split("@")[1] ?? "";
  const local = email.split("@")[0] ?? "";

  let score = 0.4;

  if (args.siteDomain) {
    const site = args.siteDomain.replace(/^www\./, "");
    if (domain === site || domain.endsWith(`.${site}`) || site.endsWith(`.${domain}`)) {
      score += 0.35;
    }
  }

  // A `mailto:` is a link the site owner wrote for a human to click. Plain text
  // in the page body might be anything.
  if (args.fromMailto) score += 0.15;

  const roleIndex = ROLE_PRIORITY.indexOf(local);
  if (roleIndex >= 0) score += 0.1 - roleIndex * 0.005;

  return Math.min(Math.round(score * 1000) / 1000, 0.95);
}

export type ExtractOptions = {
  /** The business's own domain, used to score an address as first-party. */
  siteDomain: string | null;
  /** Where this HTML came from, recorded on each candidate. */
  sourceUrl: string;
};

/**
 * Every plausible address on a page, best first.
 *
 * `mailto:` hrefs are collected separately from body text because the
 * distinction is a real confidence signal, not a parsing convenience.
 */
export function extractEmails(html: string, options: ExtractOptions): EmailCandidate[] {
  const byEmail = new Map<string, EmailCandidate>();

  const add = (raw: string, fromMailto: boolean) => {
    const email = normalizeEmail(raw);
    if (!isPlausibleEmail(email)) return;

    const confidence = scoreCandidate(email, { siteDomain: options.siteDomain, fromMailto });
    const existing = byEmail.get(email);

    if (!existing || existing.confidence < confidence) {
      byEmail.set(email, {
        email,
        confidence,
        source: options.sourceUrl,
        // Nothing here VERIFIES an address. Verification means asking a mail
        // server, which this provider does not do, so it always reports false
        // rather than implying a check it never made.
        verified: false,
        meta: { fromMailto },
      });
    }
  };

  // Entities are decoded BEFORE matching, not after. `info&#64;bayoucity.test`
  // is a common cheap obfuscation, and it contains no literal "@" — so a
  // pattern run over the raw HTML never sees an address there at all. Decoding
  // the match afterwards is too late, because there was no match to decode.
  const decoded = decodeEntities(html);

  for (const match of decoded.matchAll(MAILTO_PATTERN)) add(match[1], true);

  // Scripts and styles are where the tracking ids and minified symbols live.
  const visible = decoded
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ");

  for (const match of visible.matchAll(EMAIL_PATTERN)) add(match[0], false);

  return [...byEmail.values()].sort((a, b) => b.confidence - a.confidence);
}

/** The handful of entities that actually show up inside obfuscated addresses. */
function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&amp;/gi, "&")
    .replace(/&#64;|&commat;/gi, "@")
    .replace(/&#46;|&period;/gi, ".");
}
