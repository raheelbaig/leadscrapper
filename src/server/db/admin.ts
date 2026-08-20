import "server-only";

import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { getServerEnv } from "@/server/config/env";

/**
 * Service-role Supabase client. BYPASSES Row Level Security.
 *
 * Only two callers are legitimate:
 *   1. the tick worker, which is authenticated by the worker secret and has no
 *      user session to act under, and
 *   2. server paths that must write tables the browser is denied (leads, tile
 *      state, usage counters).
 *
 * Importing this module from a client component is a build error, because of
 * the `server-only` import above. Anything it writes on behalf of a user must
 * stamp `user_id` explicitly, since RLS will not do it here.
 */
let admin: ReturnType<typeof createClient<Database>> | null = null;

export function getSupabaseAdminClient() {
  if (!admin) {
    const env = getServerEnv();
    admin = createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return admin;
}
