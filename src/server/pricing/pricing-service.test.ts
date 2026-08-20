import { describe, expect, it } from "vitest";

import { PLACES_FIELD_MASK } from "@/lib/constants";

import { getPricingCatalog } from "./catalog.schema";
import {
  PricingError,
  classify,
  estimateCost,
  getBillingTimezone,
  getFreeLimit,
  getPricePer1000,
  getPrimarySku,
  getReserve,
  getSkuConfig,
  getSkuForEndpoint,
  getStalenessInfo,
  getVersion,
  listSkuIds,
} from "./pricing-service";

const catalog = getPricingCatalog();

const ENTERPRISE = "places-text-search-enterprise";
const PRO = "places-text-search-pro";
const ESSENTIALS = "places-text-search-essentials";
const GEOCODING = "geocoding-essentials";

describe("catalog integrity", () => {
  it("exposes every SKU the field map can select", () => {
    for (const sku of Object.values(catalog.fieldTiers)) {
      expect(listSkuIds()).toContain(sku);
    }
  });

  it("orders the Places tiers Essentials < Pro < Enterprise", () => {
    expect(getSkuConfig(ESSENTIALS).tierRank).toBeLessThan(getSkuConfig(PRO).tierRank);
    expect(getSkuConfig(PRO).tierRank).toBeLessThan(getSkuConfig(ENTERPRISE).tierRank);
  });

  it("gives the expensive tier the smallest free allowance", () => {
    // If this ever inverts, the estimator would be optimistic about the SKU
    // that actually runs out first.
    expect(getFreeLimit(ENTERPRISE)).toBeLessThan(getFreeLimit(PRO));
    expect(getFreeLimit(PRO)).toBeLessThan(getFreeLimit(ESSENTIALS));
  });

  it("reads free limits and prices from the catalog, not from code", () => {
    for (const sku of listSkuIds()) {
      expect(getFreeLimit(sku)).toBe(catalog.skus[sku].freeCallsPerMonth);
      expect(getPricePer1000(sku)).toBe(catalog.skus[sku].pricePer1000);
    }
  });

  it("resets the billing month in the configured zone, never UTC", () => {
    expect(getBillingTimezone()).toBe(catalog.billingTimezone);
    expect(getBillingTimezone()).not.toBe("UTC");
  });

  it("throws for an unknown SKU rather than defaulting to a cheap one", () => {
    expect(() => getSkuConfig("places-text-search-imaginary")).toThrow(PricingError);
  });
});

describe("reserve", () => {
  it("is max(absolute, percent x limit) per the catalog's reserveMode", () => {
    const { reserveAbsolute, reservePercent, reserveMode } = catalog.safety;
    expect(reserveMode).toBe("max");

    for (const sku of listSkuIds()) {
      const expected = Math.max(reserveAbsolute, Math.ceil(getFreeLimit(sku) * reservePercent));
      expect(getReserve(sku)).toBe(expected);
    }
  });

  it("lets the absolute floor win on a small allowance", () => {
    // Enterprise: 5% of 1,000 is 50, equal to the floor -- so the floor is what
    // protects the smallest allowance, which is the one that matters most.
    const enterprise = getSkuConfig(ENTERPRISE);
    expect(enterprise.reserve).toBeGreaterThanOrEqual(catalog.safety.reserveAbsolute);
    expect(enterprise.effectiveLimit).toBe(enterprise.freeCallsPerMonth - enterprise.reserve);
  });

  it("lets the percentage win on a large allowance", () => {
    // Essentials: 5% of 10,000 is 500, well past the 50-call floor.
    expect(getReserve(ESSENTIALS)).toBeGreaterThan(catalog.safety.reserveAbsolute);
  });
});

