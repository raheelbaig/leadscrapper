import { describe, expect, it } from "vitest";

import { RESULT_CEILING, saturationThreshold } from "@/lib/constants";

import { classifyTile, type ClassifyTileInput } from "./classify-tile";

/**
 * R1-R5, exhaustively.
 *
 * This is the function that decides whether a coverage claim is true, so it is
 * worth more assertions than anything else in the phase. The one mistake that
 * matters is calling a truncated tile `covered`: every later number -- the
 * coverage percentage, the "we searched Houston" claim, the decision not to
 * come back -- inherits it, and nothing downstream can detect it.
 */

const SATURATION_ABS = saturationThreshold(0.95);

/** A seed tile with room to split. */
function tile(overrides: Partial<ClassifyTileInput> = {}): ClassifyTileInput {
  return {
    resultsCount: 10,
    tokenRemaining: false,
    pagesFetched: 1,
    depth: 0,
    edgeKm: 8,
    maxSubdivisionDepth: 3,
    minTileEdgeKm: 0.5,
    saturationRatio: 0.95,
    ...overrides,
  };
}

describe("the constants the rules are built on", () => {
  it("puts the ceiling at 60 and saturation at 57", () => {
    expect(RESULT_CEILING).toBe(60);
    expect(SATURATION_ABS).toBe(57);
  });

  it("uses 57 rather than 60, because Google under-fills full pages", () => {
    // Google intermittently returns 18-19 items on a "full" page. Demanding the
    // exact ceiling would read a truncated tile as a complete one.
    expect(SATURATION_ABS).toBeLessThan(RESULT_CEILING);
  });
});

describe("R2 — verified empty", () => {
  it("classifies a tile with no results as empty", () => {
    const result = classifyTile(tile({ resultsCount: 0 }));

    expect(result.state).toBe("empty");
    expect(result.rule).toBe("R2");
    expect(result.saturated).toBe(false);
  });

  it("counts as coverage, because Google was asked and answered", () => {
    const result = classifyTile(tile({ resultsCount: 0 }));
    expect(result.reason).toMatch(/verified empty/i);
  });

  it("does NOT call a tile empty while a page token remains", () => {
    // Vanishingly rare, but "no results yet, more available" is not emptiness.
    const result = classifyTile(tile({ resultsCount: 0, tokenRemaining: true }));
    expect(result.state).not.toBe("empty");
  });
});

describe("R3 — covered", () => {
  it("classifies results with no token and room to spare as covered", () => {
    const result = classifyTile(tile({ resultsCount: 7, tokenRemaining: false }));

    expect(result.state).toBe("covered");
    expect(result.rule).toBe("R3");
    expect(result.saturated).toBe(false);
  });

  it("covers a tile one result below the saturation threshold", () => {
    const result = classifyTile(tile({ resultsCount: SATURATION_ABS - 1 }));
    expect(result.state).toBe("covered");
  });

  it("NEVER covers a tile that still has a page token", () => {
    // The single most important assertion in the file.
    for (const resultsCount of [1, 20, 40, 56]) {
      const result = classifyTile(tile({ resultsCount, tokenRemaining: true }));
      expect(result.state).not.toBe("covered");
    }
  });

  it("NEVER covers a tile at or above the saturation threshold", () => {
    for (const resultsCount of [SATURATION_ABS, 58, 59, RESULT_CEILING]) {
      const result = classifyTile(tile({ resultsCount, tokenRemaining: false }));
      expect(result.state).not.toBe("covered");
    }
  });

  it("says how many results over how many pages, so the claim is auditable", () => {
    const result = classifyTile(tile({ resultsCount: 34, pagesFetched: 2 }));
    expect(result.reason).toContain("34 result(s)");
    expect(result.reason).toContain("2 page(s)");
  });
});

