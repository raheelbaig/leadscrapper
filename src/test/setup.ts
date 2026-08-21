import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, vi } from "vitest";

/**
 * Test bootstrap.
 *
 * Two jobs, both about safety rather than convenience:
 *
 *   1. Supply DUMMY server environment values. `.env.local` is not loaded for
 *      the normal suite, so a test cannot pick up the real service-role key by
 *      accident.
 *
 *   2. Replace the global `fetch` with a guard that throws. The unit suite must
 *      make no outbound request of any kind; anything that needs one is handed
 *      an explicit `fetchImpl` stub. A test that forgets fails loudly instead of
 *      quietly spending a real call.
 */

/**
 * The database integration suite is opt-in (`LEAD_SCRAPPER_DB_TESTS=1`) and
 * needs real Supabase credentials. ONLY the Supabase variables are read from
 * `.env.local` -- the Google key is overwritten with a dummy below no matter
 * what, so even the integration run is structurally unable to present a key
 * Google would bill.
 */
if (process.env.LEAD_SCRAPPER_DB_TESTS === "1") {
  const allowed = new Set([
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  ]);

  // A deliberate live-Google run needs the real key, and nothing else does.
  // Kept as a SECOND, separate opt-in on top of LEAD_SCRAPPER_DB_TESTS so that
  // reaching the database and reaching Google stay two different decisions.
  if (process.env.LEAD_SCRAPPER_LIVE_GOOGLE === "1") {
    allowed.add("GOOGLE_MAPS_API_KEY");
  }

  try {
    const contents = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (match && allowed.has(match[1])) {
        process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    // No .env.local: the integration suite fails loudly on connect, which is
    // the right way to find out.
  }
}

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://test-project.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
process.env.WORKER_SECRET ??= "test-worker-secret-at-least-16-chars";
process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

// Overwritten unless a live Google run was explicitly asked for.
//
// This line cost the first real request of the project: the smoke test loaded
// the Supabase credentials from .env.local but this assignment still replaced
// the Google key, so Google was handed "test-google-api-key-not-real" and
// answered 400 INVALID_ARGUMENT. The pipeline was fine; the harness was not.
// Hence the explicit flag rather than a silent default either way.
if (process.env.LEAD_SCRAPPER_LIVE_GOOGLE === "1") {
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    throw new Error(
      "LEAD_SCRAPPER_LIVE_GOOGLE=1 but GOOGLE_MAPS_API_KEY is not set. Refusing to " +
        "run a live Google test with no key -- it would spend a call to be rejected.",
    );
  }
  console.warn(
    "*** LIVE GOOGLE MODE: the real API key is loaded and requests WILL be billable. ***",
  );
} else {
  process.env.GOOGLE_MAPS_API_KEY = "test-google-api-key-not-real";
}

export const NETWORK_GUARD_MESSAGE =
  "A test attempted a real network request. Pass an explicit fetchImpl stub instead.";

/**
 * The Supabase client needs a working `fetch`, so the integration suite keeps
 * the platform one. Every other suite gets the guard.
 */
const DB_TESTS = process.env.LEAD_SCRAPPER_DB_TESTS === "1";
const realFetch = globalThis.fetch;

function installNetworkGuard() {
  if (DB_TESTS) {
    globalThis.fetch = realFetch;
    return;
  }
  globalThis.fetch = vi.fn(() => {
    throw new Error(NETWORK_GUARD_MESSAGE);
  }) as unknown as typeof fetch;
}

installNetworkGuard();

// Re-installed before every test, so a suite that legitimately swaps `fetch`
// for its own stub cannot leave the guard removed for the suites that follow.
beforeEach(() => {
  installNetworkGuard();
});
