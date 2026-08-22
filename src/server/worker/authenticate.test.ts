import { describe, expect, it } from "vitest";

import { authenticateWorkerRequest } from "./authenticate";

/**
 * The worker endpoint's only door.
 *
 * pg_cron has no session, so this shared secret is the entire authentication
 * story for a route that can spend money. The case that matters most is the
 * third one: an UNSET secret must close the door, not open it.
 */

const SECRET = "a-worker-secret-of-sufficient-length";

function request(headers: Record<string, string> = {}): Request {
  return new Request("https://example.test/api/jobs", { method: "POST", headers });
}

describe("worker authentication", () => {
  it("accepts the exact secret", () => {
    expect(authenticateWorkerRequest(request({ "x-worker-secret": SECRET }), SECRET)).toEqual({
      ok: true,
    });
  });

  it("rejects a wrong secret of the same length", () => {
    const wrong = "b-worker-secret-of-sufficient-length";
    expect(wrong).toHaveLength(SECRET.length);

    const result = authenticateWorkerRequest(request({ "x-worker-secret": wrong }), SECRET);
    expect(result).toEqual({ ok: false, status: 401, reason: "Unauthorized" });
  });

  it("rejects a secret of a different length without throwing", () => {
    // timingSafeEqual throws on mismatched lengths; the guard has to handle
    // that itself rather than letting it become a 500.
    const result = authenticateWorkerRequest(request({ "x-worker-secret": "short" }), SECRET);
    expect(result).toEqual({ ok: false, status: 401, reason: "Unauthorized" });
  });

  it("rejects a prefix of the real secret", () => {
    const result = authenticateWorkerRequest(
      request({ "x-worker-secret": SECRET.slice(0, 20) }),
      SECRET,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(authenticateWorkerRequest(request(), SECRET)).toEqual({
      ok: false,
      status: 401,
      reason: "Unauthorized",
    });
  });

  it("REFUSES when no secret is configured, rather than allowing everything", () => {
    // The inversion this test exists to prevent: treating "no secret set" as
    // "no authentication required" makes the worker world-callable in any
    // environment where the variable was forgotten.
    for (const configured of [undefined, "", "too-short"]) {
      const result = authenticateWorkerRequest(
        request({ "x-worker-secret": "anything" }),
        configured,
      );
      expect(result.ok).toBe(false);
      expect(result).toMatchObject({ status: 503 });
    }
  });

  it("refuses an unconfigured worker even with no header at all", () => {
    const result = authenticateWorkerRequest(request(), undefined);
    expect(result.ok).toBe(false);
  });

  it("leaks nothing about why it failed", () => {
    const wrong = authenticateWorkerRequest(request({ "x-worker-secret": "nope" }), SECRET);
    const missing = authenticateWorkerRequest(request(), SECRET);

    // "wrong" and "absent" are indistinguishable to the caller.
    expect(wrong).toEqual(missing);
  });
});
