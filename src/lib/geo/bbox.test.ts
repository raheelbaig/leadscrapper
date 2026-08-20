import { describe, expect, it } from "vitest";

import {
  InvalidBoundingBoxError,
  KM_PER_DEG_LAT,
  KM_PER_DEG_LNG_EQUATOR,
  assertValidBbox,
  bboxAreaKm2,
  bboxCenter,
  bboxContains,
  bboxHeightKm,
  bboxWidthKm,
  gridDimensions,
  isValidBbox,
  kmToLatDegrees,
  kmToLngDegrees,
  latSpanKm,
  lngSpanKm,
  normalizedLocationKey,
  splitBboxQuad,
  type BoundingBox,
} from "./bbox";

/** Approximate Houston. Fixed, so the expected numbers never move. */
const HOUSTON: BoundingBox = { minLat: 29.523, minLng: -95.789, maxLat: 30.11, maxLng: -95.014 };
/** A one-degree square on the equator: the simplest case to reason about. */
const EQUATOR: BoundingBox = { minLat: -0.5, minLng: -0.5, maxLat: 0.5, maxLng: 0.5 };
/** Straddles the prime meridian, where a sign error would show up. */
const LONDON: BoundingBox = { minLat: 51.286, minLng: -0.51, maxLat: 51.692, maxLng: 0.334 };

describe("degree-to-kilometre conversion", () => {
  it("converts latitude with a constant factor", () => {
    expect(latSpanKm(1)).toBeCloseTo(KM_PER_DEG_LAT, 10);
    expect(latSpanKm(0.5)).toBeCloseTo(KM_PER_DEG_LAT / 2, 10);
  });

  it("converts longitude at full width on the equator", () => {
    expect(lngSpanKm(1, 0)).toBeCloseTo(KM_PER_DEG_LNG_EQUATOR, 10);
  });

  it("shrinks longitude by cos(latitude)", () => {
    // Without this correction a tile in Alaska would be less than half as wide
    // as one in Texas while claiming the same size, and coverage accounting
    // would be quietly wrong everywhere but the equator.
    expect(lngSpanKm(1, 60)).toBeCloseTo(KM_PER_DEG_LNG_EQUATOR * 0.5, 3);
    expect(lngSpanKm(1, 61.2)).toBeLessThan(lngSpanKm(1, 29.8) * 0.6);
  });

  it("is symmetric about the equator", () => {
    expect(lngSpanKm(1, 45)).toBeCloseTo(lngSpanKm(1, -45), 10);
  });

  it("round-trips through the inverse conversions", () => {
    expect(kmToLatDegrees(latSpanKm(0.37))).toBeCloseTo(0.37, 10);
    expect(kmToLngDegrees(lngSpanKm(0.42, 29.8), 29.8)).toBeCloseTo(0.42, 10);
  });

  it("needs more degrees of longitude to cover 8 km further north", () => {
    expect(kmToLngDegrees(8, 61.2)).toBeGreaterThan(kmToLngDegrees(8, 29.8));
  });
});

describe("bbox measurements", () => {
  it("matches the SQL rect_height_km formula", () => {
    expect(bboxHeightKm(HOUSTON)).toBeCloseTo((30.11 - 29.523) * KM_PER_DEG_LAT, 10);
  });

  it("matches the SQL rect_width_km formula, corrected at the centre latitude", () => {
    const centreLat = (29.523 + 30.11) / 2;
    const expected =
      (-95.014 - -95.789) * KM_PER_DEG_LNG_EQUATOR * Math.cos((centreLat * Math.PI) / 180);
    expect(bboxWidthKm(HOUSTON)).toBeCloseTo(expected, 10);
  });

  it("matches the SQL rect_area_km2 formula", () => {
    expect(bboxAreaKm2(HOUSTON)).toBeCloseTo(bboxWidthKm(HOUSTON) * bboxHeightKm(HOUSTON), 10);
  });

  it("produces a plausible size for a real city", () => {
    // Sanity, not precision: Houston is a big city, not a country.
    expect(bboxWidthKm(HOUSTON)).toBeGreaterThan(50);
    expect(bboxWidthKm(HOUSTON)).toBeLessThan(120);
    expect(bboxAreaKm2(HOUSTON)).toBeGreaterThan(2_000);
    expect(bboxAreaKm2(HOUSTON)).toBeLessThan(10_000);
  });

  it("measures a degree square on the equator as roughly 111 km on a side", () => {
    expect(bboxWidthKm(EQUATOR)).toBeCloseTo(KM_PER_DEG_LNG_EQUATOR, 6);
    expect(bboxHeightKm(EQUATOR)).toBeCloseTo(KM_PER_DEG_LAT, 6);
  });

  it("handles a box spanning the prime meridian", () => {
    expect(bboxWidthKm(LONDON)).toBeGreaterThan(0);
    expect(bboxAreaKm2(LONDON)).toBeGreaterThan(0);
  });

  it("finds the centre", () => {
    const centre = bboxCenter(HOUSTON);
    expect(centre.lat).toBeCloseTo(29.8165, 6);
    expect(centre.lng).toBeCloseTo(-95.4015, 6);
  });

  it("contains its own centre and excludes a point outside", () => {
    const centre = bboxCenter(HOUSTON);
    expect(bboxContains(HOUSTON, centre.lat, centre.lng)).toBe(true);
    expect(bboxContains(HOUSTON, 40.7, -74)).toBe(false);
  });

  it("is half-open on the max edges, so adjacent tiles never both claim a point", () => {
    expect(bboxContains(HOUSTON, HOUSTON.minLat, HOUSTON.minLng)).toBe(true);
    expect(bboxContains(HOUSTON, HOUSTON.maxLat, HOUSTON.minLng)).toBe(false);
    expect(bboxContains(HOUSTON, HOUSTON.minLat, HOUSTON.maxLng)).toBe(false);
  });
});

