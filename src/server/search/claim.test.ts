import { describe, expect, it } from "vitest";

import type { Database } from "@/lib/database.types";
import type { SupabaseClient } from "@supabase/supabase-js";

import { ClaimError, claimSearchById } from "./claim";

/**
 * The claim is the mutual-exclusion primitive: holding the lease is what
 * authorises a Google request, so "no row" must never be read as success.
 *
 * These tests exist because `claim_search_job_by_id` is reached through a cast
 * (the generated types will not know it until migration 0012 is pushed), and a
 * cast is exactly where a receiver gets lost.
 */
function fakeDb(response: { data?: unknown; error?: { message: string } }) {
  const calls: Array<Record<string, unknown>> = [];

  // `rpc` is defined as a METHOD that reads `this`, mirroring supabase-js. If
  // the implementation detaches it from the client, `this` is undefined here
  // and the test fails the same way production did.
  const db = {
    marker: "real-client",
    rpc(name: string, args: Record<string, unknown>) {
      expect(this).toBeDefined();
      expect((this as { marker?: string }).marker).toBe("real-client");
      calls.push({ name, ...args });
      return Promise.resolve({ data: response.data ?? null, error: response.error ?? null });
    },
  };

  return { db: db as unknown as SupabaseClient<Database>, calls };
}

const ARGS = {
  searchId: "11111111-1111-4111-8111-111111111111",
  workerId: "22222222-2222-4222-8222-222222222222",
  leaseSeconds: 90,
};

describe("claimSearchById", () => {
  it("keeps the client as the receiver when it calls the RPC", async () => {
    const { db, calls } = fakeDb({ data: [{ id: ARGS.searchId, status: "running" }] });

    const row = await claimSearchById(db, ARGS);

    expect(row?.id).toBe(ARGS.searchId);
    expect(calls[0]).toEqual({
      name: "claim_search_job_by_id",
      p_search: ARGS.searchId,
      p_worker: ARGS.workerId,
      p_lease_seconds: 90,
    });
  });

  it("returns null when the lease was not granted", async () => {
    // Someone else holds it, or the search is not runnable. Not an error --
    // but the caller must not proceed to Google either.
    const { db } = fakeDb({ data: [] });
    await expect(claimSearchById(db, ARGS)).resolves.toBeNull();
  });

  it("explains how to fix a missing migration rather than leaking PostgREST", async () => {
    const { db } = fakeDb({
      error: { message: "Could not find the function public.claim_search_job_by_id" },
    });

    await expect(claimSearchById(db, ARGS)).rejects.toThrow(ClaimError);
    await expect(claimSearchById(db, ARGS)).rejects.toThrow(/migration 0012/);
  });

  it("surfaces any other database failure as a claim failure", async () => {
    const { db } = fakeDb({ error: { message: "deadlock detected" } });
    await expect(claimSearchById(db, ARGS)).rejects.toThrow(/deadlock detected/);
  });
});
