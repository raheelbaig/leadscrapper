/**
 * The tile state machine, mirrored from the database enum and the
 * `tile_state_transitions` table. The database is authoritative; this file
 * exists so the UI can label and colour states consistently.
 */
export const TILE_STATES = [
  "pending",
  "in_progress",
  "covered",
  "empty",
  "subdivided",
  "saturated_floor",
  "failed",
  "skipped_quota",
] as const;

export type TileState = (typeof TILE_STATES)[number];

type TileStateMeta = {
  label: string;
  /** One-line explanation shown in the legend and in tooltips. */
  description: string;
  /** Does this state represent geography we have actually verified? */
  countsAsCovered: boolean;
  /** Leaf states are the only ones that participate in coverage accounting. */
  isLeaf: boolean;
  /** Terminal states are never re-searched. */
  isTerminal: boolean;
  /** Tailwind classes for badges. */
  badgeClass: string;
  /** Fill colour for the tile map (CSS colour, works in both themes). */
  fill: string;
};

export const TILE_STATE_META: Record<TileState, TileStateMeta> = {
  pending: {
    label: "Pending",
    description: "Not searched yet. Still owed work.",
    countsAsCovered: false,
    isLeaf: true,
    isTerminal: false,
    badgeClass: "bg-muted text-muted-foreground border-border",
    fill: "oklch(0.72 0.02 260 / 0.25)",
  },
  in_progress: {
    label: "In progress",
    description: "A worker is fetching this tile right now.",
    countsAsCovered: false,
    isLeaf: true,
    isTerminal: false,
    badgeClass: "bg-blue-500/15 text-blue-600 border-blue-500/30 dark:text-blue-400",
    fill: "oklch(0.62 0.19 255 / 0.7)",
  },
  covered: {
    label: "Covered",
    description: "Google returned everything it has for this area.",
    countsAsCovered: true,
    isLeaf: true,
    isTerminal: true,
    badgeClass: "bg-emerald-500/15 text-emerald-700 border-emerald-500/30 dark:text-emerald-400",
    fill: "oklch(0.65 0.16 155 / 0.75)",
  },
  empty: {
    label: "Empty",
    description: "Verified: no matching businesses in this area.",
    countsAsCovered: true,
    isLeaf: true,
    isTerminal: true,
    badgeClass: "bg-slate-500/15 text-slate-700 border-slate-500/30 dark:text-slate-300",
    fill: "oklch(0.72 0.03 200 / 0.45)",
  },
  subdivided: {
    label: "Subdivided",
    description: "Saturated, so it was split into four children. Not a leaf.",
    countsAsCovered: false,
    isLeaf: false,
    isTerminal: true,
    badgeClass: "bg-violet-500/15 text-violet-700 border-violet-500/30 dark:text-violet-400",
    fill: "transparent",
  },
  saturated_floor: {
    label: "Partial",
    description:
      "Hit the result ceiling at the smallest allowed tile size. A permanent known gap - some businesses here were never returned.",
    countsAsCovered: false,
    isLeaf: true,
    isTerminal: true,
    badgeClass: "bg-amber-500/15 text-amber-700 border-amber-500/30 dark:text-amber-400",
    fill: "oklch(0.75 0.15 75 / 0.75)",
  },
  failed: {
    label: "Failed",
    description: "API error after retries. Retried on the next run.",
    countsAsCovered: false,
    isLeaf: true,
    isTerminal: false,
    badgeClass: "bg-red-500/15 text-red-700 border-red-500/30 dark:text-red-400",
    fill: "oklch(0.62 0.21 25 / 0.7)",
  },
  skipped_quota: {
    label: "Skipped (quota)",
    description: "Free quota ran out before this area was searched. Resumable.",
    countsAsCovered: false,
    isLeaf: true,
    isTerminal: false,
    badgeClass: "bg-orange-500/15 text-orange-700 border-orange-500/30 dark:text-orange-400",
    fill: "oklch(0.7 0.17 50 / 0.6)",
  },
};

/** States that still owe work and can be picked up by a resume. */
export const RESUMABLE_TILE_STATES: TileState[] = ["pending", "failed", "skipped_quota"];

/** Leaf states, in the order the coverage report lists them. */
export const LEAF_TILE_STATES: TileState[] = [
  "covered",
  "empty",
  "saturated_floor",
  "failed",
  "skipped_quota",
  "pending",
  "in_progress",
];
