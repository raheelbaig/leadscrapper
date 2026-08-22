import { describe, expect, it, vi } from "vitest";

import { EmailEnrichmentService } from "./email-enrichment-service";
import { extractEmails, isPlausibleEmail, scoreCandidate } from "./providers/extract-emails";
import { WebsiteEmailProvider } from "./providers/website-provider";
import {
  domainOf,
  parseRobots,
  robotsAllows,
  USER_AGENT,
  validateUrl,
} from "./providers/website-fetcher";

/**
 * The website email provider.
 *
 * EVERY test here injects `fetchImpl`. The global `fetch` is replaced by a
 * throwing guard in `src/test/setup.ts`, so a test that forgot would fail
 * loudly rather than quietly reaching somebody's website — which is the
 * property that lets this suite exist at all while the standing rule is zero
 * real external requests.
 */

const noSleep = async () => {};

/** A fake site: a map of path -> response. Anything else is a 404. */
function fakeSite(
  pages: Record<string, { body?: string; status?: number; headers?: Record<string, string> }>,
) {
  const calls: string[] = [];

  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url.pathname);

    const page = pages[url.pathname];
    if (!page) {
      return new Response("not found", { status: 404 });
    }

    return new Response(page.body ?? "", {
      status: page.status ?? 200,
      headers: { "content-type": "text/html", ...(page.headers ?? {}) },
    });
  });

  return { fetchImpl: fetchImpl as unknown as typeof globalThis.fetch, calls };
}

function input(website: string | null = "https://bayoucity.test") {
  return {
    leadId: "lead-1",
    businessName: "Bayou City Embroidery",
    website,
    domain: website ? domainOf(website) : null,
    city: "Houston",
    country: "USA",
  };
}

describe("URL validation refuses what a server must not fetch", () => {
  it("accepts an ordinary business site", () => {
    expect(validateUrl("https://bayoucity.test/")).toHaveProperty("url");
    expect(validateUrl("http://bayoucity.test/")).toHaveProperty("url");
  });

  it("refuses non-HTTP protocols", () => {
    for (const url of ["file:///etc/passwd", "ftp://host/x", "data:text/html,hi"]) {
      expect(validateUrl(url)).toHaveProperty("reason");
    }
  });

  it("refuses loopback and private addresses", () => {
    for (const host of [
      "http://localhost/",
      "http://127.0.0.1/",
      "http://10.0.0.5/",
      "http://192.168.1.1/",
      "http://172.16.0.1/",
      "http://[::1]/",
    ]) {
      expect(validateUrl(host)).toHaveProperty("reason");
    }
  });

  it("refuses the cloud metadata endpoints", () => {
    // This process holds a service-role key. A fetcher that will retrieve any
    // URL handed to it is a credential-exfiltration primitive without this.
    expect(validateUrl("http://169.254.169.254/latest/meta-data/")).toHaveProperty("reason");
    expect(validateUrl("http://metadata.google.internal/")).toHaveProperty("reason");
  });
});

describe("email extraction", () => {
  it("finds a mailto address and scores it above body text", () => {
    const html = `<a href="mailto:info@bayoucity.test">Email us</a> or write to hello@other.test`;
    const found = extractEmails(html, { siteDomain: "bayoucity.test", sourceUrl: "https://x/" });

    expect(found[0].email).toBe("info@bayoucity.test");
    expect(found[0].confidence).toBeGreaterThan(found[1].confidence);
  });

  it("rejects platform noise and placeholders", () => {
    for (const email of [
      "noreply@bayoucity.test",
      "you@example.com",
      "name@yourdomain.com",
      "abc123@sentry.io",
      "logo@2x.png",
    ]) {
      expect(isPlausibleEmail(email)).toBe(false);
    }
  });

  it("ignores addresses inside script and style blocks", () => {
    const html = `<script>var t="tracking@sentry.io";var u="a1b2c3d4e5f60718@cdn.test";</script>
                  <p>info@bayoucity.test</p>`;
    const found = extractEmails(html, { siteDomain: "bayoucity.test", sourceUrl: "https://x/" });

    expect(found.map((c) => c.email)).toEqual(["info@bayoucity.test"]);
  });

  it("decodes an obfuscated address", () => {
    const html = `<p>info&#64;bayoucity&#46;test</p>`;
    const found = extractEmails(html, { siteDomain: "bayoucity.test", sourceUrl: "https://x/" });

    expect(found[0].email).toBe("info@bayoucity.test");
  });

  it("scores a first-party address above a third-party one", () => {
    const first = scoreCandidate("info@bayoucity.test", {
      siteDomain: "bayoucity.test",
      fromMailto: true,
    });
    const third = scoreCandidate("someone@gmail.com", {
      siteDomain: "bayoucity.test",
      fromMailto: true,
    });

    expect(first).toBeGreaterThan(third);
  });

  it("never claims an address is verified", () => {
    // Nothing here asks a mail server anything, so nothing may say it did.
    const found = extractEmails(`<a href="mailto:info@bayoucity.test">x</a>`, {
      siteDomain: "bayoucity.test",
      sourceUrl: "https://x/",
    });

    expect(found.every((c) => c.verified === false)).toBe(true);
    expect(found[0].confidence).toBeLessThan(1);
  });
});

