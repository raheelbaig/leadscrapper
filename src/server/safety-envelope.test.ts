import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_GRID_CONFIG,
  MAX_PAGES,
  PAGE_SIZE,
  PLACES_FIELD_MASK,
  PLACES_FIELD_MASK_HEADER,
  RESULT_CEILING,
} from "@/lib/constants";

import { MAX_ENRICHMENT_BATCH } from "./enrichment/run-enrichment";
import { EXTERNAL_PROVIDERS_ENABLED, PERSIST_RESOLVED_LOCATIONS } from "./geo/resolver-config";
import { getPricingCatalog } from "./pricing/catalog.schema";
import { classify, getSkuConfig, isVerified } from "./pricing/pricing-service";
import { SEARCH_LIMITS, maxTilesAfterSubdivision } from "./search/limits";

/**
 * The safety envelope, expressed as tests.
 *
 * Phase 3A opened the door to a real Google request. Phase 3B opened it to
 * many. Phase 4 removed the last thing that made a run stop early -- the lead
 * target -- and added a background worker and a second outbound host. The
 * things that must NOT happen therefore matter more at every step, not less.
 * Each rule below is checked against the source tree, because a call site that
 * exists can be reached by some path nobody thought of.
 *
 * Every prohibition the earlier phase suites made is still made here; only the
 * limit values have moved, and each move was deliberate and approved. Changing
 * one of them means changing an assertion in this file on purpose, which is the
 * whole point of pinning them.
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
/**
 * THE OUTBOUND ALLOW-LIST. Exactly two files may call `fetch`.
 *
 * An explicit list, never a general "fetch is allowed in src/server" rule: the
 * point is that adding a third outbound host requires editing this array on
 * purpose, in a diff someone reads.
 *
 *   1. The Places client — Google, the only billable destination.
 *   2. The website fetcher — a LEAD'S OWN public site, approved separately on
 *      2026-08-22 as the bridge from a place to an email address. It is the
 *      only non-Google host this application may ever contact, and it is
 *      wrapped in protocol, private-address, redirect, size and timeout limits
 *      because the URL came from a third party.
 */
const HTTP_CLIENT_FILES = [
  "src/server/places/client.ts",
  "src/server/enrichment/providers/website-fetcher.ts",
];
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

