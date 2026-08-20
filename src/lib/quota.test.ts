import { describe, expect, it } from "vitest";

import {
  QUOTA_STATE_META,
  QUOTA_WARNING_RATIO,
  affordableCalls,
  canAfford,
  deriveQuotaFigures,
  resolveQuotaState,
} from "./quota";

/** The catalog's Enterprise shape: 1,000 free, max(50, 5%) = 50 reserved. */
const ENTERPRISE = { freeLimit: 1000, reserve: 50 };

describe("protected remaining", () => {
  it("is freeLimit - used - reserve", () => {
    const figures = deriveQuotaFigures({ ...ENTERPRISE, used: 412 });
    expect(figures.effectiveLimit).toBe(950);
    expect(figures.protectedRemaining).toBe(538);
    expect(figures.remaining).toBe(538);
    expect(figures.health).toBe("healthy");
  });

  it("reports nothing used as a full allowance", () => {
    const figures = deriveQuotaFigures({ ...ENTERPRISE, used: 0 });
    expect(figures.remaining).toBe(950);
    expect(figures.percentUsed).toBe(0);
    expect(figures.health).toBe("healthy");
  });

  it("warns once most of the usable allowance is spent", () => {
    const figures = deriveQuotaFigures({ ...ENTERPRISE, used: 900 });
    expect(figures.remaining).toBe(50);
    expect(figures.percentUsed).toBeCloseTo((900 / 950) * 100, 6);
    expect(figures.health).toBe("warning");
  });

  it("switches to warning exactly at the threshold", () => {
    const atThreshold = Math.ceil(950 * QUOTA_WARNING_RATIO);
    expect(deriveQuotaFigures({ ...ENTERPRISE, used: atThreshold }).health).toBe("warning");
    expect(deriveQuotaFigures({ ...ENTERPRISE, used: atThreshold - 30 }).health).toBe("healthy");
  });

  it("is exhausted at the exact boundary, not one call past it", () => {
    // used == effectiveLimit means the next call would be denied by the SQL
    // guard, so the UI must already say so.
    const figures = deriveQuotaFigures({ ...ENTERPRISE, used: 950 });
    expect(figures.remaining).toBe(0);
    expect(figures.protectedRemaining).toBe(0);
    expect(figures.percentUsed).toBe(100);
    expect(figures.health).toBe("exhausted");
  });

  it("keeps counter drift visible instead of rounding it away", () => {
    // The local counter can drift past the ceiling -- a retried request, a call
    // made elsewhere with the same key. `remaining` clamps at zero to match the
    // SQL RPC; `protectedRemaining` stays signed so the drift is still legible.
    const figures = deriveQuotaFigures({ ...ENTERPRISE, used: 1200 });
    expect(figures.protectedRemaining).toBe(-250);
    expect(figures.remaining).toBe(0);
    expect(figures.percentUsed).toBeGreaterThan(100);
    expect(figures.percentUsedClamped).toBe(100);
    expect(figures.health).toBe("exhausted");
  });

  it("treats a reserve that swallows the allowance as exhausted", () => {
    // A 50-call floor against a 40-call allowance leaves nothing to spend.
    const figures = deriveQuotaFigures({ freeLimit: 40, reserve: 50, used: 0 });
    expect(figures.effectiveLimit).toBe(0);
    expect(figures.remaining).toBe(0);
    expect(figures.percentUsed).toBe(100);
    expect(figures.health).toBe("exhausted");
  });

  it("normalises nonsense inputs rather than propagating them", () => {
    const figures = deriveQuotaFigures({ freeLimit: -100, reserve: -10, used: -5 });
    expect(figures.freeLimit).toBe(0);
    expect(figures.reserve).toBe(0);
    expect(figures.used).toBe(0);
    expect(figures.remaining).toBe(0);
  });
});

describe("reserve sizing", () => {
  it("withholds the percentage when it exceeds the absolute floor", () => {
    // Essentials: 5% of 10,000 = 500, far past the 50-call floor.
    const figures = deriveQuotaFigures({ freeLimit: 10_000, reserve: 500, used: 0 });
    expect(figures.effectiveLimit).toBe(9_500);
  });

  it("withholds the floor when the percentage is smaller", () => {
    const figures = deriveQuotaFigures({ freeLimit: 200, reserve: 50, used: 0 });
    expect(figures.effectiveLimit).toBe(150);
  });
});

describe("affordability", () => {
  const figures = deriveQuotaFigures({ ...ENTERPRISE, used: 940 });

  it("mirrors the SQL guard: used + n <= effectiveLimit", () => {
    expect(canAfford(figures, 10)).toBe(true);
    expect(canAfford(figures, 11)).toBe(false);
  });

  it("counts pages, so a fully paginated tile asks for three", () => {
    const nearlyFull = deriveQuotaFigures({ ...ENTERPRISE, used: 948 });
    expect(canAfford(nearlyFull, 1)).toBe(true);
    expect(canAfford(nearlyFull, 3)).toBe(false);
  });

  it("reports how much of a request would fit", () => {
    expect(affordableCalls(figures, 100)).toBe(10);
    expect(affordableCalls(figures, 4)).toBe(4);
    expect(affordableCalls(deriveQuotaFigures({ ...ENTERPRISE, used: 950 }), 5)).toBe(0);
  });

  it("treats a zero-call request as always affordable", () => {
    expect(canAfford(figures, 0)).toBe(true);
  });
});

describe("multiple SKUs", () => {
  it("computes each allowance independently", () => {
    const skus = [
      { sku: "enterprise", freeLimit: 1000, reserve: 50, used: 990 },
      { sku: "pro", freeLimit: 5000, reserve: 250, used: 100 },
      { sku: "geocoding", freeLimit: 10_000, reserve: 500, used: 0 },
    ];

    const figures = skus.map((s) => ({ sku: s.sku, ...deriveQuotaFigures(s) }));

    expect(figures[0].health).toBe("exhausted");
    expect(figures[1].health).toBe("healthy");
    expect(figures[2].health).toBe("healthy");
    // Exhausting the Enterprise search allowance must not imply that resolving
    // a city through Geocoding is blocked -- they are separate counters.
    expect(figures[2].remaining).toBe(9_500);
  });
});

describe("displayable state", () => {
  it("shows unverified pricing when quota is otherwise fine", () => {
    expect(resolveQuotaState("healthy", false)).toBe("unverified");
    expect(resolveQuotaState("warning", false)).toBe("unverified");
  });

  it("lets exhaustion outrank unverified pricing", () => {
    // Both block a request, but only one explains why the run stopped.
    expect(resolveQuotaState("exhausted", false)).toBe("exhausted");
  });

  it("passes the quota level through once pricing is verified", () => {
    expect(resolveQuotaState("healthy", true)).toBe("healthy");
    expect(resolveQuotaState("warning", true)).toBe("warning");
    expect(resolveQuotaState("exhausted", true)).toBe("exhausted");
  });

  it("has presentation metadata for every state", () => {
    for (const state of ["healthy", "warning", "exhausted", "unverified"] as const) {
      expect(QUOTA_STATE_META[state].label).toMatch(/\S/);
      expect(QUOTA_STATE_META[state].description).toMatch(/\S/);
    }
  });
});