describe("robots.txt is honoured", () => {
  it("parses a disallow that applies to us", () => {
    const robots = parseRobots("User-agent: *\nDisallow: /private\nDisallow: /admin");
    expect(robotsAllows(robots, "/private")).toBe(false);
    expect(robotsAllows(robots, "/contact")).toBe(true);
  });

  it("treats a blanket disallow as covering everything", () => {
    const robots = parseRobots("User-agent: *\nDisallow: /");
    expect(robotsAllows(robots, "/contact")).toBe(false);
  });

  it("ignores rules aimed at a different crawler", () => {
    const robots = parseRobots("User-agent: SomeOtherBot\nDisallow: /");
    expect(robotsAllows(robots, "/contact")).toBe(true);
  });

  it("stops the provider before it reads a disallowed site", async () => {
    const site = fakeSite({
      "/robots.txt": { body: "User-agent: *\nDisallow: /" },
      "/": { body: `<a href="mailto:info@bayoucity.test">x</a>` },
    });

    const provider = new WebsiteEmailProvider({ fetchImpl: site.fetchImpl, sleep: noSleep });
    const result = await provider.find(input());

    expect(result.status).toBe("not_found");
    // robots.txt only. The homepage was never requested.
    expect(site.calls).toEqual(["/robots.txt"]);
  });
});

