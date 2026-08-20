/**
 * Bounding-box geometry.
 *
 * These formulas are mirrored EXACTLY from the immutable SQL helpers in
 * `supabase/migrations/0001_extensions_enums.sql` (`rect_width_km`,
 * `rect_height_km`, `rect_area_km2`). `locations.width_km`, `height_km` and
 * `area_km2` are generated columns computed by those functions, so any
 * divergence here would make the application disagree with its own database
 * about how large an area is -- and therefore about how many tiles, and
 * therefore about how many billable calls, a search costs.
 *
 * Pure, deterministic, no I/O. Nothing in this file talks to Google; the whole
 * grid is planned from a rectangle, and planning is free.
 */

/** Kilometres per degree of latitude. Constant everywhere on the sphere. */
export const KM_PER_DEG_LAT = 110.574;

/** Kilometres per degree of longitude AT THE EQUATOR. Shrinks with latitude. */
export const KM_PER_DEG_LNG_EQUATOR = 111.32;

export type BoundingBox = {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
};

export class InvalidBoundingBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidBoundingBoxError";
  }
}

export function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * Validates the same two CHECK constraints the `locations` table enforces
 * (`locations_bbox_ordered`, `locations_bbox_range`), so a bad rectangle is
 * rejected before it reaches Postgres rather than as an opaque 23514.
 */
export function assertValidBbox(bbox: BoundingBox): void {
  const { minLat, minLng, maxLat, maxLng } = bbox;

  for (const [name, value] of Object.entries(bbox)) {
    if (!Number.isFinite(value)) {
      throw new InvalidBoundingBoxError(`Bounding box ${name} must be a finite number.`);
    }
  }
  if (minLat < -90 || maxLat > 90) {
    throw new InvalidBoundingBoxError("Latitude must be within [-90, 90].");
  }
  if (minLng < -180 || maxLng > 180) {
    throw new InvalidBoundingBoxError("Longitude must be within [-180, 180].");
  }
  if (minLat >= maxLat) {
    throw new InvalidBoundingBoxError("minLat must be strictly less than maxLat.");
  }
  if (minLng >= maxLng) {
    throw new InvalidBoundingBoxError("minLng must be strictly less than maxLng.");
  }
}

export function isValidBbox(bbox: BoundingBox): boolean {
  try {
    assertValidBbox(bbox);
    return true;
  } catch {
    return false;
  }
}

/**
 * A span of latitude in kilometres. Independent of where you are.
 * SQL: `rect_height_km`.
 */
export function latSpanKm(latDelta: number): number {
  return latDelta * KM_PER_DEG_LAT;
}

/**
 * A span of longitude in kilometres AT a given latitude.
 *
 * The cos(latitude) correction is what makes tiles square in kilometres rather
 * than in degrees. Without it a tile in Anchorage would be less than half as
 * wide as one in Houston while claiming the same size, and coverage accounting
 * would be quietly wrong everywhere but the equator.
 */
export function lngSpanKm(lngDelta: number, atLat: number): number {
  return lngDelta * KM_PER_DEG_LNG_EQUATOR * Math.cos(toRadians(atLat));
}

/** Inverse of `latSpanKm`: how many degrees of latitude span `km`. */
export function kmToLatDegrees(km: number): number {
  return km / KM_PER_DEG_LAT;
}

/** Inverse of `lngSpanKm` at a given latitude. */
export function kmToLngDegrees(km: number, atLat: number): number {
  const scale = KM_PER_DEG_LNG_EQUATOR * Math.cos(toRadians(atLat));
  if (scale === 0) return 0;
  return km / scale;
}

/** Midpoint latitude -- the latitude the width correction is evaluated at. */
export function bboxCenterLat(bbox: BoundingBox): number {
  return (bbox.minLat + bbox.maxLat) / 2;
}

export function bboxCenter(bbox: BoundingBox): { lat: number; lng: number } {
  return { lat: bboxCenterLat(bbox), lng: (bbox.minLng + bbox.maxLng) / 2 };
}

/** SQL: `rect_width_km(min_lat, min_lng, max_lat, max_lng)`. */
export function bboxWidthKm(bbox: BoundingBox): number {
  return lngSpanKm(bbox.maxLng - bbox.minLng, bboxCenterLat(bbox));
}

/** SQL: `rect_height_km(min_lat, max_lat)`. */
export function bboxHeightKm(bbox: BoundingBox): number {
  return latSpanKm(bbox.maxLat - bbox.minLat);
}

/** SQL: `rect_area_km2(...)` -- width x height, both already in kilometres. */
export function bboxAreaKm2(bbox: BoundingBox): number {
  return bboxWidthKm(bbox) * bboxHeightKm(bbox);
}