describe("classify", () => {
  it("classifies an Essentials-only mask as Essentials", () => {
    expect(classify(["places.id"]).sku).toBe(ESSENTIALS);
  });

  it("classifies a Pro mask as Pro", () => {
    const result = classify([
      "places.id",
      "places.displayName",
      "places.formattedAddress",
      "places.location",
    ]);
    expect(result.sku).toBe(PRO);
    expect(result.escalatedForUnknown).toBe(false);
  });

  it("classifies the real product field mask as Enterprise", () => {
    // Phone and website are Enterprise fields and both are required by the
    // product, so every lead-search call is an Enterprise call.
    const result = classify(PLACES_FIELD_MASK);
    expect(result.sku).toBe(ENTERPRISE);
    expect(result.decidingField).toMatch(/PhoneNumber|websiteUri/);
  });

  it("bills a mixed mask at the most expensive field in it", () => {
    // A single Enterprise field bills the WHOLE request at Enterprise.
    expect(classify(["places.id", "places.websiteUri"]).sku).toBe(ENTERPRISE);
    expect(classify(["places.id", "places.displayName"]).sku).toBe(PRO);
  });

  it("escalates an unknown field to the most expensive tier", () => {
    const result = classify(["places.id", "places.somethingGoogleAddedLater"]);
    expect(result.sku).toBe(ENTERPRISE);
    expect(result.escalatedForUnknown).toBe(true);
    expect(result.unknownFields).toEqual(["places.somethingGoogleAddedLater"]);
    expect(result.knownFields).toEqual(["places.id"]);
  });

  it("ignores duplicate fields", () => {
    const once = classify(["places.id", "places.websiteUri"]);
    const twice = classify(["places.id", "places.websiteUri", "places.id", "places.websiteUri"]);
    expect(twice.sku).toBe(once.sku);
    expect(twice.fields).toEqual(once.fields);
  });

  it("refuses an empty field mask instead of guessing", () => {
    // Google rejects a request with no mask, and an unclassifiable request
    // cannot be metered -- so there is no safe answer to invent.
    expect(() => classify([])).toThrow(PricingError);
    expect(() => classify(["", "   "])).toThrow(PricingError);
  });

  it("accepts bare field names as well as places-prefixed ones", () => {
    expect(classify(["websiteUri"]).sku).toBe(ENTERPRISE);
    expect(classify(["id"]).sku).toBe(ESSENTIALS);
  });

  it("never selects a SKU no field can reach", () => {
    // Geocoding is billed by endpoint, not by a Places field mask.
    for (const mask of [["places.id"], ["places.displayName"], PLACES_FIELD_MASK]) {
      expect(classify(mask).sku).not.toBe(GEOCODING);
    }
  });

  it("derives the primary search SKU from the mask rather than naming it", () => {
    expect(getPrimarySku()).toBe(classify(PLACES_FIELD_MASK).sku);
    expect(getPrimarySku()).toBe(ENTERPRISE);
  });

  it("maps the geocoding endpoint to a SKU that exists", () => {
    expect(getSkuForEndpoint("geocoding")).toBe(GEOCODING);
    expect(() => getSkuConfig(getSkuForEndpoint("geocoding"))).not.toThrow();
  });
});

describe("estimateCost", () => {
  it("costs nothing inside the free allowance", () => {
    const estimate = estimateCost({ sku: ENTERPRISE, calls: 10 });
    expect(estimate.billableCalls).toBe(0);
    expect(estimate.estimatedCostUsd).toBe(0);
    expect(estimate.withinFreeAllowance).toBe(true);
  });

  it("prices only the calls past the free allowance", () => {
    const freeLimit = getFreeLimit(ENTERPRISE);
    const estimate = estimateCost({ sku: ENTERPRISE, calls: 100, alreadyUsed: freeLimit - 40 });

    expect(estimate.freeCallsApplied).toBe(40);
    expect(estimate.billableCalls).toBe(60);
    expect(estimate.estimatedCostUsd).toBeCloseTo((60 / 1000) * getPricePer1000(ENTERPRISE), 10);
    expect(estimate.withinFreeAllowance).toBe(false);
  });

  it("does not re-charge calls already past the allowance", () => {
    const freeLimit = getFreeLimit(ENTERPRISE);
    const estimate = estimateCost({ sku: ENTERPRISE, calls: 10, alreadyUsed: freeLimit + 500 });
    expect(estimate.billableCalls).toBe(10);
  });

  it("rejects a negative call count", () => {
    expect(() => estimateCost({ sku: ENTERPRISE, calls: -1 })).toThrow(PricingError);
  });
});

describe("staleness and versioning", () => {
  it("reports a version", () => {
    expect(getVersion()).toBe(catalog.version);
    expect(getVersion()).toMatch(/\S/);
  });

  it("treats an unverified catalog as stale regardless of its age", () => {
    const info = getStalenessInfo();
    // Guarding the Phase 2 rule: the catalog must NOT be marked verified
    // without explicit approval, and the UI must keep warning until it is.
    expect(info.verified).toBe(false);
    expect(info.stale).toBe(true);
  });

  it("carries the information the warning UI needs", () => {
    const info = getStalenessInfo();
    expect(info.sourceUrl).toMatch(/^https:\/\//);
    expect(info.stalenessWarnAfterDays).toBeGreaterThan(0);
    expect(Number.isFinite(info.ageDays)).toBe(true);
  });
});