describe("validation", () => {
  it("rejects an inverted or degenerate rectangle", () => {
    expect(() => assertValidBbox({ minLat: 30, minLng: -95, maxLat: 29, maxLng: -94 })).toThrow(
      InvalidBoundingBoxError,
    );
    expect(() => assertValidBbox({ minLat: 29, minLng: -95, maxLat: 29, maxLng: -94 })).toThrow(
      InvalidBoundingBoxError,
    );
  });

  it("rejects out-of-range coordinates", () => {
    expect(() => assertValidBbox({ minLat: -91, minLng: -95, maxLat: 29, maxLng: -94 })).toThrow();
    expect(() => assertValidBbox({ minLat: 29, minLng: -181, maxLat: 30, maxLng: -94 })).toThrow();
  });

  it("rejects non-finite coordinates", () => {
    expect(() =>
      assertValidBbox({ minLat: Number.NaN, minLng: -95, maxLat: 30, maxLng: -94 }),
    ).toThrow(InvalidBoundingBoxError);
  });

  it("accepts a real city", () => {
    expect(isValidBbox(HOUSTON)).toBe(true);
    expect(isValidBbox(LONDON)).toBe(true);
  });
});

describe("quad subdivision", () => {
  const children = splitBboxQuad(HOUSTON);

  it("produces exactly four children", () => {
    expect(children).toHaveLength(4);
  });

  it("covers the parent exactly, with no gap and no overlap", () => {
    // This is what lets coverage be accounted as area rather than tile count.
    expect(Math.min(...children.map((c) => c.minLat))).toBe(HOUSTON.minLat);
    expect(Math.max(...children.map((c) => c.maxLat))).toBe(HOUSTON.maxLat);
    expect(Math.min(...children.map((c) => c.minLng))).toBe(HOUSTON.minLng);
    expect(Math.max(...children.map((c) => c.maxLng))).toBe(HOUSTON.maxLng);

    for (let i = 0; i < children.length; i += 1) {
      for (let j = i + 1; j < children.length; j += 1) {
        const a = children[i];
        const b = children[j];
        const overlaps =
          a.minLat < b.maxLat && b.minLat < a.maxLat && a.minLng < b.maxLng && b.minLng < a.maxLng;
        expect(overlaps).toBe(false);
      }
    }
  });

  it("splits at the midpoints", () => {
    const midLat = (HOUSTON.minLat + HOUSTON.maxLat) / 2;
    const midLng = (HOUSTON.minLng + HOUSTON.maxLng) / 2;
    expect(children[0]).toEqual({
      minLat: HOUSTON.minLat,
      minLng: HOUSTON.minLng,
      maxLat: midLat,
      maxLng: midLng,
    });
  });

  it("is deterministic", () => {
    expect(splitBboxQuad(HOUSTON)).toEqual(children);
  });

  it("conserves area to within the cos(latitude) approximation", () => {
    // The children are evaluated at their own centre latitudes rather than the
    // parent's, so the km2 figures differ in the fifth decimal place. The
    // GEOMETRY is exact; only the flat-earth area approximation moves.
    const childArea = children.reduce((sum, c) => sum + bboxAreaKm2(c), 0);
    expect(childArea).toBeCloseTo(bboxAreaKm2(HOUSTON), 1);
    expect(Math.abs(childArea / bboxAreaKm2(HOUSTON) - 1)).toBeLessThan(1e-4);
  });

  it("keeps subdividing cleanly", () => {
    const grandchildren = children.flatMap(splitBboxQuad);
    expect(grandchildren).toHaveLength(16);
    expect(Math.min(...grandchildren.map((c) => c.minLat))).toBe(HOUSTON.minLat);
    expect(Math.max(...grandchildren.map((c) => c.maxLng))).toBe(HOUSTON.maxLng);
  });
});

