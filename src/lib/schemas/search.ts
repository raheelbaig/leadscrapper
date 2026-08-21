import { z } from "zod";

import { DEFAULT_GRID_CONFIG } from "@/lib/constants";
import { boundingBoxSchema } from "@/lib/schemas/location";

/**
 * Shared between the create-search form and the API route that receives it.
 * One schema, so the client cannot submit a shape the server does not expect.
 */
export const gridConfigSchema = z.object({
  sizingStrategy: z.enum(["coverage-first", "target-scaled", "fixed"]),
  seedTileEdgeKm: z.coerce.number().min(0.5).max(50),
  maxSubdivisionDepth: z.coerce.number().int().min(0).max(6),
  minTileEdgeKm: z.coerce.number().min(0.1).max(10),
  saturationRatio: z.coerce.number().min(0.5).max(1),
  minSeedTiles: z.coerce.number().int().min(1).max(100),
  maxSeedTiles: z.coerce.number().int().min(1).max(2000),
  stopOnTargetReached: z.boolean(),
});

export const createSearchSchema = z.object({
  niche: z
    .string()
    .trim()
    .min(2, "Enter a business niche")
    .max(120, "Keep the niche short")
    // Naming the city inside the query pulls Google's ranking back toward the
    // city centroid and defeats the whole point of tiling.
    .refine((v) => !/\bin\s+\w/i.test(v), {
      message: 'Leave the location out of the niche — use just "Embroidery Shops"',
    }),
  country: z.string().trim().min(2, "Enter a country").max(80),
  state: z.string().trim().max(80).optional().or(z.literal("")),
  city: z.string().trim().min(1, "Enter a city").max(120),
  customAreaId: z.string().uuid().optional().nullable(),
  targetLeads: z.coerce
    .number({ message: "Enter a number" })
    .int("Whole numbers only")
    .min(1, "Target at least 1 lead")
    .max(100_000, "That is far beyond what any city lists"),
  gridConfig: gridConfigSchema.default(DEFAULT_GRID_CONFIG),
  /**
   * An explicit rectangle for a controlled test run.
   *
   * When present it is used ALONE -- the cache, custom-area and fixture
   * providers are skipped entirely. Falling through to them would let a request
   * for a small test area silently resolve to the full city bounding box, which
   * is the one thing a controlled test must never do.
   */
  testBbox: boundingBoxSchema.nullish(),
});

export type CreateSearchInput = z.input<typeof createSearchSchema>;
export type CreateSearchValues = z.output<typeof createSearchSchema>;

export const searchActionSchema = z.object({
  action: z.enum(["pause", "resume", "cancel"]),
});
