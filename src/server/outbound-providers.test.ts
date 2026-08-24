import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { GEOCODING_URL } from "@/lib/constants";

/**
 * Every outbound request this product makes, kept explicit.
 *
 * ---------------------------------------------------------------------------
 * THE FIVE CATEGORIES, AND WHICH ARE REAL.
 *
 *   1. Google Places      -- REAL. `src/server/places/client.ts`, reached only
 *                            from `src/server/search/tile-runner.ts`. Billable.
 *   2. Geocoding          -- NOT IN PRODUCTION. The provider file contains no
 *                            URL and no fetch, and the resolver skips it while
 *                            `EXTERNAL_PROVIDERS_ENABLED` is false.
 *   3. Business websites  -- REAL. `website-fetcher.ts`, reached only through
 *                            the enrichment provider. Free, and NOT Google.
 *   4. Third-party email  -- DOES NOT EXIST. No Hunter/Snov/Apollo/etc.
 *   5. Supabase/internal  -- the database client, Storage reads, Realtime and
 *                            this application's own routes calling each other.
 *                            Not product API usage and never counted as such.
 *
 * So exactly TWO external provider categories exist in production today:
 * Google Places, and the businesses' own websites. These assertions are what
 * make adding a third a deliberate act rather than an accident.
 * ---------------------------------------------------------------------------
 */

const ROOT = process.cwd();
const SRC = path.resolve(ROOT, "src");

