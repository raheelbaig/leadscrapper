import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  MAX_PAGES,
  PAGE_SIZE,
  PLACES_FIELD_MASK,
  PLACES_FIELD_MASK_HEADER,
  RESULT_CEILING,
} from "@/lib/constants";

import { EXTERNAL_PROVIDERS_ENABLED, PERSIST_RESOLVED_LOCATIONS } from "./geo/resolver-config";
import { getPricingCatalog } from "./pricing/catalog.schema";
import { classify, getSkuConfig, isVerified } from "./pricing/pricing-service";
import { PHASE_3B_LIMITS, maxTilesAfterSubdivision } from "./search/limits";

/**
 * The Phase 3B safety envelope, expressed as tests.
 *
 * Phase 3A opened the door to a real Google request. Phase 3B opens it to many:
 * three pages per tile, several tiles, recursive subdivision, and retries. The
 * things that must NOT happen therefore matter more, not less. Each rule below
 * is checked against the source tree, because a call site that exists can be
 * reached by some path nobody thought of.
 *
 * Supersedes the Phase 3A suite. Every prohibition it made is still made here;
 * only the limit values moved, and they moved deliberately and by approval.
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
const isTest = (file: string) => file.endsWith(".test.ts") || rel(file).startsWith("src/test/");

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
    expect(line ?? "GOOGLE_MAPS_API_KEY=").toMatch(
      /^GOOGLE_MAPS_API_KEY=\s*$|your|placeholder|xxx/i,
    );
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
    const providers =
      /\b(hunter\.io|snov\.io|apollo\.io|clearbit|dropcontact|neverbounce|zerobounce)\b/i;
    const offenders = ALL_FILES.filter((file) => !isTest(file) && providers.test(read(file))).map(
      rel,
    );

    expect(offenders).toEqual([]);
  });

  it("keeps the search path free of enrichment imports", () => {
    // Also enforced by ESLint, but asserted here so the guarantee survives a
    // change to the lint config.
    const searchRoots = ["src/server/places/", "src/server/search/", "src/server/geo/"];
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

describe("the Phase 3B limits are at their approved values", () => {
  it("allows a small multi-tile grid, not a city", () => {
    // The controlled band is 4-9 seed tiles.
    expect(PHASE_3B_LIMITS.maxSeedTiles).toBe(9);
    // Houston's full bbox is roughly 3,700 km2.
    expect(PHASE_3B_LIMITS.maxAreaKm2).toBeLessThanOrEqual(300);
  });

  it("caps the target inside the controlled band", () => {
    expect(PHASE_3B_LIMITS.maxTargetLeads).toBeLessThanOrEqual(50);
  });

  it("paginates to Google's ceiling and no further", () => {
    // 20 results x 3 pages = 60 per query. No parameter raises it, so asking
    // for a fourth page would be a wasted billable call.
    expect(PHASE_3B_LIMITS.maxPagesPerTile).toBe(MAX_PAGES);
    expect(PAGE_SIZE * PHASE_3B_LIMITS.maxPagesPerTile).toBe(RESULT_CEILING);
  });

  it("allows a bounded retry, raised deliberately from the Phase 3A cap of 1", () => {
    expect(PHASE_3B_LIMITS.maxAttemptsPerPage).toBe(3);
  });

  it("subdivides ONE level in the controlled run", () => {
    // Depth 1 exercises R4a (a parent splits into four) and R4b (a depth-1
    // child that saturates is at the floor) while keeping the geometric worst
    // case two orders of magnitude below what depth 3 permits. The engine
    // supports the production depth; only this phase is capped.
    expect(PHASE_3B_LIMITS.maxSubdivisionDepth).toBe(1);
  });

  it("processes one tile per press, so resume is auditable", () => {
    expect(PHASE_3B_LIMITS.maxTilesPerTick).toBe(1);
  });

  it("bounds a whole search with a hard call budget", () => {
    // THE ceiling for this phase. Geometry alone no longer bounds anything
    // once subdivision is in play, so a fixed number has to.
    expect(PHASE_3B_LIMITS.maxCallsPerSearch).toBe(40);
  });

  it("keeps the budget far below the protected free allowance", () => {
    // 40 of ~948 remaining. A run that goes completely wrong still cannot spend
    // a meaningful share of the month.
    const enterprise = getSkuConfig("places-text-search-enterprise");
    const protectedRemaining = enterprise.freeCallsPerMonth - enterprise.reserve;

    expect(PHASE_3B_LIMITS.maxCallsPerSearch / protectedRemaining).toBeLessThan(0.05);
  });

  it("caps one press at exactly what the other limits permit", () => {
    const perTickCeiling =
      PHASE_3B_LIMITS.maxTilesPerTick *
      PHASE_3B_LIMITS.maxPagesPerTile *
      PHASE_3B_LIMITS.maxAttemptsPerPage;

    expect(perTickCeiling).toBe(9);
    expect(perTickCeiling).toBeLessThan(PHASE_3B_LIMITS.maxCallsPerSearch);
    // Pinned to the DERIVED ceiling, not merely above it. Headroom here would
    // be spending that nothing accounts for the moment the tile cap is raised,
    // so raising maxTilesPerTick has to come back through this assertion.
    expect(PHASE_3B_LIMITS.maxCallsPerTick).toBe(perTickCeiling);
  });

  it("has a geometric worst case the budget genuinely has to cap", () => {
    // This is the whole reason the budget exists: the geometry alone permits
    // an order of magnitude more than the budget allows.
    const geometricMax =
      maxTilesAfterSubdivision(PHASE_3B_LIMITS.maxSeedTiles, PHASE_3B_LIMITS.maxSubdivisionDepth) *
      PHASE_3B_LIMITS.maxPagesPerTile *
      PHASE_3B_LIMITS.maxAttemptsPerPage;

    expect(geometricMax).toBe(9 * 5 * 3 * 3);
    expect(geometricMax).toBeGreaterThan(PHASE_3B_LIMITS.maxCallsPerSearch * 8);
  });

  it("gives a tick a wall-clock budget it can finish inside the route timeout", () => {
    expect(PHASE_3B_LIMITS.maxTickMs).toBeLessThan(60_000);
  });
});

describe("the phase limits are structural, not passed at call sites", () => {
  it("the run route hands the runner no options at all", () => {
    // The mistake that cost the project's first real Google call was a limit
    // enforced by remembering to pass an option. Every limit is now read from
    // PHASE_3B_LIMITS inside the runner, so no route, button or script can
    // widen one by forgetting.
    const route = readCode(path.resolve(process.cwd(), "src/app/api/searches/[id]/run/route.ts"));

    expect(route).toMatch(/runControlledTick\(\{\s*searchId: id,\s*userId: user\.id\s*\}\)/);
    expect(route).not.toMatch(/maxAttempts|maxPages|maxTilesPerTick|maxCallsPer/);
  });

  it("no API route takes a limit from the request", () => {
    // Referencing PHASE_3B_LIMITS in a route is fine and expected -- reading a
    // limit off the parsed request body is not. So the constant references are
    // removed first, and what is left must mention no limit at all.
    const routes = ALL_FILES.filter((file) => rel(file).startsWith("src/app/api/"));
    const offenders = routes
      .filter((file) => {
        const withoutConstants = readCode(file).replace(/PHASE_3B_LIMITS\.\w+/g, "");
        return /maxPages|maxAttempts|maxTilesPerTick|maxCallsPer/.test(withoutConstants);
      })
      .map(rel);

    expect(offenders).toEqual([]);
  });

  it("the create-search schema accepts no execution limit either", () => {
    // grid_config describes GEOMETRY, which the user may choose. How many pages,
    // retries or calls a run may spend is not geometry, and is not negotiable.
    const schema = readCode(path.resolve(process.cwd(), "src/lib/schemas/search.ts"));

    expect(schema).not.toMatch(/maxPagesPerTile|maxAttemptsPerPage|maxCallsPer|maxTilesPerTick/);
  });

  it("clamps every option against the phase cap rather than trusting it", () => {
    const runner = readCode(
      path.resolve(process.cwd(), "src/server/search/run-controlled-tick.ts"),
    ).replace(/\s+/g, " ");

    for (const limit of ["maxAttemptsPerPage", "maxPagesPerTile", "maxTilesPerTick"]) {
      // Math.min(option ?? CAP, CAP) -- so an option can only ever lower it.
      expect(runner).toContain(`?? PHASE_3B_LIMITS.${limit}, PHASE_3B_LIMITS.${limit},`);
    }
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
      (file) =>
        !isTest(file) && /\b(paidMode|allowPaid|enablePaid|billingEnabled)\b/.test(read(file)),
    ).map(rel);

    expect(offenders).toEqual([]);
  });
});
