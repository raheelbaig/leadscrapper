/**
 * Domain constants that are derived from the Google Places API contract or are
 * pure presentation. Deliberately NOT here: prices, free allowances, and any
 * other Google billing number -- those live in the versioned pricing catalog
 * (`src/server/pricing/catalog.json`) and are only ever read through the
 * pricing service.
 */

// --- Google Places API (New) Text Search contract -------------------------
// Hard ceilings, not preferences. No parameter raises them.
export const PAGE_SIZE = 20;
export const MAX_PAGES = 3;
/** 20 x 3 = 60 results per query. Derived, never hardcoded elsewhere. */
export const RESULT_CEILING = PAGE_SIZE * MAX_PAGES;

/**
 * A nextPageToken needs roughly two seconds before it becomes usable, and every
 * other request parameter must be identical when it is presented.
 */
export const PAGE_TOKEN_DELAY_MS = 2_000;

/**
 * The required field mask.
 *
 * `nationalPhoneNumber`, `internationalPhoneNumber` and `websiteUri` are
 * Enterprise-tier fields, and a single Enterprise field bills the WHOLE request
 * at Enterprise. Phone and website are both required by the product, so every
 * lead-search call is an Enterprise call. The pricing service derives the SKU
 * from this list rather than assuming it, so adding a field cannot silently
 * change the billing tier.
 */
export const PLACES_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.nationalPhoneNumber",
  "places.internationalPhoneNumber",
  "places.websiteUri",
  "places.location",
  "places.googleMapsUri",
] as const;

export const PLACES_TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
export const GEOCODING_URL = "https://maps.googleapis.com/maps/api/geocode/json";

// --- Grid defaults ---------------------------------------------------------
// Heuristics, not constants: every one of these is overridable per search and
// is frozen into `searches.grid_config` at creation time. Tile counts are
// always derived from the bounding box, never assumed from the lead target.
export const DEFAULT_GRID_CONFIG = {
  sizingStrategy: "coverage-first" as const,
  seedTileEdgeKm: 8,
  maxSubdivisionDepth: 3,
  minTileEdgeKm: 0.5,
  saturationRatio: 0.95,
  minSeedTiles: 4,
  maxSeedTiles: 400,
  stopOnTargetReached: true,
};

export type GridConfig = typeof DEFAULT_GRID_CONFIG;

/**
 * A tile is treated as truncated at 57 of 60 rather than exactly 60, because
 * Google intermittently returns 18-19 items on a full page. Demanding exactly
 * 60 would misclassify truncated tiles as complete. Erring toward subdivision
 * costs calls and protects coverage, which is the stated priority.
 */
export const saturationThreshold = (ratio: number) => Math.ceil(ratio * RESULT_CEILING);

/** Starting estimate for pages-per-tile, refined from the user's own history. */
export const INITIAL_AVG_PAGES_PER_TILE = 1.2;

// --- Presentation ----------------------------------------------------------
export const APP_NAME = "Lead Scrapper";
export const APP_DESCRIPTION =
  "Coverage-first local lead generation for embroidery digitizing.";

/** Fixed export column order. Identical before and after enrichment. */
export const EXPORT_COLUMNS = [
  "Business Name",
  "Phone",
  "Address",
  "Website",
  "Email",
  "Google Maps Link",
  "City",
  "State",
  "Country",
  "Place ID",
  "Query Tile",
  "Email Status",
  "Email Source",
  "Email Confidence",
] as const;