describe("the outbound call sites are an explicit allow-list", () => {
  it("only the two approved files call fetch", () => {
    const offenders = ALL_FILES.filter((file) => {
      const relative = rel(file);
      if (isTest(file)) return false;
      if (HTTP_CLIENT_FILES.includes(relative)) return false;
      if (!relative.startsWith("src/server/") && !relative.startsWith("src/app/api/")) return false;
      // `globalThis.fetch` passed as an argument is not a call site: the
      // enrichment route hands the platform fetch to the provider, which is
      // exactly how the injectable seam is supposed to work.
      return /\bfetch\s*\(/.test(readCode(file).replace(/globalThis\.fetch/g, ""));
    }).map(rel);

    expect(offenders).toEqual([]);
  });

  it("the allow-list is two entries and both exist", () => {
    // If this fails because a file moved, move the entry -- do not widen the
    // rule. A third entry is a decision, not a refactor.
    expect(HTTP_CLIENT_FILES).toHaveLength(2);
    for (const file of HTTP_CLIENT_FILES) {
      expect(ALL_FILES.map(rel)).toContain(file);
    }
  });

  it("the non-Google fetcher refuses private and metadata addresses", () => {
    const fetcher = readCode(
      path.resolve(process.cwd(), "src/server/enrichment/providers/website-fetcher.ts"),
    );

    // This process holds a service-role key; an unrestricted server-side
    // fetcher is a credential-exfiltration primitive without these.
    expect(fetcher).toContain("169");
    expect(fetcher).toContain("metadata.google.internal");
    expect(fetcher).toMatch(/redirect: "manual"/);
    expect(fetcher).toMatch(/isBlockedHost/);
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
    const searchRoots = [
      "src/server/places/",
      "src/server/search/",
      "src/server/geo/",
      "src/server/export/",
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

  it("defaults the enrichment run route to a dry run", () => {
    // The safe default is the one that makes no request. A caller that omits
    // `dryRun` must get the inert version, not the live one.
    const route = readCode(path.resolve(process.cwd(), "src/app/api/enrichment/run/route.ts"));
    expect(route).toMatch(/dryRun: z\.boolean\(\)\.default\(true\)/);

    // And the live fetch is only handed over when the run is explicitly live.
    expect(route).toMatch(/fetchImpl: parsed\.data\.dryRun \? undefined : globalThis\.fetch/);
  });

  it("refuses a live enrichment run with no explicit fetch implementation", () => {
    // No default parameter anywhere on this path: a forgotten stub has to be a
    // refusal, never a silent request to somebody's website.
    const runner = readCode(path.resolve(process.cwd(), "src/server/enrichment/run-enrichment.ts"));
    expect(runner).toMatch(/if \(!args\.fetchImpl\)/);
    expect(runner).toContain("Refusing to guess one.");
  });

  it("bounds an enrichment run to a small batch", () => {
    expect(MAX_ENRICHMENT_BATCH).toBeLessThanOrEqual(25);

    const runner = readCode(path.resolve(process.cwd(), "src/server/enrichment/run-enrichment.ts"));
    // Clamped on the server, so nothing the browser sends can widen it.
    expect(runner).toMatch(
      /Math\.min\(Math\.max\(args\.limit \?\? 10, 1\), MAX_ENRICHMENT_BATCH\)/,
    );
  });

  it("never claims an address was verified", () => {
    // Verification means asking a mail server. This provider reads a web page.
    const provider = readCode(
      path.resolve(process.cwd(), "src/server/enrichment/providers/website-provider.ts"),
    );
    expect(provider).not.toMatch(/status: "verified"/);

    const extractor = readCode(
      path.resolve(process.cwd(), "src/server/enrichment/providers/extract-emails.ts"),
    );
    expect(extractor).toMatch(/verified: false/);
    expect(extractor).not.toMatch(/verified: true/);
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
  /**
   * Phase 4C BUILT the worker endpoint, so "there is no route" is no longer
   * the guarantee. What keeps the worker off is now three independent facts,
   * each asserted below:
   *
   *   1. `private.worker_config.enabled` is false and no migration sets it.
   *   2. No application code can write that table -- `private` is not exposed
   *      through PostgREST, so there is no path to the switch at all.
   *   3. The route itself refuses every request unless WORKER_SECRET is set,
   *      and refuses rather than allows when it is not.
   */
  it("has exactly one worker route, and it is authenticated", () => {
    const jobRoutes = ALL_FILES.filter((file) => rel(file).startsWith("src/app/api/jobs")).map(rel);
    expect(jobRoutes).toEqual(["src/app/api/jobs/route.ts"]);

    const route = readCode(path.resolve(process.cwd(), "src/app/api/jobs/route.ts"));

    // Both verbs go through the same guard, and neither has a bypass.
    const guarded = route.match(
      /authenticateWorkerRequest\(request, process\.env\.WORKER_SECRET\)/g,
    );
    expect(guarded).toHaveLength(2);
    expect(route).not.toMatch(/NODE_ENV|localhost|skipAuth|allowUnauthenticated/);
  });

  it("closes the door when no secret is configured, rather than opening it", () => {
    const auth = readCode(path.resolve(process.cwd(), "src/server/worker/authenticate.ts"));

    // The inversion that makes a worker endpoint world-callable: an unset
    // secret must produce a refusal, never a pass.
    expect(auth).toMatch(/if \(!configuredSecret \|\| configuredSecret\.length < 16\)/);
    expect(auth).toContain("timingSafeEqual");

    const unconfigured = auth.slice(auth.indexOf("if (!configuredSecret"));
    const firstReturn = unconfigured.slice(0, unconfigured.indexOf("}"));
    expect(firstReturn).toContain("ok: false");
    expect(firstReturn).not.toContain("ok: true");

    // Exactly one success path, at the end, after every check has passed.
    // (The other `ok: true` in the file is the result type declaration.)
    expect(auth.match(/return \{ ok: true \}/g)).toHaveLength(1);
  });

  it("never lets the worker widen a limit", () => {
    const worker = readCode(path.resolve(process.cwd(), "src/server/worker/worker-tick.ts"));

    // Math.min against the shared caps, so the worker's ceiling is the Run
    // button's ceiling. It may take a smaller bite; it may not take a bigger one.
    expect(worker).toMatch(
      /Math\.min\(env\.WORKER_MAX_TILES_PER_TICK, SEARCH_LIMITS\.maxTilesPerTick\)/,
    );
    expect(worker).toMatch(/Math\.min\(env\.WORKER_SLICE_MS, SEARCH_LIMITS\.maxTickMs\)/);
  });

  it("runs the SAME tick as the Run button, not a second implementation", () => {
    const worker = readCode(path.resolve(process.cwd(), "src/server/worker/worker-tick.ts"));
    expect(worker).toContain("runControlledTick(");
  });

  it("does not self-chain", () => {
    // A chain is a latency optimisation. Correctness must never depend on one,
    // and a worker that re-triggers itself is a worker that can run away.
    const workerFiles = ALL_FILES.filter(
      (file) => !isTest(file) && rel(file).startsWith("src/server/worker/"),
    );

    for (const file of workerFiles) {
      expect(readCode(file)).not.toMatch(/WORKER_SELF_CHAIN|\bfetch\s*\(/);
    }
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

describe("the lead target cannot stop a search", () => {
  it("ships a default that runs to full coverage", () => {
    expect(DEFAULT_GRID_CONFIG.stopOnTargetReached).toBe(false);
  });

  it("has no `target_reached` stop reason left anywhere in the source", () => {
    // The identifier that used to map a target hit onto a `completed` status.
    // Its absence is the property; a grep is the only way to assert it, because
    // the bug it caused was a string flowing through four modules.
    const offenders = ALL_FILES.filter(
      (file) => !isTest(file) && /\btarget_reached\b/.test(readCode(file)),
    ).map(rel);

    expect(offenders).toEqual([]);
  });

  it("maps only coverage_complete to a completed status", () => {
    const completion = readCode(
      path.resolve(process.cwd(), "src/server/search/completion.ts"),
    ).replace(/\s+/g, " ");

    // The one line that decides whether a search is allowed to call itself
    // finished. Anything else reaching `completed` is the Phase 3B bug back.
    expect(completion).toContain('if (stop === "coverage_complete") return "completed";');
  });

  it("has no lead-target clause in the loop's stop decision", () => {
    // `nextStopReason` is the complete list of reasons a tile loop stops. The
    // only mention of the target in it is the frozen legacy policy, which maps
    // to a PAUSE. A comparison of leadsFound against the target anywhere else
    // would be the removed behaviour creeping back.
    const source = readCode(path.resolve(process.cwd(), "src/server/search/completion.ts"));
    const decision = source.slice(source.indexOf("export function nextStopReason"));

    const targetComparisons = decision.match(/leadsFound\s*>=\s*state\.targetLeads/g) ?? [];
    expect(targetComparisons).toHaveLength(1);
    expect(decision).toMatch(
      /state\.stopOnTargetReached && state\.leadsFound >= state\.targetLeads/,
    );
    expect(decision).toMatch(/return "stopped_at_target";/);
  });

  it("keeps the migration that flipped the stored default", () => {
    const sql = readFileSync(
      path.resolve(process.cwd(), "supabase/migrations/0013_stop_on_target_default.sql"),
      "utf8",
    );

    expect(sql).toMatch(/'stopOnTargetReached',\s*false/);
    // It must NOT rewrite the frozen definition of any existing search.
    expect(sql).not.toMatch(/update\s+public\.searches/i);
  });

  it("amends a frozen grid_config from exactly one place", () => {
    // Flipping the stop policy on an existing row is a user-triggered
    // amendment, never something a tick, a migration or a background job does.
    const offenders = ALL_FILES.filter((file) => {
      const relative = rel(file);
      if (isTest(file)) return false;
      if (relative === "src/server/search/manage-search.ts") return false;
      return (
        /stopOnTargetReached:\s*false/.test(readCode(file)) && !relative.endsWith("constants.ts")
      );
    }).map(rel);

    expect(offenders).toEqual([]);
  });
});

describe("the export never becomes a misleading artifact", () => {
  it("writes the Coverage worksheet unconditionally, with no early return", () => {
    const source = readCode(path.resolve(process.cwd(), "src/server/export/workbook.ts"));
    const builder = source.slice(source.indexOf("export async function buildWorkbook"));

    // Both sheets, every time. A conditional around the Coverage sheet would
    // let a partial export pass itself off as a complete survey of the area.
    expect(builder).toContain("buildLeadsSheet(workbook, args.leads);");
    expect(builder).toContain("buildCoverageSheet(workbook, args.coverage, args.meta);");
    expect(builder).not.toMatch(/if\s*\([^)]*fullyCovered/);
  });

  it("keeps exported workbooks in a private, per-user storage path", () => {
    const service = readCode(path.resolve(process.cwd(), "src/server/export/export-service.ts"));

    // migration 0008 authorises reads on (storage.foldername(name))[1] =
    // auth.uid(), so any other path shape would be unreadable by its owner --
    // and a public bucket would be readable by everyone.
    expect(service).toContain("`${args.userId}/${exportId}.xlsx`");
    expect(service).toContain("createSignedUrl");
    expect(service).not.toMatch(/getPublicUrl/);
  });

  it("makes no outbound request of its own", () => {
    const exportFiles = ALL_FILES.filter(
      (file) => rel(file).startsWith("src/server/export/") && !isTest(file),
    );

    expect(exportFiles.length).toBeGreaterThan(0);
    for (const file of exportFiles) {
      expect(readCode(file)).not.toMatch(/\bfetch\s*\(/);
    }
  });
});

describe("the Phase 4 limits are at their approved values", () => {
  it("admits a whole city's geometry", () => {
    // The target no longer bounds a run, so the geometry is allowed to describe
    // a real city: ~90 seed tiles at an 8 km edge, inside a ~3,700 km2 bbox.
    // None of this is what bounds the cost -- maxCallsPerSearch is.
    expect(SEARCH_LIMITS.maxSeedTiles).toBe(400);
    expect(SEARCH_LIMITS.maxAreaKm2).toBe(5_000);
  });

  it("treats the lead target as a benchmark rather than a cap", () => {
    expect(SEARCH_LIMITS.maxTargetLeads).toBe(10_000);
  });

  it("paginates to Google's ceiling and no further", () => {
    // 20 results x 3 pages = 60 per query. No parameter raises it, so asking
    // for a fourth page would be a wasted billable call.
    expect(SEARCH_LIMITS.maxPagesPerTile).toBe(MAX_PAGES);
    expect(PAGE_SIZE * SEARCH_LIMITS.maxPagesPerTile).toBe(RESULT_CEILING);
  });

  it("allows a bounded retry, raised deliberately from the Phase 3A cap of 1", () => {
    expect(SEARCH_LIMITS.maxAttemptsPerPage).toBe(3);
  });

  it("subdivides to the production depth", () => {
    // Depth 3 is what lets a dense city block be resolved below the 60-result
    // ceiling instead of being written off as a permanent gap.
    expect(SEARCH_LIMITS.maxSubdivisionDepth).toBe(3);
  });

  it("processes a slice of tiles per tick, bounded by the wall clock", () => {
    expect(SEARCH_LIMITS.maxTilesPerTick).toBe(12);
  });

  it("bounds a whole search with the APPROVED hard call budget", () => {
    // 150, approved by the account owner on 2026-08-22. A higher figure (300)
    // was proposed and rejected as too large a share of the month.
    //
    // This is now the ONLY ceiling on what one search may spend: the lead
    // target no longer stops a run, and geometry alone permits six figures of
    // calls. Changing it is a spending decision and has to come back through
    // this assertion.
    expect(SEARCH_LIMITS.maxCallsPerSearch).toBe(150);
  });

  it("keeps one search's budget to a modest share of the protected allowance", () => {
    // 150 of 950 protected calls: under a fifth of the month, so the allowance
    // still absorbs several searches even if every one of them runs to its cap.
    const enterprise = getSkuConfig("places-text-search-enterprise");
    const protectedRemaining = enterprise.freeCallsPerMonth - enterprise.reserve;

    expect(protectedRemaining).toBe(950);
    expect(SEARCH_LIMITS.maxCallsPerSearch / protectedRemaining).toBeLessThan(0.2);
  });

  it("caps one tick at exactly what the other limits permit", () => {
    const perTickCeiling =
      SEARCH_LIMITS.maxTilesPerTick *
      SEARCH_LIMITS.maxPagesPerTile *
      SEARCH_LIMITS.maxAttemptsPerPage;

    expect(perTickCeiling).toBe(108);
    expect(perTickCeiling).toBeLessThan(SEARCH_LIMITS.maxCallsPerSearch);
    // Pinned to the DERIVED ceiling, not merely above it. Headroom here would
    // be spending that nothing accounts for the moment the tile cap is raised,
    // so raising maxTilesPerTick has to come back through this assertion.
    expect(SEARCH_LIMITS.maxCallsPerTick).toBe(perTickCeiling);
  });

  it("has a geometric worst case the budget genuinely has to cap", () => {
    // This is the whole reason the budget exists, and it matters far more now
    // that the target does not stop a run: the geometry alone permits three
    // orders of magnitude more than the budget allows.
    const geometricMax =
      maxTilesAfterSubdivision(SEARCH_LIMITS.maxSeedTiles, SEARCH_LIMITS.maxSubdivisionDepth) *
      SEARCH_LIMITS.maxPagesPerTile *
      SEARCH_LIMITS.maxAttemptsPerPage;

    expect(geometricMax).toBe(400 * 85 * 3 * 3);
    expect(geometricMax).toBeGreaterThan(SEARCH_LIMITS.maxCallsPerSearch * 1000);
  });

  it("gives a tick a wall-clock budget it can finish inside the route timeout", () => {
    expect(SEARCH_LIMITS.maxTickMs).toBeLessThan(60_000);
  });
});

describe("the phase limits are structural, not passed at call sites", () => {
  it("the run route hands the runner no options at all", () => {
    // The mistake that cost the project's first real Google call was a limit
    // enforced by remembering to pass an option. Every limit is now read from
    // SEARCH_LIMITS inside the runner, so no route, button or script can
    // widen one by forgetting.
    const route = readCode(path.resolve(process.cwd(), "src/app/api/searches/[id]/run/route.ts"));

    expect(route).toMatch(/runControlledTick\(\{\s*searchId: id,\s*userId: user\.id\s*\}\)/);
    expect(route).not.toMatch(/maxAttempts|maxPages|maxTilesPerTick|maxCallsPer/);
  });

  it("no API route takes a limit from the request", () => {
    // Referencing SEARCH_LIMITS in a route is fine and expected -- reading a
    // limit off the parsed request body is not. So the constant references are
    // removed first, and what is left must mention no limit at all.
    const routes = ALL_FILES.filter((file) => rel(file).startsWith("src/app/api/"));
    const offenders = routes
      .filter((file) => {
        const withoutConstants = readCode(file).replace(/SEARCH_LIMITS\.\w+/g, "");
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
      expect(runner).toContain(`?? SEARCH_LIMITS.${limit}, SEARCH_LIMITS.${limit},`);
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
