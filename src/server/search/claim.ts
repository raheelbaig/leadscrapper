import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

/**
 * Typed wrapper for `claim_search_job_by_id` (migration 0012).
 *
 * The generated `src/lib/database.types.ts` is produced from the LIVE database,
 * so it will not know about this function until migration 0012 has been pushed
 * and `npm run db:types` has been re-run. The cast below is the seam that lets
 * the application compile in between.
 *
 * TODO(phase-3b): after 0012 is applied and the types are regenerated, delete
 * `RpcEscapeHatch` and call `db.rpc("claim_search_job_by_id", …)` directly. The
 * cast is a temporary accommodation for an un-pushed migration, not a pattern.
 *
 * The claim is the mutual-exclusion primitive: at most one runner may hold a
 * search, and holding it is what authorises a Google request. "No row" means
 * "you did not get the lease" and must never be treated as success.
 */
export type ClaimedSearch = Database["public"]["Tables"]["searches"]["Row"];

type RpcEscapeHatch = (
  name: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

export class ClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaimError";
  }
}

export async function claimSearchById(
  db: SupabaseClient<Database>,
  args: { searchId: string; workerId: string; leaseSeconds: number },
): Promise<ClaimedSearch | null> {
  // `.bind(db)` is load-bearing, not style. supabase-js implements `rpc` as a
  // METHOD that reaches for `this.rest`; casting the bare property detaches it
  // from its receiver and every call dies with
  // "Cannot read properties of undefined (reading 'rest')" -- which looks like
  // a missing migration but is not one.
  const rpc = db.rpc.bind(db) as unknown as RpcEscapeHatch;

  const { data, error } = await rpc("claim_search_job_by_id", {
    p_search: args.searchId,
    p_worker: args.workerId,
    p_lease_seconds: args.leaseSeconds,
  });

  if (error) {
    if (/could not find the function|does not exist|schema cache/i.test(error.message)) {
      throw new ClaimError(
        "The database is missing claim_search_job_by_id. Apply migration 0012 " +
          "(supabase db push) and regenerate types with npm run db:types.",
      );
    }
    throw new ClaimError(`Could not claim the search: ${error.message}`);
  }

  const rows = Array.isArray(data) ? (data as ClaimedSearch[]) : [];
  return rows[0] ?? null;
}