export type BboxMetrics = {
  widthKm: number;
  heightKm: number;
  areaKm2: number;
  centerLat: number;
  centerLng: number;
};

export function bboxMetrics(bbox: BoundingBox): BboxMetrics {
  const center = bboxCenter(bbox);
  return {
    widthKm: bboxWidthKm(bbox),
    heightKm: bboxHeightKm(bbox),
    areaKm2: bboxAreaKm2(bbox),
    centerLat: center.lat,
    centerLng: center.lng,
  };
}

/** Does the rectangle contain the point? Half-open on the max edges. */
export function bboxContains(bbox: BoundingBox, lat: number, lng: number): boolean {
  return lat >= bbox.minLat && lat < bbox.maxLat && lng >= bbox.minLng && lng < bbox.maxLng;
}

/**
 * Splits a rectangle at its lat/lng midpoints into exactly four children.
 *
 * The union of the four children is exactly the parent -- no gap, no overlap,
 * by construction rather than by check. That property is what lets coverage be
 * accounted as area rather than as a tile count, and it is the same split
 * `public.create_child_tiles()` performs in the database.
 *
 * Order is deterministic: SW, SE, NW, NE.
 */
export function splitBboxQuad(
  bbox: BoundingBox,
): [BoundingBox, BoundingBox, BoundingBox, BoundingBox] {
  assertValidBbox(bbox);
  const midLat = (bbox.minLat + bbox.maxLat) / 2;
  const midLng = (bbox.minLng + bbox.maxLng) / 2;

  return [
    { minLat: bbox.minLat, minLng: bbox.minLng, maxLat: midLat, maxLng: midLng },
    { minLat: bbox.minLat, minLng: midLng, maxLat: midLat, maxLng: bbox.maxLng },
    { minLat: midLat, minLng: bbox.minLng, maxLat: bbox.maxLat, maxLng: midLng },
    { minLat: midLat, minLng: midLng, maxLat: bbox.maxLat, maxLng: bbox.maxLng },
  ];
}

export type GridDimensions = {
  cols: number;
  rows: number;
  tileCount: number;
  /** Actual tile size after the row/column counts were clamped. */
  tileWidthKm: number;
  tileHeightKm: number;
  /** True when the clamp changed the count the edge length asked for. */
  clamped: boolean;
};

/**
 * Coverage-first grid sizing.
 *
 * The lead target has ZERO influence here: the number of tiles follows from the
 * size of the area and the seed edge length alone. A target only decides when a
 * run may stop early, never how the geography is divided.
 */
export function gridDimensions(
  bbox: BoundingBox,
  options: { seedTileEdgeKm: number; minSeedTiles: number; maxSeedTiles: number },
): GridDimensions {
  assertValidBbox(bbox);
  const { seedTileEdgeKm, minSeedTiles, maxSeedTiles } = options;

  if (seedTileEdgeKm <= 0) {
    throw new InvalidBoundingBoxError("seedTileEdgeKm must be greater than zero.");
  }

  const widthKm = bboxWidthKm(bbox);
  const heightKm = bboxHeightKm(bbox);

  const rawCols = Math.max(Math.ceil(widthKm / seedTileEdgeKm), 1);
  const rawRows = Math.max(Math.ceil(heightKm / seedTileEdgeKm), 1);
  const rawCount = rawCols * rawRows;

  // Clamp the tile COUNT, then redistribute, so the grid keeps the aspect ratio
  // of the area instead of becoming a strip.
  const scale =
    rawCount < minSeedTiles
      ? Math.sqrt(minSeedTiles / rawCount)
      : rawCount > maxSeedTiles
        ? Math.sqrt(maxSeedTiles / rawCount)
        : 1;

  const cols = Math.max(scale === 1 ? rawCols : Math.round(rawCols * scale), 1);
  const rows = Math.max(scale === 1 ? rawRows : Math.round(rawRows * scale), 1);

  return {
    cols,
    rows,
    tileCount: cols * rows,
    tileWidthKm: widthKm / cols,
    tileHeightKm: heightKm / rows,
    clamped: scale !== 1,
  };
}

/**
 * The cache key for a resolved location.
 *
 * Must produce the same string as the `locations.normalized_key` generated
 * column, or a cached bbox would never be found and every search would pay for
 * a fresh Geocoding call:
 *
 *   lower(trim(country)) || '|' || lower(coalesce(trim(state), '')) || '|' || lower(trim(city))
 */
export function normalizedLocationKey(
  country: string,
  state: string | null | undefined,
  city: string,
): string {
  const norm = (value: string | null | undefined) => (value ?? "").trim().toLowerCase();
  return `${norm(country)}|${norm(state)}|${norm(city)}`;
}
