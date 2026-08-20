import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PLACES_FIELD_MASK } from "@/lib/constants";
import { deriveQuotaFigures } from "@/lib/quota";

import { resolveBbox } from "./geo/bbox-resolver";
import { EXTERNAL_PROVIDERS_ENABLED, PERSIST_RESOLVED_LOCATIONS } from "./geo/resolver-config";
import { classify, estimateCost, getPrimarySku, isVerified } from "./pricing/pricing-service";

/**
 * The Phase 2 acceptance criterion, expressed as a test:
 *
 *   Google Places calls      0
 *   Geocoding calls          0
 *   Real Google quota spent  0
 *
 * Checked two ways. Statically, because a call site that exists can be reached
 * by some path nobody thought of; and at runtime, because a static scan cannot
 * see through a dynamically built URL.
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

/**
 * The one place a Google endpoint may be named. It declares the URLs as
 * constants for Phase 3; declaring is not calling.
 */
const URL_DECLARATION_FILE = "src/lib/constants.ts";

describe("static: no Google call site exists yet", () => {
  it("names a Google endpoint in exactly one file", () => {
    const offenders = ALL_FILES.filter(
      (file) =>
        /googleapis\.com/.test(readFileSync(file, "utf8")) &&
        rel(file) !== URL_DECLARATION_FILE &&
        !file.endsWith(".test.ts"),
    ).map(rel);

    expect(offenders).toEqual([]);
  });

  it("has no fetch call anywhere in the Phase 2 server code", () => {
    // `p-retry` and the Places client arrive in Phase 3. Until then there is no
    // outbound request in the codebase to accidentally trigger.
    const offenders = ALL_FILES.filter((file) => {
      const relative = rel(file);
      if (!relative.startsWith("src/server/") && !relative.startsWith("src/app/api/")) return false;
      if (relative.endsWith(".test.ts")) return false;
      return /\bfetch\s*\(/.test(readFileSync(file, "utf8"));
    }).map(rel);

    expect(offenders).toEqual([]);
  });

  it("keeps the Google endpoint constants out of the server tree entirely", () => {
    const offenders = ALL_FILES.filter((file) => {
      const relative = rel(file);
      if (!relative.startsWith("src/server/")) return false;
      if (relative.endsWith(".test.ts")) return false;
      return /PLACES_TEXT_SEARCH_URL|GEOCODING_URL/.test(readFileSync(file, "utf8"));
    }).map(rel);

    expect(offenders).toEqual([]);
  });

  it("never reads the Google API key outside the env module", () => {
    const offenders = ALL_FILES.filter((file) => {
      const relative = rel(file);
      if (relative === "src/server/config/env.ts") return false;
      if (relative.endsWith(".test.ts")) return false;
      return /GOOGLE_MAPS_API_KEY/.test(readFileSync(file, "utf8"));
    }).map(rel);

    expect(offenders).toEqual([]);
  });

  it("leaves the worker switched off and unaddressed", () => {
    // The worker is driven by pg_cron through `private.worker_config`, which
    // Phase 2 must not touch. No route may answer /api/jobs/* yet either.
    const jobRoutes = ALL_FILES.filter((file) => rel(file).startsWith("src/app/api/jobs"));
    expect(jobRoutes).toEqual([]);
  });
});

describe("static: the Phase 3 provider stubs are genuinely empty", () => {
  const stubs = [
    "src/server/geo/providers/geocoding-provider.ts",
    "src/server/geo/providers/places-viewport-provider.ts",
  ];

  it("contain no request machinery at all", () => {
    for (const stub of stubs) {
      const source = readFileSync(path.resolve(process.cwd(), stub), "utf8");
      expect(source).not.toMatch(/\bfetch\s*\(/);
      expect(source).not.toMatch(/https?:\/\//);
      expect(source).not.toMatch(/X-Goog-Api-Key/i);
    }
  });
});

describe("configuration: the Phase 2 switches are in their safe positions", () => {
  it("keeps external providers disabled", () => {
    expect(EXTERNAL_PROVIDERS_ENABLED).toBe(false);
  });

  it("keeps location caching off while the providers are mocked", () => {
    expect(PERSIST_RESOLVED_LOCATIONS).toBe(false);
  });

  it("keeps the pricing catalog unverified until it is approved", () => {
    // Phase 2 may not flip this, and the reserve guard refuses every request
    // while it is false -- so an accidental Google call cannot be authorised.
    expect(isVerified()).toBe(false);
  });
});

describe("runtime: the Phase 2 code paths make no request", () => {
  const originalFetch = globalThis.fetch;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn(() => {
      throw new Error("Phase 2 must not make any outbound request.");
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("resolves a bounding box without touching the network", async () => {
    const result = await resolveBbox({
      country: "United States",
      state: "Texas",
      city: "Houston",
    });

    expect(result.location.areaKm2).toBeGreaterThan(0);
    expect(result.externalCallsMade).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("classifies and prices a search without touching the network", () => {
    const classification = classify(PLACES_FIELD_MASK);
    const estimate = estimateCost({ sku: classification.sku, calls: 900 });
    const figures = deriveQuotaFigures({ freeLimit: 1000, reserve: 50, used: 0 });

    expect(classification.sku).toBe(getPrimarySku());
    expect(estimate.billableCalls).toBe(0);
    expect(figures.remaining).toBe(950);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("plans a whole grid without touching the network", async () => {
    // Planning is free; only searching costs. The grid is derived entirely from
    // the rectangle, so a full plan can be produced with zero API calls.
    const { location } = await resolveBbox({
      country: "United States",
      state: "Illinois",
      city: "Chicago",
    });

    const { gridDimensions } = await import("@/lib/geo/bbox");
    const grid = gridDimensions(location.bbox, {
      seedTileEdgeKm: 8,
      minSeedTiles: 4,
      maxSeedTiles: 400,
    });

    expect(grid.tileCount).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
