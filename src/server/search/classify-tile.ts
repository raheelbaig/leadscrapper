import "server-only";

import { RESULT_CEILING, saturationThreshold } from "@/lib/constants";

/**
 * Tile classification: rules R1-R5, as a pure function.
 *
 * This is the decision that makes a coverage claim true or false, so it is kept
 * away from the I/O that surrounds it. Given the same numbers it always returns
 * the same state, and it can be exercised exhaustively without a database, a
 * network stub or a lease.
 *
 * The rules, and why each exists:
 *
 *   R1  an API error after bounded retries        -> failed
 *       Handled on the error path, not here: a tile that never got an answer
 *       has no results to classify. `failed` is NOT terminal -- it returns to
 *       pending on resume, so the area stays owed rather than written off.
 *
 *   R2  zero results                              -> empty
 *       VERIFIED coverage, not absence of information. Google was asked and
 *       said there is nothing here.
 *
 *   R3  results, no token, R below saturation     -> covered
 *       Google exhausted what it has for this rectangle.
 *
 *   R4a saturated, and there is room to split     -> subdivided + 4 children
 *   R4b saturated at the depth or size floor      -> saturated_floor
 *       A PERMANENT known gap. Some businesses in this rectangle were never
 *       returned and never will be, and the coverage report has to say so.
 *
 *   R5  anything unclassified                     -> treated as R4
 *       The default branch IS the R4 branch. Erring toward subdivision costs
 *       calls; erring toward `covered` costs the truth of the coverage number,
 *       and coverage is the stated priority.
 *
 * SATURATION is `R >= ceil(0.95 x 60) = 57`, or a page token still outstanding.
 * Not `R == 60`: Google intermittently returns 18-19 items on a full page, so
 * demanding the exact ceiling would read a truncated tile as a complete one.
 */

/** The state a classified tile moves to. `failed` is not reachable from here. */
export type ClassifiedState = "empty" | "covered" | "subdivided" | "saturated_floor";

export type ClassificationRule = "R2" | "R3" | "R4a" | "R4b";

export type TileClassification = {
  state: ClassifiedState;
  rule: ClassificationRule;
  /** Written verbatim to `search_tiles.last_reason` and into `tile_events`. */
  reason: string;
  /** Did the tile hit the result ceiling, or still have results waiting? */
  saturated: boolean;
  /** Edge length the children would have. Null when no split was considered. */
  childEdgeKm: number | null;
};

export type ClassifyTileInput = {
  /** R: unique results seen across the pages of THIS pass. */
  resultsCount: number;
  /** Did Google still offer a page token when the tile stopped fetching? */
  tokenRemaining: boolean;
  pagesFetched: number;
  /** 0 for a seed tile. */
  depth: number;
  /** The tile's longer edge in kilometres, as `search_tiles.edge_km` computes. */
  edgeKm: number;
  maxSubdivisionDepth: number;
  minTileEdgeKm: number;
  saturationRatio: number;
};

export function classifyTile(input: ClassifyTileInput): TileClassification {
  const {
    resultsCount,
    tokenRemaining,
    pagesFetched,
    depth,
    edgeKm,
    maxSubdivisionDepth,
    minTileEdgeKm,
    saturationRatio,
  } = input;

  const threshold = saturationThreshold(saturationRatio);

  // R2. Asked and answered: there is nothing here.
  if (resultsCount === 0 && !tokenRemaining) {
    return {
      state: "empty",
      rule: "R2",
      reason: "R2: verified empty — Google returned no places for this rectangle",
      saturated: false,
      childEdgeKm: null,
    };
  }

  const saturated = resultsCount >= threshold || tokenRemaining;

  // R3. Google ran out of results before we ran out of pages.
  if (!saturated) {
    return {
      state: "covered",
      rule: "R3",
      reason:
        `R3: covered — ${resultsCount} result(s) over ${pagesFetched} page(s), ` +
        `no further page token, below the saturation threshold of ${threshold}/${RESULT_CEILING}`,
      saturated: false,
      childEdgeKm: null,
    };
  }

  // R4 / R5. Saturated, or unclassifiable and therefore treated as saturated.
  const childEdgeKm = edgeKm / 2;
  const canSplit = depth < maxSubdivisionDepth && childEdgeKm >= minTileEdgeKm;

  const why = tokenRemaining
    ? `a page token remained after ${pagesFetched} page(s), so more results exist`
    : `${resultsCount} result(s) reached the saturation threshold of ${threshold}/${RESULT_CEILING}`;

  if (canSplit) {
    return {
      state: "subdivided",
      rule: "R4a",
      reason: `R4a: saturated — ${why}. Split into 4 children of ~${childEdgeKm.toFixed(2)} km.`,
      saturated: true,
      childEdgeKm,
    };
  }

  const floor =
    depth >= maxSubdivisionDepth
      ? `subdivision depth ${depth} is the configured maximum`
      : `children of ${childEdgeKm.toFixed(2)} km would be under the ${minTileEdgeKm} km floor`;

  return {
    state: "saturated_floor",
    rule: "R4b",
    reason:
      `R4b: PERMANENT GAP — ${why}, but ${floor}. ` +
      `Some businesses in this rectangle were never returned.`,
    saturated: true,
    childEdgeKm,
  };
}
