import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { buildTextSearchRequest } from "@/server/places/client";

import { NETWORK_GUARD_MESSAGE } from "./setup";

/**
 * Proves which API key the Places client would actually send, in each mode.
 *
 * This exists because the project's first real Google request was spent on a
 * 400 "API key not valid": the test bootstrap overwrote GOOGLE_MAPS_API_KEY
 * unconditionally, so the live run handed Google a dummy string. Reading the
 * bootstrap was not enough to catch that -- the behaviour has to be executed.
 *
 * `buildTextSearchRequest` only BUILDS a request. It opens no socket, so these
 * assertions cost nothing and are safe to run in either mode.
 */

const LIVE = process.env.LEAD_SCRAPPER_LIVE_GOOGLE === "1";
const DUMMY_KEY = "test-google-api-key-not-real";

const BBOX = { minLat: 29.74, minLng: -95.38, maxLat: 29.77, maxLng: -95.35 };

function headerKey(): string {
  return buildTextSearchRequest({ textQuery: "Embroidery Shops", bbox: BBOX }).headers[
    "X-Goog-Api-Key"
  ];
}

/** The real key, read straight from .env.local. Never asserted by value. */
function realKeyFromEnvFile(): string | null {
  try {
    const contents = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const match = /^\s*GOOGLE_MAPS_API_KEY\s*=\s*(.*)\s*$/.exec(line);
      if (match) return match[1].replace(/^["']|["']$/g, "").trim();
    }
  } catch {
    return null;
  }
  return null;
}

describe.skipIf(LIVE)("default mode: Google is unreachable", () => {
  it("substitutes the dummy key", () => {
    expect(process.env.GOOGLE_MAPS_API_KEY).toBe(DUMMY_KEY);
  });

  it("hands the dummy key to the Places client", () => {
    // Even if a request escaped, Google would reject it rather than bill it.
    expect(headerKey()).toBe(DUMMY_KEY);
  });

  it("never carries the real key, whatever .env.local holds", () => {
    const real = realKeyFromEnvFile();
    if (real) {
      expect(process.env.GOOGLE_MAPS_API_KEY).not.toBe(real);
      expect(headerKey()).not.toBe(real);
    }
  });

  it("blocks the network at the global fetch", () => {
    expect(() => (globalThis.fetch as unknown as () => void)()).toThrow(NETWORK_GUARD_MESSAGE);
  });
});

describe.skipIf(!LIVE)("live mode: the real key reaches the client", () => {
  it("does not substitute the dummy", () => {
    expect(process.env.GOOGLE_MAPS_API_KEY).toBeTruthy();
    expect(process.env.GOOGLE_MAPS_API_KEY).not.toBe(DUMMY_KEY);
  });

  it("matches the key configured in .env.local", () => {
    const real = realKeyFromEnvFile();
    expect(real).toBeTruthy();
    expect(process.env.GOOGLE_MAPS_API_KEY).toBe(real);
  });

  it("puts that key in the X-Goog-Api-Key header", () => {
    // Compared by identity, never printed.
    expect(headerKey()).toBe(process.env.GOOGLE_MAPS_API_KEY);
    expect(headerKey()).not.toBe(DUMMY_KEY);
  });

  it("looks like a Google API key", () => {
    // Shape only: Google keys are 39 characters and begin "AIza". A wrong-shaped
    // key would be another wasted call, and shape is free to check.
    const key = process.env.GOOGLE_MAPS_API_KEY!;
    expect(key).toMatch(/^AIza[0-9A-Za-z_-]{35}$/);
  });

  it("still sends only the approved field mask", () => {
    const request = buildTextSearchRequest({ textQuery: "Embroidery Shops", bbox: BBOX });
    expect(request.headers["X-Goog-FieldMask"]).toBe(
      "places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber," +
        "places.internationalPhoneNumber,places.websiteUri,places.location,places.googleMapsUri," +
        "nextPageToken",
    );
    expect(request.body.textQuery).toBe("Embroidery Shops");
    expect(request.body.textQuery).not.toMatch(/houston/i);
  });
});
