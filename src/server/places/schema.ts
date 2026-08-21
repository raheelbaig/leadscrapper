import "server-only";

import { z } from "zod";

/**
 * The documented shape of a Places API (New) Text Search response.
 *
 * Every place field except `id` is OPTIONAL, and that is not defensive
 * programming -- it is what Google actually returns. A business with no phone
 * number simply has no `nationalPhoneNumber` key, and a mask that asks for a
 * field the place does not have gets silence, not null. Treating any of them as
 * required would turn a perfectly good lead into a crashed tile.
 *
 * `id` is the exception: it is the deduplication key, and a place without one
 * cannot be stored or counted, so it is required and a response missing it is
 * genuinely malformed.
 */

export const placesLocationSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
});

export const placesDisplayNameSchema = z.object({
  text: z.string().optional(),
  languageCode: z.string().optional(),
});

export const placeSchema = z.object({
  id: z.string().min(1),
  displayName: placesDisplayNameSchema.optional(),
  formattedAddress: z.string().optional(),
  nationalPhoneNumber: z.string().optional(),
  internationalPhoneNumber: z.string().optional(),
  websiteUri: z.string().optional(),
  location: placesLocationSchema.optional(),
  googleMapsUri: z.string().optional(),
});

/**
 * `places` is absent entirely when there are no results -- Google returns `{}`,
 * not `{"places": []}`. Defaulting to an empty array here is what lets an empty
 * tile be classified as verified-empty rather than as a failure.
 */
export const textSearchResponseSchema = z.object({
  places: z.array(placeSchema).optional().default([]),
  nextPageToken: z.string().optional(),
});

/** The error envelope Google returns with a non-2xx status. */
export const googleErrorResponseSchema = z.object({
  error: z.object({
    code: z.number().optional(),
    message: z.string().optional(),
    status: z.string().optional(),
  }),
});

export type PlacesLocation = z.infer<typeof placesLocationSchema>;
export type Place = z.infer<typeof placeSchema>;
export type TextSearchResponse = z.infer<typeof textSearchResponseSchema>;

/** The rectangle Text Search accepts. It takes a rectangle and nothing else. */
export type PlacesRectangle = {
  low: { latitude: number; longitude: number };
  high: { latitude: number; longitude: number };
};
