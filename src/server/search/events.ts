import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

/**
 * The human-readable activity log shown under a search.
 *
 * Append-only and written on the server, so the timeline is a record of what
 * actually happened rather than of what the UI believed at the time. It is in
 * the Realtime publication, which is how the running search narrates itself to
 * an open browser tab.
 *
 * Never put a secret in `meta` -- these rows are readable by the signed-in user
 * and are pushed to the browser verbatim.
 */
export type SearchEventLevel = Database["public"]["Enums"]["event_level"];

export type SearchEventInput = {
  searchId: string;
  level: SearchEventLevel;
  /** Stable machine code, e.g. `tile_covered`. Filterable; never translated. */
  code: string;
  message: string;
  meta?: Record<string, unknown>;
};

export async function logSearchEvent(
  db: SupabaseClient<Database>,
  event: SearchEventInput,
): Promise<void> {
  const { error } = await db.from("search_events").insert({
    search_id: event.searchId,
    level: event.level,
    code: event.code,
    message: event.message,
    meta: (event.meta ?? {}) as never,
  });

  if (error) {
    // The log is not the work. Losing a timeline row must never abort a tick
    // that has already spent a billable Google call.
    console.error(`search_events insert failed (${event.code}): ${error.message}`);
  }
}
