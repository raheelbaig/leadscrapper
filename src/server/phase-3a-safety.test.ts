import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PLACES_FIELD_MASK, PLACES_FIELD_MASK_HEADER } from "@/lib/constants";

import { EXTERNAL_PROVIDERS_ENABLED, PERSIST_RESOLVED_LOCATIONS } from "./geo/resolver-config";
import { getPricingCatalog } from "./pricing/catalog.schema";
import { classify, isVerified } from "./pricing/pricing-service";
import { PHASE_3A_LIMITS } from "./search/limits";

/**
 * The Phase 3A safety envelope, expressed as tests.
 *
 * Phase 3A opens the door to a real Google request for the first time, so the
 * things that must NOT happen are now more interesting than the things that
 * must. Each rule below is checked against the source tree, because a call site
 * that exists can be reached by some path nobody thought of.
 *
 * Supersedes the Phase 2 zero-calls suite: `fetch` is now legal in exactly one
 * file, and the assertion is that it is still exactly one.
 */

const SRC = path.resolve(process.cwd(), "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(entry) ? [full] : [];
  });
}

const ALL_FILES = walk(SRC);
const rel = (file: string) => path.relative(process.cwd(), file).replace(/\\/g, "/");
const read = (file: string) => readFileSync(file, "utf8");

/**
 * Source with comments removed.
 *
 * Several rules below are about what the CODE does, and this file is heavily
 * commented -- a prose mention of "the enrichment subsystem" or of
 * `worker_config` is documentation, not a call. Scanning raw text made three of
 * these assertions fire on their own explanatory comments.
 */
const readCode = (file: string) =>
  read(file)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Test files and the test bootstrap are not application code. */
const isTest = (file: string) =>
  file.endsWith(".test.ts") || rel(file).startsWith("src/test/");

/** The single file allowed to name a Google endpoint. */
const URL_DECLARATION_FILE = "src/lib/constants.ts";
/** The single file allowed to send a request. */
const HTTP_CLIENT_FILE = "src/server/places/client.ts";
/** The single file allowed to read secrets from the environment. */
const ENV_FILE = "src/server/config/env.ts";

