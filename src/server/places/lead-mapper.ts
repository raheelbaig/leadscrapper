import "server-only";

import type { Place } from "./schema";

/**
 * Maps a Google place onto a `leads` row.
 *
 * Two rules govern everything here:
 *
 *   1. Never invent a value. A business with no phone number gets a null phone,
 *      not an empty string and not a guess. The export sheet is going to be
 *      used to contact real businesses, and a fabricated field is worse than a
 *      blank one.
 *   2. Email is ALWAYS null. The Places API returns no email address in any
 *      field, tier or endpoint. Email arrives later from the enrichment
 *      subsystem, using `website` as its input, and the database CHECK
 *      constraint `leads_email_null_until_enriched` enforces this independently.
 */

/** Matches `insert_leads_dedup`'s jsonb_to_recordset column list exactly. */
export type LeadPayload = {
  place_id: string;
  name: string;
  phone_national: string | null;
  phone_international: string | null;
  address: string | null;
  website: string | null;
  maps_url: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  lat: number | null;
  lng: number | null;
  query_tile: string | null;
  raw: Record<string, unknown>;
};

export type AddressParts = {
  city: string | null;
  state: string | null;
  country: string | null;
  /** How the parts were obtained, recorded so a blank can be explained later. */
  parseMode: "state-postcode" | "comma-positional" | "country-only" | "unparsed";
};

/** "TX 77002", "CA 90210-1234", "NSW 2000" -- a region followed by a postcode. */
const STATE_POSTCODE_RE = /^([A-Za-z][A-Za-z.\s]*?)\s+([A-Z0-9][A-Z0-9\s-]{2,10})$/;

/**
 * Derives city/state/country from `formattedAddress`.
 *
 * The approved field mask does not include `addressComponents`, so the single
 * formatted string is all Google gives us -- and adding that field to the mask
 * to get structured parts would change what every search costs.
 *
 * This is therefore a HEURISTIC over a comma-separated string, and it is
 * written to return nulls rather than guesses when the shape is unfamiliar. The
 * complete place object is kept in `leads.raw`, so a better parser in a later
 * phase can re-derive these columns without re-billing a single call.
 */
export function parseAddressParts(formattedAddress: string | null | undefined): AddressParts {
  const empty: AddressParts = { city: null, state: null, country: null, parseMode: "unparsed" };
  if (!formattedAddress) return empty;

  const parts = formattedAddress
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) return empty;
  if (parts.length < 2) return empty;

  const country = parts[parts.length - 1];
  const region = parts[parts.length - 2];

  // "…, Houston, TX 77002, USA" -- the most common shape by far.
  const match = STATE_POSTCODE_RE.exec(region);
  if (match && parts.length >= 3) {
    return {
      city: parts[parts.length - 3],
      state: match[1].trim(),
      country,
      parseMode: "state-postcode",
    };
  }

  // "…, Houston, Texas, United States" -- no postcode, but still positional.
  if (parts.length >= 3) {
    return {
      city: parts[parts.length - 3],
      state: region,
      country,
      parseMode: "comma-positional",
    };
  }

  // Only two segments: the country is reliable, the rest is not.
  return { city: null, state: null, country, parseMode: "country-only" };
}

/** Trims and collapses "" to null, so a blank never masquerades as a value. */
function nullable(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export type MapContext = {
  /** Human tile label, e.g. "Tile #1". */
  tileLabel: string;
  /** The niche alone -- the same string that was sent as textQuery. */
  queryText: string;
};

export type MappedPlace =
  | { ok: true; lead: LeadPayload }
  | { ok: false; placeId: string; reason: string };

/**
 * A place with no usable name cannot become a lead: `insert_leads_dedup` drops
 * rows whose name is null, and a nameless row in an export is useless anyway.
 * Returning a typed rejection rather than silently skipping means the count of
 * dropped places is reportable instead of invisible.
 */
export function mapPlaceToLead(place: Place, context: MapContext): MappedPlace {
  const name = nullable(place.displayName?.text);

  if (!name) {
    return {
      ok: false,
      placeId: place.id,
      reason: "no displayName.text in the Google response",
    };
  }

  return {
    ok: true,
    lead: {
      place_id: place.id,
      name,
      phone_national: nullable(place.nationalPhoneNumber),
      phone_international: nullable(place.internationalPhoneNumber),
      address: nullable(place.formattedAddress),
      website: nullable(place.websiteUri),
      maps_url: nullable(place.googleMapsUri),
      ...(() => {
        const parts = parseAddressParts(place.formattedAddress);
        return { city: parts.city, state: parts.state, country: parts.country };
      })(),
      lat: place.location?.latitude ?? null,
      lng: place.location?.longitude ?? null,
      query_tile: `${context.tileLabel} · ${context.queryText}`,
      // The verbatim place, so a later phase can re-derive any column without
      // paying Google a second time for the same data.
      raw: place as unknown as Record<string, unknown>,
    },
  };
}

export type MapResult = {
  leads: LeadPayload[];
  rejected: Array<{ placeId: string; reason: string }>;
  /** Distinct place ids in the response, before the database dedupes. */
  receivedCount: number;
};

export function mapPlaces(places: readonly Place[], context: MapContext): MapResult {
  const leads: LeadPayload[] = [];
  const rejected: Array<{ placeId: string; reason: string }> = [];

  for (const place of places) {
    const mapped = mapPlaceToLead(place, context);
    if (mapped.ok) leads.push(mapped.lead);
    else rejected.push({ placeId: mapped.placeId, reason: mapped.reason });
  }

  return { leads, rejected, receivedCount: places.length };
}
