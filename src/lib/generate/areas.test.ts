import { describe, expect, it } from "vitest";

import { areaOptionId, areasIn, countriesOf, statesOf, type GenerateArea } from "./areas";

/**
 * The area picker's data shaping.
 *
 * The picker exists because a rectangle can only come from a shipped fixture, a
 * saved area, or one drawn by hand while external boundary lookups are off. The
 * cases below pin that a saved area is never confused with a fixture and that
 * an area without a state is offered rather than silently dropped.
 */

const houston: GenerateArea = {
  id: "fixture:United States|Texas|Houston",
  kind: "fixture",
  name: "Houston",
  country: "United States",
  state: "Texas",
  city: "Houston",
  customAreaId: null,
  bbox: { minLat: 29.523, minLng: -95.789, maxLat: 30.11, maxLng: -95.014 },
};

const dallas: GenerateArea = {
  ...houston,
  id: "fixture:United States|Texas|Dallas",
  name: "Dallas",
  city: "Dallas",
};

const london: GenerateArea = {
  id: "fixture:United Kingdom|England|London",
  kind: "fixture",
  name: "London",
  country: "United Kingdom",
  state: "England",
  city: "London",
  customAreaId: null,
  bbox: { minLat: 51.286, minLng: -0.51, maxLat: 51.692, maxLng: 0.334 },
};

const greaterHouston: GenerateArea = {
  id: "custom:11111111-1111-1111-1111-111111111111",
  kind: "custom",
  name: "Greater Houston",
  country: "United States",
  state: "Texas",
  city: "Houston",
  customAreaId: "11111111-1111-1111-1111-111111111111",
  bbox: { minLat: 29.2, minLng: -96.1, maxLat: 30.4, maxLng: -94.7 },
};

const statelessArea: GenerateArea = {
  id: "custom:22222222-2222-2222-2222-222222222222",
  kind: "custom",
  name: "The industrial corridor",
  country: "United States",
  state: null,
  city: "The industrial corridor",
  customAreaId: "22222222-2222-2222-2222-222222222222",
  bbox: { minLat: 29.6, minLng: -95.4, maxLat: 29.8, maxLng: -95.2 },
};

const all = [houston, dallas, london, greaterHouston, statelessArea];

describe("areaOptionId", () => {
  it("keys a fixture by its country, state and city", () => {
    expect(
      areaOptionId({ kind: "fixture", country: "United States", state: "Texas", city: "Houston" }),
    ).toBe("fixture:United States|Texas|Houston");
  });

  it("keys a saved area by its id", () => {
    // A saved rectangle and the fixture city it overlaps are different areas
    // with different boundaries, so they must never collide on one key.
    expect(areaOptionId(greaterHouston)).toBe("custom:11111111-1111-1111-1111-111111111111");
    expect(areaOptionId(greaterHouston)).not.toBe(areaOptionId(houston));
  });

  it("keys a fixture without a state without colliding with one that has none", () => {
    expect(
      areaOptionId({ kind: "fixture", country: "Singapore", state: null, city: "Singapore" }),
    ).toBe("fixture:Singapore||Singapore");
  });
});

describe("countriesOf", () => {
  it("lists each country once, in list order", () => {
    expect(countriesOf(all)).toEqual(["United States", "United Kingdom"]);
  });

  it("returns nothing for an empty list", () => {
    expect(countriesOf([])).toEqual([]);
  });
});

describe("statesOf", () => {
  it("lists the states within one country only", () => {
    expect(statesOf(all, "United Kingdom")).toEqual(["England"]);
  });

  it("represents an area with no state as an empty option rather than dropping it", () => {
    expect(statesOf(all, "United States")).toEqual(["Texas", ""]);
  });
});

describe("areasIn", () => {
  it("returns fixtures and saved areas together", () => {
    const options = areasIn(all, "United States", "Texas");
    expect(options.map((option) => option.name)).toEqual(["Houston", "Dallas", "Greater Houston"]);
  });

  it("keeps saved areas identifiable", () => {
    const options = areasIn(all, "United States", "Texas");
    const saved = options.filter((option) => option.kind === "custom");
    expect(saved).toHaveLength(1);
    expect(saved[0].customAreaId).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("finds an area that has no state", () => {
    const options = areasIn(all, "United States", "");
    expect(options.map((option) => option.name)).toEqual(["The industrial corridor"]);
  });

  it("returns nothing for a combination with no areas", () => {
    expect(areasIn(all, "United Kingdom", "Texas")).toEqual([]);
  });
});
