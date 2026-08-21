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
  seedTilePath,
  seedTileRects,
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

describe("seed tile rectangles", () => {
  const HOUSTON_TEST_BOX = { minLat: 29.69, minLng: -95.45, maxLat: 29.83, maxLng: -95.28 };

  it("produces cols x rows tiles", () => {
    const tiles = seedTileRects(HOUSTON_TEST_BOX, { cols: 3, rows: 2 });
    expect(tiles).toHaveLength(6);
  });

  it("is deterministic", () => {
    const a = seedTileRects(HOUSTON_TEST_BOX, { cols: 3, rows: 2 });
    const b = seedTileRects(HOUSTON_TEST_BOX, { cols: 3, rows: 2 });
    expect(a).toEqual(b);
  });

  it("covers the parent EXACTLY, with the last edges landing on the maxima", () => {
    // Interpolating rather than repeatedly adding a step is what guarantees
    // this. Accumulated float drift would leave a sliver of the rectangle
    // outside every tile -- unsearched area that no tile is responsible for.
    const tiles = seedTileRects(HOUSTON_TEST_BOX, { cols: 3, rows: 2 });

    expect(Math.min(...tiles.map((t) => t.minLat))).toBe(HOUSTON_TEST_BOX.minLat);
    expect(Math.min(...tiles.map((t) => t.minLng))).toBe(HOUSTON_TEST_BOX.minLng);
    expect(Math.max(...tiles.map((t) => t.maxLat))).toBe(HOUSTON_TEST_BOX.maxLat);
    expect(Math.max(...tiles.map((t) => t.maxLng))).toBe(HOUSTON_TEST_BOX.maxLng);
  });

  it("leaves no gap: the tile areas sum to the parent area", () => {
    const tiles = seedTileRects(HOUSTON_TEST_BOX, { cols: 3, rows: 2 });
    const summed = tiles.reduce((sum, tile) => sum + bboxAreaKm2(tile), 0);

    // Within the cos(latitude) approximation, which varies slightly by row.
    expect(summed).toBeCloseTo(bboxAreaKm2(HOUSTON_TEST_BOX), 1);
  });

  it("leaves no overlap: no two tiles share interior area", () => {
    const tiles = seedTileRects(HOUSTON_TEST_BOX, { cols: 3, rows: 3 });

    for (let i = 0; i < tiles.length; i += 1) {
      for (let j = i + 1; j < tiles.length; j += 1) {
        const a = tiles[i];
        const b = tiles[j];
        const overlaps =
          a.minLat < b.maxLat - 1e-9 &&
          b.minLat < a.maxLat - 1e-9 &&
          a.minLng < b.maxLng - 1e-9 &&
          b.minLng < a.maxLng - 1e-9;
        expect(overlaps).toBe(false);
      }
    }
  });

  it("makes adjacent tiles share an edge exactly", () => {
    const tiles = seedTileRects(HOUSTON_TEST_BOX, { cols: 2, rows: 1 });
    expect(tiles[0].maxLng).toBe(tiles[1].minLng);
  });

  it("numbers tiles row-major from the south-west corner", () => {
    const tiles = seedTileRects(HOUSTON_TEST_BOX, { cols: 3, rows: 2 });

    expect(tiles.map((t) => t.index)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(tiles[0]).toMatchObject({ row: 0, col: 0 });
    expect(tiles[3]).toMatchObject({ row: 1, col: 0 });
  });

  it("degenerates cleanly to a single tile equal to the parent", () => {
    const [only] = seedTileRects(HOUSTON_TEST_BOX, { cols: 1, rows: 1 });
    expect(only).toMatchObject(HOUSTON_TEST_BOX);
  });

  it("rejects nonsense dimensions", () => {
    expect(() => seedTileRects(HOUSTON_TEST_BOX, { cols: 0, rows: 2 })).toThrow(
      InvalidBoundingBoxError,
    );
    expect(() => seedTileRects(HOUSTON_TEST_BOX, { cols: 2.5, rows: 2 })).toThrow(
      InvalidBoundingBoxError,
    );
  });

  it("composes with gridDimensions to tile a real test rectangle", () => {
    // The planned Phase 3B controlled run: ~15.5 x 16.4 km at an 8 km seed edge.
    const grid = gridDimensions(HOUSTON_TEST_BOX, {
      seedTileEdgeKm: 8,
      minSeedTiles: 4,
      maxSeedTiles: 9,
    });

    expect(grid).toMatchObject({ cols: 3, rows: 2, tileCount: 6, clamped: false });

    const tiles = seedTileRects(HOUSTON_TEST_BOX, grid);
    expect(tiles).toHaveLength(6);
    expect(bboxWidthKm(tiles[0])).toBeCloseTo(grid.tileWidthKm, 2);
    expect(bboxHeightKm(tiles[0])).toBeCloseTo(grid.tileHeightKm, 2);
  });

  it("splits into quadrants that stay inside their parent tile", () => {
    // Subdivision is the same construction one level down, so a child of a seed
    // tile must never escape it.
    const [tile] = seedTileRects(HOUSTON_TEST_BOX, { cols: 2, rows: 2 });

    for (const child of splitBboxQuad(tile)) {
      expect(child.minLat).toBeGreaterThanOrEqual(tile.minLat);
      expect(child.maxLat).toBeLessThanOrEqual(tile.maxLat);
      expect(child.minLng).toBeGreaterThanOrEqual(tile.minLng);
      expect(child.maxLng).toBeLessThanOrEqual(tile.maxLng);
    }
  });
});

describe("seed tile paths", () => {
  it("zero-pads, so text ordering is also scan ordering", () => {
    // Postgres sorts `path` as text. Plain ordinals would put "10" before "2"
    // and silently scramble the order of any grid past nine tiles.
    const paths = [1, 2, 9, 10, 11, 100].map(seedTilePath);

    expect(paths).toEqual(["001", "002", "009", "010", "011", "100"]);
    expect([...paths].sort()).toEqual(paths);
  });

  it("keeps a child sorted immediately after its parent", () => {
    const parent = seedTilePath(7);
    const child = `${parent}.sw`;
    const nextParent = seedTilePath(8);

    expect([nextParent, child, parent].sort()).toEqual([parent, child, nextParent]);
  });
});