describe("the API key never reaches the browser", () => {
  it("is read from process.env in exactly one file", () => {
    const offenders = ALL_FILES.filter(
      (file) =>
        !isTest(file) &&
        rel(file) !== ENV_FILE &&
        /process\.env\.GOOGLE_MAPS_API_KEY/.test(read(file)),
    ).map(rel);

    expect(offenders).toEqual([]);
  });

  it("is never mentioned in client-side code", () => {
    // src/components, src/lib and src/hooks are bundled for the browser.
    const clientRoots = ["src/components/", "src/lib/", "src/hooks/"];
    const offenders = ALL_FILES.filter((file) => {
      const relative = rel(file);
      if (isTest(file)) return false;
      if (!clientRoots.some((root) => relative.startsWith(root))) return false;
      return /GOOGLE_MAPS_API_KEY|X-Goog-Api-Key/i.test(read(file));
    }).map(rel);

    expect(offenders).toEqual([]);
  });

  it("is never exposed under a NEXT_PUBLIC_ prefix", () => {
    const offenders = ALL_FILES.filter(
      (file) => !isTest(file) && /NEXT_PUBLIC_GOOGLE/i.test(read(file)),
    ).map(rel);

    expect(offenders).toEqual([]);
  });

  it("is not in .env.example, which is the tracked file", () => {
    const example = readFileSync(path.resolve(process.cwd(), ".env.example"), "utf8");
    const line = example.split(/\r?\n/).find((l) => l.startsWith("GOOGLE_MAPS_API_KEY"));
    // The key must be declared as a blank placeholder, never with a real value.
    expect(line ?? "GOOGLE_MAPS_API_KEY=").toMatch(/^GOOGLE_MAPS_API_KEY=\s*$|your|placeholder|xxx/i);
  });

  it("no client-side file imports the server tree", () => {
    const clientRoots = ["src/components/", "src/lib/", "src/hooks/"];
    const offenders = ALL_FILES.filter((file) => {
      const relative = rel(file);
      if (isTest(file)) return false;
      if (!clientRoots.some((root) => relative.startsWith(root))) return false;
      return /from\s+["']@\/server\//.test(read(file));
    }).map(rel);

    expect(offenders).toEqual([]);
  });
});

describe("there is exactly one outbound call site", () => {
  it("only the Places client calls fetch", () => {
    const offenders = ALL_FILES.filter((file) => {
      const relative = rel(file);
      if (isTest(file)) return false;
      if (relative === HTTP_CLIENT_FILE) return false;
      if (!relative.startsWith("src/server/") && !relative.startsWith("src/app/api/")) return false;
      return /\bfetch\s*\(/.test(read(file));
    }).map(rel);

    expect(offenders).toEqual([]);
  });

  it("only constants.ts names a Google endpoint", () => {
    const offenders = ALL_FILES.filter(
      (file) =>
        !isTest(file) && rel(file) !== URL_DECLARATION_FILE && /googleapis\.com/.test(read(file)),
    ).map(rel);

    expect(offenders).toEqual([]);
  });

  it("the Places client is the only importer of the Text Search URL", () => {
    const importers = ALL_FILES.filter((file) => {
      const relative = rel(file);
      if (isTest(file) || relative === URL_DECLARATION_FILE) return false;
      return /PLACES_TEXT_SEARCH_URL/.test(read(file));
    }).map(rel);

    // The tile runner uses it as a label for the audit log; the client sends to
    // it. Nothing else may touch it.
    expect(importers.sort()).toEqual(
      ["src/server/places/client.ts", "src/server/search/tile-runner.ts"].sort(),
    );
  });
});

describe("no Geocoding call is possible", () => {
  it("keeps the external bbox providers disabled", () => {
    expect(EXTERNAL_PROVIDERS_ENABLED).toBe(false);
    expect(PERSIST_RESOLVED_LOCATIONS).toBe(false);
  });

  it("the Geocoding and Places-viewport providers are still empty stubs", () => {
    for (const stub of [
      "src/server/geo/providers/geocoding-provider.ts",
      "src/server/geo/providers/places-viewport-provider.ts",
    ]) {
      const source = readFileSync(path.resolve(process.cwd(), stub), "utf8");
      expect(source).not.toMatch(/\bfetch\s*\(/);
      expect(source).not.toMatch(/https?:\/\//);
    }
  });
});

describe("no email enrichment happens", () => {
  it("names no email provider anywhere in the source", () => {
    const providers = /\b(hunter\.io|snov\.io|apollo\.io|clearbit|dropcontact|neverbounce|zerobounce)\b/i;
    const offenders = ALL_FILES.filter((file) => !isTest(file) && providers.test(read(file))).map(
      rel,
    );

    expect(offenders).toEqual([]);
  });

  it("keeps the search path free of enrichment imports", () => {
    // Also enforced by ESLint, but asserted here so the guarantee survives a
    // change to the lint config.
    const searchRoots = [
      "src/server/places/",
      "src/server/search/",
      "src/server/geo/",
    ];
    const offenders = ALL_FILES.filter((file) => {
      const relative = rel(file);
      if (isTest(file)) return false;
      if (!searchRoots.some((root) => relative.startsWith(root))) return false;
      // An IMPORT of the enrichment subsystem, not a comment mentioning it.
      return /from\s+["'][^"']*enrichment/.test(readCode(file));
    }).map(rel);

    expect(offenders).toEqual([]);
  });

  it("the lead mapper writes no email column", () => {
    // The database CHECK `leads_email_null_until_enriched` is the real guard;
    // this makes the intent visible at the mapping layer too.
    const source = readFileSync(
      path.resolve(process.cwd(), "src/server/places/lead-mapper.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/email_status\s*:/);
    expect(source).not.toMatch(/\bemail\s*:/);
  });
});

describe("the worker does not start itself", () => {
  it("has no /api/jobs route to be triggered", () => {
    const jobRoutes = ALL_FILES.filter((file) => rel(file).startsWith("src/app/api/jobs"));
    expect(jobRoutes).toEqual([]);
  });

  it("no application code writes worker_config", () => {
    const offenders = ALL_FILES.filter(
      (file) => !isTest(file) && /worker_config/.test(readCode(file)),
    ).map(rel);

    expect(offenders).toEqual([]);
  });

  it("ships no migration that enables the worker", () => {
    const migrations = path.resolve(process.cwd(), "supabase/migrations");
    const offenders = readdirSync(migrations)
      .filter((name) => name.endsWith(".sql"))
      .filter((name) => {
        const sql = readFileSync(path.join(migrations, name), "utf8");
        return /enabled\s*=\s*true|set\s+enabled\s*=\s*true/i.test(sql);
      });

    expect(offenders).toEqual([]);
  });
});

describe("the Phase 3A limits are at their safe values", () => {
  it("allows one tile and one page", () => {
    expect(PHASE_3A_LIMITS.maxSeedTiles).toBe(1);
    expect(PHASE_3A_LIMITS.maxPagesPerTile).toBe(1);
  });

  it("caps the test area well below a city", () => {
    // Houston's full bbox is roughly 3,700 km2.
    expect(PHASE_3A_LIMITS.maxAreaKm2).toBeLessThanOrEqual(25);
  });

  it("caps the target at a handful of leads", () => {
    expect(PHASE_3A_LIMITS.maxTargetLeads).toBeLessThanOrEqual(20);
  });

  it("bounds the retries, so one page can never become many calls", () => {
    expect(PHASE_3A_LIMITS.maxAttemptsPerPage).toBeLessThanOrEqual(3);
    expect(
      PHASE_3A_LIMITS.maxSeedTiles *
        PHASE_3A_LIMITS.maxPagesPerTile *
        PHASE_3A_LIMITS.maxAttemptsPerPage,
    ).toBeLessThanOrEqual(PHASE_3A_LIMITS.maxCallsPerTick);
  });
});

describe("the billing surface has not changed", () => {
  it("still sends exactly the approved field mask", () => {
    expect(PLACES_FIELD_MASK_HEADER).toBe(
      "places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber," +
        "places.internationalPhoneNumber,places.websiteUri,places.location,places.googleMapsUri," +
        "nextPageToken",
    );
  });

  it("still bills at Enterprise, derived rather than assumed", () => {
    const classification = classify(PLACES_FIELD_MASK);
    expect(classification.sku).toBe("places-text-search-enterprise");
    // Every field is recognised, so the escalation signal stays available to
    // warn about a field Google adds later.
    expect(classification.escalatedForUnknown).toBe(false);
  });

  it("classifies the full header mask, pagination envelope included", () => {
    const classification = classify(PLACES_FIELD_MASK_HEADER.split(","));
    expect(classification.sku).toBe("places-text-search-enterprise");
    expect(classification.unknownFields).toEqual([]);
  });

  it("is verified against Google billing, which is what unlocks the gate", () => {
    // Approved by the account owner on 2026-08-21. Until then both the
    // pre-flight and the reserve guard refused every request, which is what
    // kept the first real call behind a human decision rather than a default.
    expect(isVerified()).toBe(true);
  });

  it("still holds the exact figures that were approved", () => {
    // The gate is open now, so these numbers decide what may actually be spent.
    // Pinned here so a later edit fails the build instead of quietly widening
    // the budget every request is checked against.
    const catalog = getPricingCatalog();

    expect(catalog.skus["places-text-search-enterprise"]).toMatchObject({
      freeCallsPerMonth: 1000,
      pricePer1000: 35,
    });
    expect(catalog.skus["places-text-search-pro"]).toMatchObject({
      freeCallsPerMonth: 5000,
      pricePer1000: 32,
    });
    expect(catalog.skus["places-text-search-essentials"]).toMatchObject({
      freeCallsPerMonth: 10_000,
      pricePer1000: 0,
    });
    expect(catalog.skus["geocoding-essentials"]).toMatchObject({
      freeCallsPerMonth: 10_000,
      pricePer1000: 5,
    });

    expect(catalog.billingTimezone).toBe("America/Los_Angeles");
    expect(catalog.safety).toMatchObject({
      reserveAbsolute: 50,
      reservePercent: 0.05,
      reserveMode: "max",
      countMode: "success-only",
    });
  });

  it("still maps nextPageToken at the tier that cannot escalate", () => {
    // Verified against Place Data Fields (New): Google assigns nextPageToken to
    // "Text Search Essentials (IDs Only)", so it participates in classification
    // but can never raise the tier above the Enterprise the phone and website
    // fields already trigger.
    const catalog = getPricingCatalog();
    const tier = catalog.fieldTiers.nextPageToken;

    expect(tier).toBe("places-text-search-essentials");
    expect(catalog.skus[tier].tierRank).toBe(1);
    expect(classify(["nextPageToken"]).sku).toBe(tier);
  });

  it("has no paid mode to switch to", () => {
    const offenders = ALL_FILES.filter(
      (file) => !isTest(file) && /\b(paidMode|allowPaid|enablePaid|billingEnabled)\b/.test(read(file)),
    ).map(rel);

    expect(offenders).toEqual([]);
  });
});