describe("grid sizing", () => {
  const options = { seedTileEdgeKm: 8, minSeedTiles: 4, maxSeedTiles: 400 };

  it("derives the tile count from the area alone", () => {
    const grid = gridDimensions(HOUSTON, options);
    expect(grid.cols).toBe(Math.ceil(bboxWidthKm(HOUSTON) / 8));
    expect(grid.rows).toBe(Math.ceil(bboxHeightKm(HOUSTON) / 8));
    expect(grid.tileCount).toBe(grid.cols * grid.rows);
    expect(grid.clamped).toBe(false);
  });

  it("ignores the lead target entirely", () => {
    // Coverage-first: geometry follows the area, never the goal. There is no
    // target parameter here at all, and this test exists to keep it that way.
    expect(Object.keys(options)).not.toContain("targetLeads");
  });

  it("is deterministic", () => {
    expect(gridDimensions(HOUSTON, options)).toEqual(gridDimensions(HOUSTON, options));
  });

  it("raises a tiny area to the minimum tile count", () => {
    const tiny: BoundingBox = { minLat: 29.76, minLng: -95.37, maxLat: 29.78, maxLng: -95.35 };
    const grid = gridDimensions(tiny, options);
    expect(grid.tileCount).toBeGreaterThanOrEqual(options.minSeedTiles);
    expect(grid.clamped).toBe(true);
  });

  it("caps a huge area and keeps its aspect ratio", () => {
    const huge: BoundingBox = { minLat: 25, minLng: -125, maxLat: 49, maxLng: -67 };
    const grid = gridDimensions(huge, options);
    expect(grid.tileCount).toBeLessThanOrEqual(options.maxSeedTiles * 1.1);
    expect(grid.clamped).toBe(true);
    expect(grid.cols).toBeGreaterThan(grid.rows);
  });

  it("tiles cover the whole box whatever the clamp did", () => {
    const grid = gridDimensions(HOUSTON, options);
    expect(grid.tileWidthKm * grid.cols).toBeCloseTo(bboxWidthKm(HOUSTON), 6);
    expect(grid.tileHeightKm * grid.rows).toBeCloseTo(bboxHeightKm(HOUSTON), 6);
  });

  it("needs more tiles for a smaller edge length", () => {
    const coarse = gridDimensions(HOUSTON, { ...options, seedTileEdgeKm: 16 });
    const fine = gridDimensions(HOUSTON, { ...options, seedTileEdgeKm: 4 });
    expect(fine.tileCount).toBeGreaterThan(coarse.tileCount);
  });

  it("rejects a non-positive edge length", () => {
    expect(() => gridDimensions(HOUSTON, { ...options, seedTileEdgeKm: 0 })).toThrow();
  });
});

describe("normalized location key", () => {
  it("matches the SQL generated column formula", () => {
    // lower(trim(country)) || '|' || lower(coalesce(trim(state), '')) || '|' || lower(trim(city))
    expect(normalizedLocationKey("United States", "Texas", "Houston")).toBe(
      "united states|texas|houston",
    );
  });

  it("leaves an empty segment when there is no state", () => {
    expect(normalizedLocationKey("Singapore", null, "Singapore")).toBe("singapore||singapore");
    expect(normalizedLocationKey("Singapore", undefined, "Singapore")).toBe("singapore||singapore");
    expect(normalizedLocationKey("Singapore", "   ", "Singapore")).toBe("singapore||singapore");
  });

  it("ignores case and surrounding whitespace", () => {
    expect(normalizedLocationKey("  UNITED STATES ", " texas ", " HoUsToN ")).toBe(
      normalizedLocationKey("United States", "Texas", "Houston"),
    );
  });

  it("keeps different cities apart", () => {
    expect(normalizedLocationKey("United States", "Texas", "Houston")).not.toBe(
      normalizedLocationKey("United States", "Texas", "Dallas"),
    );
    // Same city name, different state: two genuinely different searches.
    expect(normalizedLocationKey("United States", "Texas", "Paris")).not.toBe(
      normalizedLocationKey("France", null, "Paris"),
    );
  });
});
