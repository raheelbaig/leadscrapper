import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

/**
 * Typed wrapper for `claim_search_job_by_id` (migration 0012).
 *
 * The claim is the mutual-exclusion primitive: at most one runner may hold a
 * search, and holding it is what authorises a Google request. "No row" means
 * "you did not get the lease" and must never be treated as success.
 *
 * This used to route through an untyped `RpcEscapeHatch` cast, because the
 * generated types are produced from the LIVE database and did not yet know
 * about a function whose migration had not been pushed. 0013 is applied and
 * `npm run db:types` has been re-run, so the cast is gone and the call is
 * checked against the real signature.
 */
export type ClaimedSearch = Database["public"]["Tables"]["searches"]["Row"];

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
  const { data, error } = await db.rpc("claim_search_job_by_id", {
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
