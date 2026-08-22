import "server-only";

import { timingSafeEqual } from "node:crypto";

/**
 * Authenticating a worker tick.
 *
 * pg_cron has no user session, so the worker endpoint cannot use the normal
 * auth path. It presents a shared secret in `x-worker-secret`, matched against
 * `WORKER_SECRET`, which lives only in the server environment and in
 * `private.worker_config` -- a schema PostgREST does not expose, so the browser
 * cannot read it under any policy mistake.
 *
 * Three rules, all of which have bitten someone before:
 *
 *   1. Compare in constant time. A `===` on a secret leaks its length and its
 *      prefix to anyone willing to time the responses.
 *   2. Refuse when the secret is UNSET rather than treating "no secret
 *      configured" as "no authentication required". That inversion is how a
 *      worker endpoint ends up world-callable in an environment where the
 *      variable was simply forgotten.
 *   3. Say nothing useful on failure. No hint about length, no distinction
 *      between "missing" and "wrong".
 */

export type WorkerAuthResult = { ok: true } | { ok: false; status: 401 | 503; reason: string };

export function authenticateWorkerRequest(
  request: Request,
  configuredSecret: string | undefined,
): WorkerAuthResult {
  if (!configuredSecret || configuredSecret.length < 16) {
    // Not "allow": REFUSE. An unconfigured worker is a closed door.
    return {
      ok: false,
      status: 503,
      reason: "The worker is not configured on this deployment.",
    };
  }

  const presented = request.headers.get("x-worker-secret");
  if (!presented) {
    return { ok: false, status: 401, reason: "Unauthorized" };
  }

  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(configuredSecret, "utf8");

  // timingSafeEqual throws on a length mismatch, which would itself be a timing
  // signal. Comparing the lengths first and then always running the constant
  // -time compare against a same-length buffer keeps the branch uninformative.
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return { ok: false, status: 401, reason: "Unauthorized" };
  }

  if (!timingSafeEqual(a, b)) {
    return { ok: false, status: 401, reason: "Unauthorized" };
  }

  return { ok: true };
}
