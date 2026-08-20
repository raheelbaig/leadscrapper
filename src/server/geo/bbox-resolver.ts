import "server-only";

import { persistResolvedLocation } from "./location-store";
import { CacheBboxProvider } from "./providers/cache-provider";
import { CustomAreaBboxProvider } from "./providers/custom-area-provider";
import { FixtureBboxProvider } from "./providers/fixture-provider";
import { GeocodingBboxProvider } from "./providers/geocoding-provider";
import { ManualBboxProvider } from "./providers/manual-provider";
import { PlacesViewportBboxProvider } from "./providers/places-viewport-provider";
import { EXTERNAL_PROVIDERS_ENABLED, PERSIST_RESOLVED_LOCATIONS } from "./resolver-config";
import type { GeoDb } from "./resolved-location";
import type { BboxProvider, LocationQuery, ResolvedLocation } from "./types";

/**
 * The bounding-box resolver chain:
 *
 *   cached location -> custom/manual area -> Geocoding API -> Places viewport
 *   -> manual user entry
 *
 * Order is cheapest-and-most-trusted first. The two Google steps sit in the
 * middle, and while `EXTERNAL_PROVIDERS_ENABLED` is false they are SKIPPED
 * without being invoked at all -- no URL is built, no key is read, no quota is
 * reserved. That is what makes "zero Google calls in Phase 2" a property of the
 * control flow rather than a promise.
 *
 * Every provider returns a rectangle, because `locationRestriction` on Text
 * Search accepts nothing else, and because a rectangle is the only shape that
 * subdivides into four children whose union is exactly the parent.
 */

export type AttemptOutcome = "hit" | "miss" | "skipped" | "error";

export type ResolveAttempt = {
  provider: string;
  outcome: AttemptOutcome;
  /** Why it was skipped, or what went wrong. */
  reason?: string;
  durationMs: number;
};

export type ResolveResult = {
  location: ResolvedLocation;
  attempts: ResolveAttempt[];
  /** Providers that actually reached Google. Zero while Phase 2 is in force. */
  externalCallsMade: number;
  /** True when the answer was written to the `locations` cache by this call. */
  persisted: boolean;
};

export class BboxResolutionError extends Error {
  readonly attempts: ResolveAttempt[];
  constructor(query: LocationQuery, attempts: ResolveAttempt[]) {
    const where = [query.city, query.state, query.country].filter(Boolean).join(", ");
    super(
      `Could not resolve a bounding box for "${where}". ` +
        `Tried: ${attempts.map((a) => `${a.provider}=${a.outcome}`).join(", ")}. ` +
        `Draw the area by hand and try again.`,
    );
    this.name = "BboxResolutionError";
    this.attempts = attempts;
  }
}

export type ResolverOptions = {
  /** Overrides the whole chain. Tests and the mock route use this. */
  providers?: BboxProvider[];
  /** Supabase client for the cache and custom-area providers. */
  db?: GeoDb;
  /** Defaults to `EXTERNAL_PROVIDERS_ENABLED`. Phase 3 turns this on. */
  allowExternal?: boolean;
  /** Defaults to `PERSIST_RESOLVED_LOCATIONS`. */
  persist?: boolean;
  /** Overrides the persistence sink; tests pass a fake. */
  persistFn?: (location: ResolvedLocation) => Promise<ResolvedLocation>;
};

/**
 * The production chain, in order.
 *
 * The fixture provider stands in for Geocoding while external calls are off, so
 * the route still returns a usable rectangle in mock mode. It sits AFTER the
 * real providers so that enabling Phase 3 changes which one answers without any
 * reordering.
 */
export function defaultProviders(
  db?: GeoDb,
  allowExternal = EXTERNAL_PROVIDERS_ENABLED,
): BboxProvider[] {
  const chain: BboxProvider[] = [];

  if (db) {
    chain.push(new CacheBboxProvider(db), new CustomAreaBboxProvider(db));
  }

  chain.push(new GeocodingBboxProvider(), new PlacesViewportBboxProvider());

  if (!allowExternal) {
    chain.push(new FixtureBboxProvider());
  }

  chain.push(new ManualBboxProvider());
  return chain;
}

export async function resolveBbox(
  query: LocationQuery,
  options: ResolverOptions = {},
): Promise<ResolveResult> {
  const allowExternal = options.allowExternal ?? EXTERNAL_PROVIDERS_ENABLED;
  const providers = options.providers ?? defaultProviders(options.db, allowExternal);
  const persist = options.persist ?? PERSIST_RESOLVED_LOCATIONS;

  const attempts: ResolveAttempt[] = [];
  let externalCallsMade = 0;

  for (const provider of providers) {
    if (provider.requiresExternalCall && !allowExternal) {
      attempts.push({
        provider: provider.name,
        outcome: "skipped",
        reason: "External providers are disabled; no Google request was made.",
        durationMs: 0,
      });
      continue;
    }

    const startedAt = Date.now();

    try {
      const location = await provider.resolve(query);
      if (provider.requiresExternalCall) externalCallsMade += 1;

      if (!location) {
        attempts.push({
          provider: provider.name,
          outcome: "miss",
          durationMs: Date.now() - startedAt,
        });
        continue;
      }

      attempts.push({
        provider: provider.name,
        outcome: "hit",
        durationMs: Date.now() - startedAt,
      });

      // A cache hit is already stored, and a rectangle the user typed is theirs
      // to keep as a custom area rather than something to enshrine as the
      // canonical boundary of a city.
      const shouldPersist = persist && !location.fromCache && location.source !== "user_entered";

      if (!shouldPersist) {
        return { location, attempts, externalCallsMade, persisted: false };
      }

      const stored = await (options.persistFn ?? persistResolvedLocation)(location);
      return { location: stored, attempts, externalCallsMade, persisted: true };
    } catch (error) {
      if (provider.requiresExternalCall) externalCallsMade += 1;
      // One broken provider must not abandon the chain -- that is what the
      // chain is for. The failure stays visible in the attempt trail.
      attempts.push({
        provider: provider.name,
        outcome: "error",
        reason: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      });
    }
  }

  throw new BboxResolutionError(query, attempts);
}
