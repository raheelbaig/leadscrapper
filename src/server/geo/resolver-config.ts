import "server-only";

/**
 * The switch that keeps Phase 2 at zero Google calls.
 *
 * While this is false the resolver skips every provider whose
 * `requiresExternalCall` is true. Those providers are not merely prevented from
 * succeeding -- they are never invoked, so no URL is built, no key is read, and
 * no quota is reserved. The guarantee is structural rather than a matter of
 * remembering not to call something.
 *
 * Phase 3 flips this to true in the same change that implements the Geocoding
 * and Places-viewport providers. It is deliberately NOT an environment variable:
 * an env var could be flipped by accident, and there is no legitimate reason for
 * the value to differ between local development and production.
 */
export const EXTERNAL_PROVIDERS_ENABLED = false;

/**
 * Whether a successful resolution is written to the `locations` cache.
 *
 * Off in Phase 2 alongside the mock providers: fixture rectangles are close
 * enough for geometry tests but are not authoritative, and caching one "forever"
 * under a real city's key would poison every future search of that city.
 */
export const PERSIST_RESOLVED_LOCATIONS = EXTERNAL_PROVIDERS_ENABLED;
