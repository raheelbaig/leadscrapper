import { TILE_STATE_META, type TileState } from "@/lib/tile-states";

/**
 * The honest account of what a run did and did not search.
 *
 * `stopOnTargetReached` means a search can legitimately finish having covered a
 * third of its rectangle. That is a feature -- but only if the report says so.
 * A run that stops at the target and then reports "completed" without naming
 * the geography it skipped is lying by omission, and every later decision made
 * from that lead list inherits the lie.
 *
 * So this module separates three things a tile count would blur together:
 *
 *   COVERED        `covered` + `empty`. Verified, done, never revisited.
 *   OWED           `pending` + `failed` + `skipped_quota`. Not searched, but
 *                  resumable -- press Run again and the work continues.
 *   PERMANENT GAP  `saturated_floor`. Hit the result ceiling at the smallest
 *                  allowed tile. No amount of resuming recovers it.
 *
 * Area-weighted throughout, never tile-count weighted: four children of a
 * subdivided tile occupy the parent's area between them, so counting tiles
 * would make subdivision look like progress.
 *
 * Pure. Reads tile rows, returns a description, touches nothing --
 * which is why it lives in `lib` rather than `server`: the tick writes the
 * summary to the activity log, and the search page renders the same structure
 * from the same function, so the two can never tell different stories.
 *
 * `searches.coverage_report` stays owned by `verify_search_coverage`, which
 * answers a different question -- whether the grid is structurally sound.
 */

/** The subset of a `search_tiles` row this report needs. */
export type CoverageTile = {
  label: string;
  state: TileState;
  area_km2: number;
  depth: number;
};

export type CoverageBucket = {
  tiles: number;
  areaKm2: number;
  /** Share of the search rectangle, 0-100. */
  pct: number;
};

export type CoverageReport = {
  target: number;
  leadsFound: number;
  targetReached: boolean;

  /** Leaves only. A `subdivided` tile is a container, not coverage. */
  leafTiles: number;
  tilesCompleted: number;
  tilesRemaining: number;
  tilesSubdivided: number;

  areaTotalKm2: number;
  coveragePct: number;

  covered: CoverageBucket;
  owed: CoverageBucket;
  permanentGap: CoverageBucket;

  byState: Record<TileState, CoverageBucket>;

  /** True only when every square kilometre is `covered` or `empty`. */
  fullyCovered: boolean;
  /** Tiles that still owe work, for the "what was not searched" list. */
  unsearchedTiles: { label: string; state: TileState; areaKm2: number }[];
  /** One paragraph, safe to show verbatim and to write to the activity log. */
  summary: string;
};

const COVERED_STATES: TileState[] = ["covered", "empty"];
const OWED_STATES: TileState[] = ["pending", "in_progress", "failed", "skipped_quota"];
const GAP_STATES: TileState[] = ["saturated_floor"];

function bucket(tiles: CoverageTile[], states: TileState[], totalArea: number): CoverageBucket {
  const matching = tiles.filter((tile) => states.includes(tile.state));
  const areaKm2 = matching.reduce((sum, tile) => sum + tile.area_km2, 0);

  return {
    tiles: matching.length,
    areaKm2,
    pct: totalArea > 0 ? (areaKm2 / totalArea) * 100 : 0,
  };
}

export function buildCoverageReport(args: {
  tiles: CoverageTile[];
  target: number;
  leadsFound: number;
}): CoverageReport {
  const { target, leadsFound } = args;

  // Leaves only. The union of the leaves is the search rectangle; adding the
  // subdivided parents back in would double-count their area.
  const leaves = args.tiles.filter((tile) => tile.state !== "subdivided");
  const subdivided = args.tiles.length - leaves.length;
  const areaTotalKm2 = leaves.reduce((sum, tile) => sum + tile.area_km2, 0);

  const covered = bucket(leaves, COVERED_STATES, areaTotalKm2);
  const owed = bucket(leaves, OWED_STATES, areaTotalKm2);
  const permanentGap = bucket(leaves, GAP_STATES, areaTotalKm2);

  const byState = Object.fromEntries(
    (Object.keys(TILE_STATE_META) as TileState[]).map((state) => [
      state,
      state === "subdivided"
        ? {
            tiles: subdivided,
            areaKm2: 0,
            pct: 0,
          }
        : bucket(leaves, [state], areaTotalKm2),
    ]),
  ) as Record<TileState, CoverageBucket>;

  const unsearchedTiles = leaves
    .filter((tile) => OWED_STATES.includes(tile.state))
    .map((tile) => ({ label: tile.label, state: tile.state, areaKm2: tile.area_km2 }))
    .sort((a, b) => b.areaKm2 - a.areaKm2);

  const targetReached = target > 0 && leadsFound >= target;
  const fullyCovered = owed.tiles === 0 && permanentGap.tiles === 0;

  const summary = writeSummary({
    target,
    leadsFound,
    targetReached,
    leafTiles: leaves.length,
    covered,
    owed,
    permanentGap,
    fullyCovered,
  });

  return {
    target,
    leadsFound,
    targetReached,
    leafTiles: leaves.length,
    tilesCompleted: covered.tiles + permanentGap.tiles,
    tilesRemaining: owed.tiles,
    tilesSubdivided: subdivided,
    areaTotalKm2,
    coveragePct: covered.pct,
    covered,
    owed,
    permanentGap,
    byState,
    fullyCovered,
    unsearchedTiles,
    summary,
  };
}

function writeSummary(args: {
  target: number;
  leadsFound: number;
  targetReached: boolean;
  leafTiles: number;
  covered: CoverageBucket;
  owed: CoverageBucket;
  permanentGap: CoverageBucket;
  fullyCovered: boolean;
}): string {
  const { covered, owed, permanentGap } = args;
  const km = (value: number) => `${value.toFixed(1)} km²`;
  const pct = (value: number) => `${value.toFixed(1)}%`;

  const lead = `${args.leadsFound} lead(s) found against a target of ${args.target}.`;

  if (args.fullyCovered) {
    return (
      `${lead} The whole requested area was searched: ` +
      `${covered.tiles} of ${args.leafTiles} leaf tile(s), ${km(covered.areaKm2)} verified.`
    );
  }

  const parts: string[] = [lead];

  parts.push(
    `${pct(covered.pct)} of the requested area was searched ` +
      `(${km(covered.areaKm2)} across ${covered.tiles} tile(s)).`,
  );

  if (owed.tiles > 0) {
    parts.push(
      `THIS SEARCH DID NOT COVER THE WHOLE AREA: ${km(owed.areaKm2)} ` +
        `(${pct(owed.pct)}) across ${owed.tiles} tile(s) was never searched` +
        (args.targetReached ? " because the lead target was reached first." : ".") +
        " That work is still owed and resumes on the next run.",
    );
  }

  if (permanentGap.tiles > 0) {
    parts.push(
      `PERMANENT KNOWN GAP: ${km(permanentGap.areaKm2)} (${pct(permanentGap.pct)}) ` +
        `across ${permanentGap.tiles} tile(s) hit the 60-result ceiling at the smallest ` +
        `allowed tile size. Businesses there were never returned and resuming will not recover them.`,
    );
  }

  return parts.join(" ");
}