function read(relative: string): string {
  return readFileSync(path.resolve(ROOT, relative), "utf8");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const PRODUCTION_SOURCES = walk(SRC).filter(
  (file) =>
    !file.endsWith(".test.ts") &&
    !file.endsWith(".test.tsx") &&
    // `src/test/` is the harness -- stub env values and the Google observer.
    // It ships in no bundle and makes no request.
    !relativeOf(file).startsWith("src/test/"),
);

function relativeOf(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

const relative = relativeOf;

describe("external hosts", () => {
  it("names only Google Places and Geocoding as absolute external URLs", () => {
    const hosts = new Set<string>();

    for (const file of PRODUCTION_SOURCES) {
      const source = read(relative(file));
      for (const match of source.matchAll(/https?:\/\/([a-zA-Z0-9.-]+)/g)) {
        const host = match[1];
        // Loopback, docs links, schema URLs and the blocked-range constant are
        // not outbound providers.
        if (/^(localhost|127\.|169\.254\.|0\.0\.0\.0)/.test(host)) continue;
        if (/(w3\.org|schema|example\.(com|invalid|org))/.test(host)) continue;
        hosts.add(host);
      }
    }

    // Supabase is reached through the SDK using an env var, so it never appears
    // as a literal. What is hard-coded is exactly the two Google endpoints.
    expect([...hosts].sort()).toEqual(["maps.googleapis.com", "places.googleapis.com"]);
  });

  it("keeps the Places endpoint reachable from exactly one client", () => {
    // The URL is never written as a literal outside the constants file, so the
    // meaningful question is who imports it.
    const importers = PRODUCTION_SOURCES.filter((file) => {
      const rel = relative(file);
      if (rel === "src/lib/constants.ts") return false;
      return /PLACES_TEXT_SEARCH_URL/.test(read(rel));
    })
      .map(relative)
      .sort();

    // `client.ts` builds the request. `tile-runner.ts` only uses it as the
    // endpoint LABEL it writes to the billing ledger -- it issues nothing.
    expect(importers).toEqual(["src/server/places/client.ts", "src/server/search/tile-runner.ts"]);
    expect(read("src/server/search/tile-runner.ts")).toMatch(
      /const ENDPOINT_LABEL = PLACES_TEXT_SEARCH_URL/,
    );
  });

  it("reaches a host this product does not own from exactly two server files", () => {
    // Scoped to src/server, which is where a request to somebody else's
    // infrastructure can originate. Client components only ever call this
    // application's own /api routes, and the export download route fetches a
    // signed Supabase Storage URL -- both are internal traffic, asserted below.
    /** `const doFetch = options.fetchImpl ?? fetch` -- the Places client. */
    const FALLS_BACK_TO_GLOBAL_FETCH = /\?\?\s*fetch/;
    /** `await options.fetchImpl(url, ...)` -- the website reader. */
    const CALLS_INJECTED_FETCH = /options\.fetchImpl\(/;

    const outbound = PRODUCTION_SOURCES.filter((file) => {
      const rel = relative(file);
      if (!rel.startsWith("src/server/")) return false;
      const source = read(rel);
      return FALLS_BACK_TO_GLOBAL_FETCH.test(source) || CALLS_INJECTED_FETCH.test(source);
    })
      .map(relative)
      .sort();

    expect(outbound).toEqual([
      "src/server/enrichment/providers/website-fetcher.ts",
      "src/server/places/client.ts",
    ]);
  });

  it("keeps the export download an internal Supabase read, not a provider call", () => {
    const route = read("src/app/api/exports/[id]/download/route.ts");
    const service = read("src/server/export/export-service.ts");

    // The bytes come from the Storage SDK, so the route adds NO fetch call
    // site. An unrestricted server-side fetcher in a process holding a
    // service-role key is a credential-exfiltration primitive, and reading our
    // own object store is not a reason to widen that allow-list.
    expect(route).toMatch(/getExportFile/);
    expect(route).not.toMatch(/fetch\(/);
    expect(route).not.toMatch(/googleapis\.com/);

    // And the read itself goes through the SDK against the private bucket.
    expect(service).toMatch(/\.storage\s*\n?\s*\.from\(EXPORTS_BUCKET\)\s*\n?\s*\.download\(/);
  });

  it("lets client components call only this application's own routes", () => {
    const offenders: string[] = [];

    for (const file of PRODUCTION_SOURCES) {
      const rel = relative(file);
      if (!rel.startsWith("src/components/") && !rel.startsWith("src/lib/")) continue;

      for (const match of read(rel).matchAll(/fetch\(\s*[`"']([^`"']+)/g)) {
        const target = match[1];
        // Relative paths only. An absolute URL here would be the browser
        // talking to somebody else directly.
        if (!target.startsWith("/api/")) offenders.push(`${rel}: ${target}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("never builds a Geocoding request anywhere in production code", () => {
    const users = PRODUCTION_SOURCES.filter((file) => {
      const rel = relative(file);
      if (rel === "src/lib/constants.ts") return false;
      // The state builder counts geocoding rows in the billing ledger; that is
      // a READ of history, not a request. Anything else naming the endpoint
      // would be building one.
      if (rel === "src/server/generate/state.ts") return false;
      return read(rel).includes(GEOCODING_URL);
    }).map(relative);

    expect(users).toEqual([]);
  });

  it("keeps the geocoding provider free of a URL, a key and a fetch", () => {
    const provider = read("src/server/geo/providers/geocoding-provider.ts");
    expect(provider).not.toMatch(/googleapis\.com/);
    expect(provider).not.toMatch(/fetch\s*\(/);
    expect(provider).not.toMatch(/GOOGLE_MAPS_API_KEY/);
    // And the switch that keeps it unreachable is still off.
    expect(read("src/server/geo/resolver-config.ts")).toMatch(/EXTERNAL_PROVIDERS_ENABLED = false/);
  });
});

describe("third-party email providers", () => {
  it("does not exist anywhere in the tree", () => {
    const forbidden =
      /\b(hunter\.io|snov\.io|apollo\.io|clearbit|dropcontact|neverbounce|zerobounce|voilanorbert|findthatlead)\b/i;

    for (const file of PRODUCTION_SOURCES) {
      expect(read(relative(file))).not.toMatch(forbidden);
    }
  });

  it("registers exactly one enrichment provider, and it reads the lead's own site", () => {
    const provider = read("src/server/enrichment/providers/website-provider.ts");
    expect(provider).toMatch(/readonly name = "website"/);

    // The only files that may reach a non-Google host.
    const fetchers = PRODUCTION_SOURCES.filter((file) =>
      /providers\/website-fetcher/.test(relative(file)),
    ).map(relative);
    expect(fetchers).toEqual(["src/server/enrichment/providers/website-fetcher.ts"]);
  });
});

describe("request counting never conflates categories", () => {
  it("counts website checks from recorded attempts, not from a page-count formula", () => {
    const state = read("src/server/generate/state.ts");

    // Truthful telemetry: one row per business actually looked at.
    expect(state).toMatch(/websitesChecked/);
    expect(state).toMatch(/from\("lead_enrichment_attempts"\)/);

    // The forbidden shortcut: leads x pages, which would invent requests that
    // were never made.
    expect(state).not.toMatch(/websitesChecked[^;]*MAX_EXTERNAL_REQUESTS_PER_LEAD/);
    expect(state).not.toMatch(/websitesChecked[^;]*\*\s*\d/);
  });

  it("reports the full free allowance in the header, not the protected figure", () => {
    const header = read("src/components/layout/quota-indicator.tsx");

    // `effectiveLimit` is the allowance minus an internal reserve. Showing it as
    // the denominator is what produced the meaningless "188 / 950".
    expect(header).toMatch(/primary\.freeLimit/);
    expect(header).not.toMatch(/\/ \{formatNumber\(primary\.effectiveLimit\)\}/);
    // And it says whose API it is.
    expect(header).toMatch(/>Google</);
  });

  it("never counts Supabase or internal traffic as provider usage", () => {
    const state = read("src/server/generate/state.ts");

    // The request figures come from the billing ledger and the attempts table.
    // Nothing counts database round trips, storage reads or realtime messages.
    expect(state).not.toMatch(/supabaseRequests|dbRequests|storageRequests|realtimeRequests/);

    // `api_call_log` is the billing ledger, and only Google endpoints are ever
    // written to it -- `record_api_call` is called from the Places path alone.
    // The CALL form, not the identifier -- the generated types name every RPC
    // and several modules mention it in comments.
    const recorders = PRODUCTION_SOURCES.filter((file) =>
      /\.rpc\(\s*"record_api_call"/.test(read(relative(file))),
    ).map(relative);
    expect(recorders).toEqual(["src/server/quota/quota-service.ts"]);
  });
});
