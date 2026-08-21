import { describe, expect, it } from "vitest";

import { mapPlaceToLead, mapPlaces, parseAddressParts } from "./lead-mapper";
import type { Place } from "./schema";

const CONTEXT = { tileLabel: "Tile #1", queryText: "Embroidery Shops" };

const COMPLETE: Place = {
  id: "ChIJcomplete",
  displayName: { text: "Bayou City Embroidery", languageCode: "en" },
  formattedAddress: "1200 Main St, Houston, TX 77002, USA",
  nationalPhoneNumber: "(713) 555-0142",
  internationalPhoneNumber: "+1 713-555-0142",
  websiteUri: "https://bayoucityembroidery.example",
  location: { latitude: 29.7551, longitude: -95.3662 },
  googleMapsUri: "https://maps.google.com/?cid=1",
};

describe("a complete result", () => {
  const mapped = mapPlaceToLead(COMPLETE, CONTEXT);
  const lead = mapped.ok ? mapped.lead : null;

  it("maps every field onto the leads row", () => {
    expect(lead).toMatchObject({
      place_id: "ChIJcomplete",
      name: "Bayou City Embroidery",
      phone_national: "(713) 555-0142",
      phone_international: "+1 713-555-0142",
      address: "1200 Main St, Houston, TX 77002, USA",
      website: "https://bayoucityembroidery.example",
      maps_url: "https://maps.google.com/?cid=1",
      lat: 29.7551,
      lng: -95.3662,
    });
  });

  it("records which tile and query produced it", () => {
    expect(lead?.query_tile).toBe("Tile #1 · Embroidery Shops");
  });

  it("keeps the verbatim place so a later phase need not re-bill for it", () => {
    expect(lead?.raw).toMatchObject({ id: "ChIJcomplete" });
  });

  it("never carries an email, because Places has no email field at any tier", () => {
    expect(lead).not.toHaveProperty("email");
    expect(JSON.stringify(lead)).not.toMatch(/"email"\s*:/);
  });
});

describe("missing optional fields", () => {
  it("nulls a missing phone, website, maps URL and location", () => {
    const mapped = mapPlaceToLead(
      { id: "ChIJbare", displayName: { text: "No Frills Stitching" } },
      CONTEXT,
    );

    expect(mapped.ok).toBe(true);
    const lead = mapped.ok ? mapped.lead : null;
    expect(lead).toMatchObject({
      place_id: "ChIJbare",
      name: "No Frills Stitching",
      phone_national: null,
      phone_international: null,
      address: null,
      website: null,
      maps_url: null,
      lat: null,
      lng: null,
      city: null,
      state: null,
      country: null,
    });
  });

  it("treats a blank string as absent rather than storing an empty value", () => {
    const mapped = mapPlaceToLead(
      {
        id: "ChIJblank",
        displayName: { text: "Blank Fields Co" },
        nationalPhoneNumber: "   ",
        websiteUri: "",
      },
      CONTEXT,
    );

    const lead = mapped.ok ? mapped.lead : null;
    expect(lead?.phone_national).toBeNull();
    expect(lead?.website).toBeNull();
  });

  it("keeps a place that has only one of the two phone numbers", () => {
    const mapped = mapPlaceToLead(
      {
        id: "ChIJonephone",
        displayName: { text: "One Phone Embroidery" },
        internationalPhoneNumber: "+1 713-555-0199",
      },
      CONTEXT,
    );

    const lead = mapped.ok ? mapped.lead : null;
    expect(lead?.phone_national).toBeNull();
    expect(lead?.phone_international).toBe("+1 713-555-0199");
  });

  it("rejects a place with no usable name instead of inventing one", () => {
    // insert_leads_dedup drops rows with a null name, and a nameless row in an
    // export is useless. Reporting the rejection makes the loss countable.
    const mapped = mapPlaceToLead({ id: "ChIJnoname" }, CONTEXT);
    expect(mapped.ok).toBe(false);
    if (!mapped.ok) {
      expect(mapped.placeId).toBe("ChIJnoname");
      expect(mapped.reason).toMatch(/displayName/);
    }
  });

  it("rejects a place whose displayName has no text", () => {
    const mapped = mapPlaceToLead({ id: "ChIJempty", displayName: { languageCode: "en" } }, CONTEXT);
    expect(mapped.ok).toBe(false);
  });
});

describe("address parsing", () => {
  it("reads the US state-plus-postcode shape", () => {
    expect(parseAddressParts("1200 Main St, Houston, TX 77002, USA")).toEqual({
      city: "Houston",
      state: "TX",
      country: "USA",
      parseMode: "state-postcode",
    });
  });

  it("handles a ZIP+4", () => {
    const parts = parseAddressParts("55 Elm Ave, Bellaire, TX 77401-1234, USA");
    expect(parts.city).toBe("Bellaire");
    expect(parts.state).toBe("TX");
  });

  it("handles a spelled-out state with no postcode", () => {
    expect(parseAddressParts("1200 Main St, Houston, Texas, United States")).toEqual({
      city: "Houston",
      state: "Texas",
      country: "United States",
      parseMode: "comma-positional",
    });
  });

  it("keeps only the country when the address has two segments", () => {
    // Guessing a city from "London SW1A 2AA" would be an invention.
    expect(parseAddressParts("10 Downing St, UK")).toEqual({
      city: null,
      state: null,
      country: "UK",
      parseMode: "country-only",
    });
  });

  it("returns nulls for an absent or unusable address", () => {
    for (const input of [null, undefined, "", "   ", "Houston"]) {
      expect(parseAddressParts(input)).toMatchObject({
        city: null,
        state: null,
        country: null,
        parseMode: "unparsed",
      });
    }
  });

  it("records how the parts were derived, so a blank can be explained", () => {
    expect(parseAddressParts("1200 Main St, Houston, TX 77002, USA").parseMode).toBe(
      "state-postcode",
    );
  });
});

describe("mapping a whole response", () => {
  it("splits accepted leads from rejected places", () => {
    const result = mapPlaces(
      [
        COMPLETE,
        { id: "ChIJnoname" },
        { id: "ChIJok2", displayName: { text: "Second Shop" } },
      ],
      CONTEXT,
    );

    expect(result.receivedCount).toBe(3);
    expect(result.leads.map((l) => l.place_id)).toEqual(["ChIJcomplete", "ChIJok2"]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].placeId).toBe("ChIJnoname");
  });

  it("handles an empty response without special-casing it", () => {
    const result = mapPlaces([], CONTEXT);
    expect(result.leads).toEqual([]);
    expect(result.rejected).toEqual([]);
    expect(result.receivedCount).toBe(0);
  });

  it("passes duplicates straight through to the database", () => {
    // Deduplication is the unique constraint on (search_id, place_id), never an
    // in-memory Set here -- a Set does not survive a crash, a resume, or two
    // ticks running back to back.
    const result = mapPlaces([COMPLETE, COMPLETE], CONTEXT);
    expect(result.leads).toHaveLength(2);
    expect(result.leads[0].place_id).toBe(result.leads[1].place_id);
  });

  it("produces rows whose keys match insert_leads_dedup's column list", () => {
    const result = mapPlaces([COMPLETE], CONTEXT);
    expect(Object.keys(result.leads[0]).sort()).toEqual(
      [
        "address",
        "city",
        "country",
        "lat",
        "lng",
        "maps_url",
        "name",
        "phone_international",
        "phone_national",
        "place_id",
        "query_tile",
        "raw",
        "state",
        "website",
      ].sort(),
    );
  });
});