describe("R4a — saturated, subdivided", () => {
  it("subdivides a tile that hit the saturation threshold", () => {
    const result = classifyTile(tile({ resultsCount: SATURATION_ABS }));

    expect(result.state).toBe("subdivided");
    expect(result.rule).toBe("R4a");
    expect(result.saturated).toBe(true);
  });

  it("subdivides a tile that still has a token, however few results it returned", () => {
    const result = classifyTile(tile({ resultsCount: 21, tokenRemaining: true, pagesFetched: 3 }));

    expect(result.state).toBe("subdivided");
    expect(result.rule).toBe("R4a");
  });

  it("halves the edge for the children", () => {
    const result = classifyTile(tile({ resultsCount: 60, edgeKm: 8 }));
    expect(result.childEdgeKm).toBe(4);
  });

  it("subdivides at every depth below the maximum", () => {
    for (const depth of [0, 1, 2]) {
      const result = classifyTile(
        tile({ resultsCount: 60, depth, edgeKm: 8 / 2 ** depth, maxSubdivisionDepth: 3 }),
      );
      expect(result.state).toBe("subdivided");
    }
  });

  it("explains WHY it was saturated, so the split is justified in the ledger", () => {
    const byCount = classifyTile(tile({ resultsCount: 60 }));
    expect(byCount.reason).toMatch(/saturation threshold/);

    const byToken = classifyTile(tile({ resultsCount: 20, tokenRemaining: true }));
    expect(byToken.reason).toMatch(/page token remained/);
  });
});

describe("R4b — saturated at the floor, a permanent gap", () => {
  it("stops at the configured depth", () => {
    const result = classifyTile(tile({ resultsCount: 60, depth: 3, maxSubdivisionDepth: 3 }));

    expect(result.state).toBe("saturated_floor");
    expect(result.rule).toBe("R4b");
  });

  it("stops when the children would be below the size floor", () => {
    const result = classifyTile(
      tile({ resultsCount: 60, depth: 0, edgeKm: 0.8, minTileEdgeKm: 0.5 }),
    );

    // 0.8 / 2 = 0.4, under the 0.5 km floor.
    expect(result.state).toBe("saturated_floor");
    expect(result.childEdgeKm).toBe(0.4);
  });

  it("splits when the children land exactly ON the size floor", () => {
    const result = classifyTile(
      tile({ resultsCount: 60, depth: 0, edgeKm: 1, minTileEdgeKm: 0.5 }),
    );
    expect(result.state).toBe("subdivided");
  });

  it("names it a permanent gap in plain words", () => {
    // The coverage report repeats this verbatim. A user has to be able to read
    // it and understand that resuming will not recover those businesses.
    const result = classifyTile(tile({ resultsCount: 60, depth: 3, maxSubdivisionDepth: 3 }));

    expect(result.reason).toMatch(/PERMANENT GAP/);
    expect(result.reason).toMatch(/never returned/);
  });

  it("says which floor it hit", () => {
    const byDepth = classifyTile(tile({ resultsCount: 60, depth: 1, maxSubdivisionDepth: 1 }));
    expect(byDepth.reason).toMatch(/depth 1 is the configured maximum/);

    const bySize = classifyTile(tile({ resultsCount: 60, edgeKm: 0.6, minTileEdgeKm: 0.5 }));
    expect(bySize.reason).toMatch(/under the 0.5 km floor/);
  });

  it("is reachable at depth 1, which is what the controlled run allows", () => {
    // A depth-1 child that saturates has nowhere left to go, so the controlled
    // Phase 3B run can exercise R4b as well as R4a.
    const result = classifyTile(
      tile({ resultsCount: 60, depth: 1, maxSubdivisionDepth: 1, edgeKm: 4 }),
    );
    expect(result.state).toBe("saturated_floor");
  });
});

describe("R5 — the conservative default", () => {
  it("treats no-subdivision-allowed saturation as a gap, never as coverage", () => {
    // With depth 0 there is no split available, so a saturated tile has to be
    // reported as a gap. Reporting it as covered would be the failure the whole
    // rule table exists to prevent.
    const result = classifyTile(tile({ resultsCount: 60, maxSubdivisionDepth: 0 }));

    expect(result.state).toBe("saturated_floor");
    expect(["covered", "empty"]).not.toContain(result.state);
  });

  it("errs toward subdivision whenever saturation is ambiguous", () => {
    // Erring toward subdivision costs calls; erring toward `covered` costs the
    // truth of the coverage number, and coverage is the stated priority.
    const result = classifyTile(tile({ resultsCount: SATURATION_ABS, pagesFetched: 3 }));
    expect(result.saturated).toBe(true);
  });
});

describe("the saturation ratio is configurable, not hard-coded", () => {
  it("follows the ratio it is given", () => {
    // ceil(0.5 x 60) = 30
    const result = classifyTile(tile({ resultsCount: 30, saturationRatio: 0.5 }));
    expect(result.state).toBe("subdivided");

    const under = classifyTile(tile({ resultsCount: 29, saturationRatio: 0.5 }));
    expect(under.state).toBe("covered");
  });
});
