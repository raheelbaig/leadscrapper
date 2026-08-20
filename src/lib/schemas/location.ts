import { z } from "zod";

/**
 * Shared by the resolve API route and any UI that asks for a bounding box, so
 * the client cannot submit a shape the server does not expect.
 *
 * The range and ordering rules are the same two CHECK constraints the
 * `locations` table enforces (`locations_bbox_ordered`, `locations_bbox_range`),
 * validated here so a bad rectangle is a 400 with a readable message rather than
 * an opaque Postgres error.
 */
export const boundingBoxSchema = z
  .object({
    minLat: z.coerce.number().min(-90).max(90),
    minLng: z.coerce.number().min(-180).max(180),
    maxLat: z.coerce.number().min(-90).max(90),
    maxLng: z.coerce.number().min(-180).max(180),
  })
  .refine((b) => b.minLat < b.maxLat, {
    message: "minLat must be less than maxLat",
    path: ["minLat"],
  })
  .refine((b) => b.minLng < b.maxLng, {
    message: "minLng must be less than maxLng",
    path: ["minLng"],
  });

export const resolveLocationSchema = z.object({
  country: z.string().trim().min(2, "Enter a country").max(80),
  state: z.string().trim().max(80).nullish(),
  city: z.string().trim().min(1, "Enter a city").max(120),
  /** Prefer a saved area such as "Greater Houston" over the city proper. */
  customAreaId: z.string().uuid().nullish(),
  /** Last resort: a rectangle the user drew or typed in. */
  manualBbox: boundingBoxSchema.nullish(),
});

export type ResolveLocationInput = z.input<typeof resolveLocationSchema>;
export type ResolveLocationValues = z.output<typeof resolveLocationSchema>;
