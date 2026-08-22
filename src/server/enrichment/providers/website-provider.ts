import "server-only";

import type {
  EmailCandidate,
  EmailProvider,
  EnrichmentInput,
  EnrichmentResult,
  ProviderCost,
} from "../types";
import { extractEmails } from "./extract-emails";
import {
  domainOf,
  fetchPage,
  parseRobots,
  robotsAllows,
  validateUrl,
  type FetchImpl,
} from "./website-fetcher";

/**
 * The first — and currently only — email provider.
 *
 * The Google Places API returns no email address in any field, tier or
 * endpoint. `leads.website` is the only bridge it gives us from a place to a
 * possible contact address, so the first provider reads the business's own
 * public website. It calls no third-party email API, has no account, and costs
 * nothing: `costPerLookup()` reports zero units against a `website-scrape` SKU
 * so that a paid provider added later meters through the same quota service
 * rather than inventing its own accounting.
 *
 * At most FOUR pages per lead — the homepage plus the usual contact paths —
 * and it stops as soon as it has a first-party address it trusts. A crawler
 * this shallow is the point: the goal is the address the business publishes
 * for customers, not a survey of their site.
 *
 * `fetchImpl` is REQUIRED, never defaulted. Every test injects a stub, and no
 * code path can reach the network by forgetting to pass one.
 */

/** Tried in order after the homepage. Stops early on a confident hit. */
export const CONTACT_PATHS = ["/contact", "/contact-us", "/about"] as const;

/** Above this, an address is good enough to stop looking. */
export const CONFIDENT_ENOUGH = 0.75;

/** Politeness gap between requests to the same host. */
export const PER_HOST_DELAY_MS = 1_000;

export type WebsiteProviderOptions = {
  fetchImpl: FetchImpl;
  /** Injected in tests so politeness delays do not make suites slow. */
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  maxPages?: number;
};

export class WebsiteEmailProvider implements EmailProvider {
  readonly name = "website";
  /** Cheapest possible: it is the business's own site and costs nothing. */
  readonly order = 0;

  private readonly options: WebsiteProviderOptions;

  constructor(options: WebsiteProviderOptions) {
    this.options = options;
  }

  costPerLookup(): ProviderCost {
    return { sku: "website-scrape", units: 0 };
  }

  canHandle(input: EnrichmentInput): boolean {
    if (!input.website) return false;
    return !("reason" in validateUrl(input.website));
  }

  async find(input: EnrichmentInput): Promise<EnrichmentResult> {
    if (!input.website) {
      return { status: "not_found", candidates: [], error: "This lead has no website." };
    }

    const validated = validateUrl(input.website);
    if ("reason" in validated) {
      return {
        status: "failed",
        candidates: [],
        error: `Unusable website URL: ${validated.reason}`,
      };
    }

    const origin = validated.url.origin;
    const siteDomain = domainOf(input.website);
    const sleep = this.options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const maxPages = this.options.maxPages ?? 1 + CONTACT_PATHS.length;

    // ---- robots.txt, before anything else ------------------------------
    // A site that asks not to be read is not read. A MISSING or unreadable
    // robots.txt is treated as permissive, which is the standard reading; a
    // present one that disallows us ends the attempt without a second request.
    const robotsResponse = await fetchPage(`${origin}/robots.txt`, {
      fetchImpl: this.options.fetchImpl,
      timeoutMs: this.options.timeoutMs,
    });

    const robots = robotsResponse.ok ? parseRobots(robotsResponse.html) : { disallow: [] };

    const candidates: EmailCandidate[] = [];
    const errors: string[] = [];
    let pagesFetched = 0;
    let anyPageRead = false;
    let anyPathAllowed = false;

    const paths = [validated.url.pathname || "/", ...CONTACT_PATHS];

    for (const path of paths) {
      if (pagesFetched >= maxPages) break;

      if (!robotsAllows(robots, path)) {
        errors.push(`robots.txt disallows ${path}`);
        continue;
      }

      anyPathAllowed = true;

      if (pagesFetched > 0) await sleep(PER_HOST_DELAY_MS);

      const target = new URL(path, origin).toString();
      const page = await fetchPage(target, {
        fetchImpl: this.options.fetchImpl,
        timeoutMs: this.options.timeoutMs,
      });
      pagesFetched += 1;

      if (!page.ok) {
        // A 404 on /contact is entirely normal and is not an error worth
        // reporting; only the homepage failing tells us anything.
        if (path === paths[0]) errors.push(`${path}: ${page.reason}`);
        continue;
      }

      anyPageRead = true;
      candidates.push(...extractEmails(page.html, { siteDomain, sourceUrl: page.url }));

      const best = candidates.reduce((max, c) => Math.max(max, c.confidence), 0);
      if (best >= CONFIDENT_ENOUGH) break;
    }

    // Deduplicate across pages, keeping the highest-scoring sighting of each.
    const byEmail = new Map<string, EmailCandidate>();
    for (const candidate of candidates) {
      const existing = byEmail.get(candidate.email);
      if (!existing || existing.confidence < candidate.confidence)
        byEmail.set(candidate.email, candidate);
    }

    const ranked = [...byEmail.values()].sort((a, b) => b.confidence - a.confidence);

    if (ranked.length > 0) {
      // `found`, never `verified`. Verification means asking a mail server
      // whether the mailbox exists, and this provider does not do that. Saying
      // "verified" because a string was well-formed would be a lie the export
      // then carries into every later decision.
      return { status: "found", candidates: ranked };
    }

    // A site that declines to be read has not FAILED. Nothing broke, and
    // retrying will get the same answer, so `failed` would be wrong twice over:
    // it implies a fault, and it invites a pointless retry. The attempt is
    // recorded as `not_found` with the reason attached.
    if (!anyPathAllowed) {
      return {
        status: "not_found",
        candidates: [],
        error: "robots.txt disallows reading this site.",
      };
    }

    if (!anyPageRead) {
      return {
        status: "failed",
        candidates: [],
        error: errors.join("; ") || "No page could be read.",
      };
    }

    // Read the site, found nothing. A real answer, and a different one from
    // "never looked" -- which is why `not_enriched` is not returned here.
    return { status: "not_found", candidates: [] };
  }
}
