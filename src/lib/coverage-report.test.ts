import { describe, expect, it } from "vitest";

import type { TileState } from "@/lib/tile-states";

import { buildCoverageReport, type CoverageTile } from "./coverage-report";

/**
 * The report exists to stop one specific lie: a run that stopped at its lead
 * target reporting that it searched the area. Most of what follows is checking
 * that the unsearched geography is named, measured and impossible to miss.
 */

let counter = 0;

function tile(state: TileState, areaKm2: number, depth = 0): CoverageTile {
  counter += 1;
  return { label: `Tile #${counter}`, state, area_km2: areaKm2, depth };
}

describe("full coverage", () => {
  it("reports 100% when every leaf is covered or empty", () => {
    const report = buildCoverageReport({
      tiles: [tile("covered", 40), tile("covered", 40), tile("empty", 20)],
      target: 30,
      leadsFound: 35,
    });

    expect(report.coveragePct).toBe(100);
    expect(report.fullyCovered).toBe(true);
    expect(report.owed.tiles).toBe(0);
    expect(report.permanentGap.tiles).toBe(0);
  });

  it("counts a verified-empty tile as coverage, not as a gap", () => {
    const report = buildCoverageReport({
      tiles: [tile("empty", 50), tile("covered", 50)],
      target: 10,
      leadsFound: 4,
    });

    expect(report.covered.areaKm2).toBe(100);
    expect(report.fullyCovered).toBe(true);
  });

  it("says so plainly", () => {
    const report = buildCoverageReport({
      tiles: [tile("covered", 100)],
      target: 10,
      leadsFound: 12,
    });

    expect(report.summary).toMatch(/whole requested area was searched/i);
    expect(report.summary).not.toMatch(/DID NOT COVER/);
  });
});

describe("a run that met the lead target but not the geography", () => {
  const tiles = [
    tile("covered", 42.4),
    tile("covered", 42.4),
    tile("pending", 42.4),
    tile("pending", 42.4),
    tile("pending", 42.4),
    tile("pending", 42.4),
  ];

  const report = buildCoverageReport({ tiles, target: 40, leadsFound: 43 });

  it("reports the target as met, as a metric", () => {
    expect(report.targetReached).toBe(true);
    expect(report.leadsFound).toBe(43);
    expect(report.target).toBe(40);
  });

  it("does NOT claim the area was covered", () => {
    expect(report.fullyCovered).toBe(false);
    expect(report.coveragePct).toBeCloseTo(33.33, 1);
  });

  it("names the unsearched geography in km², not just in tiles", () => {
    // Area-weighted, because tile counts stop meaning anything the moment a
    // tile subdivides.
    expect(report.owed.tiles).toBe(4);
    expect(report.owed.areaKm2).toBeCloseTo(169.6, 1);
    expect(report.owed.pct).toBeCloseTo(66.67, 1);
  });

  it("shouts about it in the summary", () => {
    expect(report.summary).toMatch(/THIS SEARCH DID NOT COVER THE WHOLE AREA/);
    expect(report.summary).toMatch(/169\.6 km²/);
    expect(report.summary).toMatch(/still owed/);
  });

  it("never offers the lead target as the reason for the gap", () => {
    // The phrase "because the lead target was reached first" used to appear
    // here. It was the report agreeing with a behaviour that has been removed:
    // the target is a minimum, and it can no longer end a run, so it can no
    // longer explain one either.
    expect(report.summary).not.toMatch(/target was reached first/i);
    expect(report.summary).not.toMatch(/because .*target/i);
  });

  it("still reports the target being met, as a result rather than an ending", () => {
    expect(report.summary).toMatch(
      /43 lead\(s\) found against a minimum target of 40 \(target met\)/,
    );
  });

  it("lists the tiles that were skipped, largest first", () => {
    expect(report.unsearchedTiles).toHaveLength(4);
    expect(report.unsearchedTiles.every((t) => t.state === "pending")).toBe(true);
  });

  it("counts what was and was not finished", () => {
    expect(report.tilesCompleted).toBe(2);
    expect(report.tilesRemaining).toBe(4);
    expect(report.leafTiles).toBe(6);
  });
});

