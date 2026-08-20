import "server-only";

import { z } from "zod";

import catalogJson from "./catalog.json";

export const skuSchema = z.object({
  label: z.string(),
  tierRank: z.number().int().min(1),
  freeCallsPerMonth: z.number().int().min(0),
  pricePer1000: z.number().min(0),
});

export const pricingCatalogSchema = z.object({
  version: z.string(),
  lastVerified: z.string(),
  verified: z.boolean(),
  sourceUrl: z.string().url(),
  stalenessWarnAfterDays: z.number().int().min(1),
  billingTimezone: z.string(),
  safety: z.object({
    reserveAbsolute: z.number().int().min(0),
    reservePercent: z.number().min(0).max(1),
    reserveMode: z.enum(["max", "absolute", "percent"]),
    countMode: z.enum(["success-only", "all-requests"]),
  }),
  skus: z.record(z.string(), skuSchema),
  fieldTiers: z.record(z.string(), z.string()),
});

export type PricingCatalog = z.infer<typeof pricingCatalogSchema>;
export type SkuId = string;

let cached: PricingCatalog | null = null;

/** Validated at first read; a malformed catalog stops the process loudly. */
export function getPricingCatalog(): PricingCatalog {
  if (cached) return cached;

  const parsed = pricingCatalogSchema.safeParse(catalogJson);
  if (!parsed.success) {
    throw new Error(
      `src/server/pricing/catalog.json is invalid:\n` +
        parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n"),
    );
  }

  // Every SKU referenced by a field must exist, or classification would
  // silently fall through to a cheaper tier than Google actually bills.
  for (const [field, sku] of Object.entries(parsed.data.fieldTiers)) {
    if (!parsed.data.skus[sku]) {
      throw new Error(`catalog.json: field "${field}" maps to unknown SKU "${sku}"`);
    }
  }

  cached = parsed.data;
  return cached;
}

export function catalogAgeDays(catalog: PricingCatalog): number {
  const verified = new Date(catalog.lastVerified);
  return Math.floor((Date.now() - verified.getTime()) / 86_400_000);
}

export function isCatalogStale(catalog: PricingCatalog): boolean {
  return !catalog.verified || catalogAgeDays(catalog) > catalog.stalenessWarnAfterDays;
}

/** reserve = max(absolute, percent x limit), per the catalog's reserveMode. */
export function reserveFor(catalog: PricingCatalog, freeLimit: number): number {
  const { reserveAbsolute, reservePercent, reserveMode } = catalog.safety;
  const pct = Math.ceil(freeLimit * reservePercent);

  switch (reserveMode) {
    case "absolute":
      return reserveAbsolute;
    case "percent":
      return pct;
    case "max":
    default:
      return Math.max(reserveAbsolute, pct);
  }
}