describe("the provider", () => {
  it("identifies itself honestly", async () => {
    const site = fakeSite({ "/": { body: "<p>info@bayoucity.test</p>" } });
    const provider = new WebsiteEmailProvider({ fetchImpl: site.fetchImpl, sleep: noSleep });
    await provider.find(input());

    const call = (site.fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = (call[1] as RequestInit).headers as Record<string, string>;

    expect(headers["user-agent"]).toBe(USER_AGENT);
    expect(USER_AGENT).toMatch(/LeadScrapperBot/);
  });

  it("finds a first-party address on the homepage and stops early", async () => {
    const site = fakeSite({
      "/": { body: `<a href="mailto:info@bayoucity.test">Contact</a>` },
      "/contact": { body: `<p>other@bayoucity.test</p>` },
    });

    const provider = new WebsiteEmailProvider({ fetchImpl: site.fetchImpl, sleep: noSleep });
    const result = await provider.find(input());

    expect(result.status).toBe("found");
    expect(result.candidates[0].email).toBe("info@bayoucity.test");
    // robots.txt + homepage. It did not keep crawling after a confident hit.
    expect(site.calls).toEqual(["/robots.txt", "/"]);
  });

  it("falls through to the contact page when the homepage has nothing", async () => {
    const site = fakeSite({
      "/": { body: "<p>Welcome to our shop</p>" },
      "/contact": { body: `<a href="mailto:hello@bayoucity.test">Email</a>` },
    });

    const provider = new WebsiteEmailProvider({ fetchImpl: site.fetchImpl, sleep: noSleep });
    const result = await provider.find(input());

    expect(result.status).toBe("found");
    expect(result.candidates[0].email).toBe("hello@bayoucity.test");
    expect(site.calls).toContain("/contact");
  });

  it("reports not_found after actually reading the site", async () => {
    const site = fakeSite({ "/": { body: "<p>Call us on 713-555-0100</p>" } });
    const provider = new WebsiteEmailProvider({ fetchImpl: site.fetchImpl, sleep: noSleep });

    const result = await provider.find(input());

    // Looked and found nothing -- a different fact from never having looked.
    expect(result.status).toBe("not_found");
    expect(result.candidates).toEqual([]);
  });

  it("reports failed when no page could be read at all", async () => {
    const site = fakeSite({});
    const provider = new WebsiteEmailProvider({ fetchImpl: site.fetchImpl, sleep: noSleep });

    const result = await provider.find(input());
    expect(result.status).toBe("failed");
  });

  it("never fetches more than four pages of one site", async () => {
    const site = fakeSite({
      "/": { body: "<p>nothing</p>" },
      "/contact": { body: "<p>nothing</p>" },
      "/contact-us": { body: "<p>nothing</p>" },
      "/about": { body: "<p>nothing</p>" },
      "/team": { body: `<a href="mailto:deep@bayoucity.test">x</a>` },
    });

    const provider = new WebsiteEmailProvider({ fetchImpl: site.fetchImpl, sleep: noSleep });
    await provider.find(input());

    // robots.txt plus at most four pages. It is not a crawler.
    expect(site.calls.filter((p) => p !== "/robots.txt").length).toBeLessThanOrEqual(4);
    expect(site.calls).not.toContain("/team");
  });

  it("declines a lead with no website without making any request", async () => {
    const site = fakeSite({ "/": { body: "x" } });
    const provider = new WebsiteEmailProvider({ fetchImpl: site.fetchImpl, sleep: noSleep });

    expect(provider.canHandle(input(null))).toBe(false);
    const result = await provider.find(input(null));

    expect(result.status).toBe("not_found");
    expect(site.calls).toEqual([]);
  });

  it("declines a lead whose website is a private address", async () => {
    const site = fakeSite({});
    const provider = new WebsiteEmailProvider({ fetchImpl: site.fetchImpl, sleep: noSleep });

    expect(provider.canHandle(input("http://192.168.0.10/"))).toBe(false);
    const result = await provider.find(input("http://192.168.0.10/"));

    expect(result.status).toBe("failed");
    expect(site.calls).toEqual([]);
  });

  it("costs nothing", () => {
    const site = fakeSite({});
    const provider = new WebsiteEmailProvider({ fetchImpl: site.fetchImpl });

    expect(provider.costPerLookup()).toEqual({ sku: "website-scrape", units: 0 });
  });
});

describe("the enrichment service chain", () => {
  it("returns not_enriched when no provider is registered", async () => {
    // The inert default. "Nothing was attempted" is not "nothing was found".
    const service = new EmailEnrichmentService();
    expect(service.registered).toEqual([]);

    const result = await service.enrich(input());
    expect(result.status).toBe("not_enriched");
  });

  it("returns not_found for a lead with no website, without asking a provider", async () => {
    const site = fakeSite({});
    const service = new EmailEnrichmentService();
    service.register(new WebsiteEmailProvider({ fetchImpl: site.fetchImpl, sleep: noSleep }));

    const result = await service.enrich(input(null));

    expect(result.status).toBe("not_found");
    expect(site.calls).toEqual([]);
  });

  it("runs the registered provider and returns its find", async () => {
    const site = fakeSite({ "/": { body: `<a href="mailto:info@bayoucity.test">x</a>` } });
    const service = new EmailEnrichmentService();
    service.register(new WebsiteEmailProvider({ fetchImpl: site.fetchImpl, sleep: noSleep }));

    const result = await service.enrich(input());

    expect(service.registered).toEqual(["website"]);
    expect(result.status).toBe("found");
    expect(result.candidates[0].email).toBe("info@bayoucity.test");
  });

  it("reports a throwing provider rather than swallowing it into not_found", async () => {
    const service = new EmailEnrichmentService();
    service.register({
      name: "broken",
      order: 0,
      costPerLookup: () => ({ sku: "x", units: 0 }),
      canHandle: () => true,
      find: async () => {
        throw new Error("upstream exploded");
      },
    });

    const result = await service.enrich(input());

    expect(result.status).toBe("failed");
    expect(result.error).toContain("upstream exploded");
  });
});