describe("a run that stopped below the target", () => {
  it("does not blame the target for the gap", () => {
    const report = buildCoverageReport({
      tiles: [tile("covered", 50), tile("pending", 50)],
      target: 40,
      leadsFound: 3,
    });

    expect(report.targetReached).toBe(false);
    expect(report.summary).toMatch(/DID NOT COVER/);
    expect(report.summary).not.toMatch(/target was reached first/);
  });
});

describe("permanent gaps", () => {
  const report = buildCoverageReport({
    tiles: [tile("covered", 60), tile("saturated_floor", 40)],
    target: 40,
    leadsFound: 55,
  });

  it("separates a permanent gap from work that is merely owed", () => {
    // Resuming recovers `pending`. Nothing recovers `saturated_floor`.
    expect(report.permanentGap.tiles).toBe(1);
    expect(report.permanentGap.areaKm2).toBe(40);
    expect(report.owed.tiles).toBe(0);
  });

  it("does not count it as coverage", () => {
    expect(report.coveragePct).toBe(60);
    expect(report.fullyCovered).toBe(false);
  });

  it("counts it as finished, because no amount of resuming changes it", () => {
    expect(report.tilesCompleted).toBe(2);
    expect(report.tilesRemaining).toBe(0);
  });

  it("says resuming will not help", () => {
    expect(report.summary).toMatch(/PERMANENT KNOWN GAP/);
    expect(report.summary).toMatch(/resuming will not recover them/);
  });
});

describe("subdivision accounting", () => {
  it("counts leaves only, so a split parent is not double-counted", () => {
    // One 40 km² parent split into four 10 km² children. The area is still 40.
    const report = buildCoverageReport({
      tiles: [
        tile("covered", 60),
        tile("subdivided", 40),
        tile("covered", 10, 1),
        tile("covered", 10, 1),
        tile("pending", 10, 1),
        tile("pending", 10, 1),
      ],
      target: 100,
      leadsFound: 80,
    });

    expect(report.leafTiles).toBe(5);
    expect(report.tilesSubdivided).toBe(1);
    expect(report.areaTotalKm2).toBe(100);
    expect(report.covered.areaKm2).toBe(80);
    expect(report.owed.areaKm2).toBe(20);
    expect(report.coveragePct).toBe(80);
  });

  it("gives a subdivided container no area of its own", () => {
    const report = buildCoverageReport({
      tiles: [tile("subdivided", 40), tile("covered", 40, 1)],
      target: 10,
      leadsFound: 10,
    });

    expect(report.byState.subdivided.areaKm2).toBe(0);
    expect(report.byState.subdivided.tiles).toBe(1);
    expect(report.fullyCovered).toBe(true);
  });
});

describe("resumable states", () => {
  it("treats failed and quota-skipped tiles as owed, not as gaps", () => {
    const report = buildCoverageReport({
      tiles: [
        tile("covered", 25),
        tile("failed", 25),
        tile("skipped_quota", 25),
        tile("pending", 25),
      ],
      target: 40,
      leadsFound: 5,
    });

    expect(report.owed.tiles).toBe(3);
    expect(report.owed.areaKm2).toBe(75);
    expect(report.permanentGap.tiles).toBe(0);
    expect(report.byState.failed.tiles).toBe(1);
    expect(report.byState.skipped_quota.tiles).toBe(1);
  });

  it("counts an in-progress tile as owed, because it is not finished", () => {
    const report = buildCoverageReport({
      tiles: [tile("in_progress", 50), tile("covered", 50)],
      target: 10,
      leadsFound: 2,
    });

    expect(report.owed.tiles).toBe(1);
    expect(report.fullyCovered).toBe(false);
  });
});

describe("degenerate input", () => {
  it("survives a search with no tiles at all", () => {
    const report = buildCoverageReport({ tiles: [], target: 40, leadsFound: 0 });

    expect(report.areaTotalKm2).toBe(0);
    expect(report.coveragePct).toBe(0);
    // No tiles means nothing owed and nothing gapped, so nothing is claimed.
    expect(report.fullyCovered).toBe(true);
    expect(report.leafTiles).toBe(0);
  });

  it("does not divide by zero when every tile has no area", () => {
    const report = buildCoverageReport({
      tiles: [tile("covered", 0), tile("pending", 0)],
      target: 5,
      leadsFound: 1,
    });

    expect(Number.isFinite(report.coveragePct)).toBe(true);
    expect(report.coveragePct).toBe(0);
  });
});
