"use client";

import { createBrowserClient } from "@supabase/ssr";

import type { Database } from "@/lib/database.types";

import { publicEnv } from "@/lib/public-env";

/**
 * Browser Supabase client. Uses the publishable anon key and is bound by Row
 * Level Security to the signed-in account.
 *
 * Its job is reading and subscribing: searches, tiles, leads, usage. It cannot
 * insert leads, cannot write usage counters, and cannot change tile state --
 * those are server-only paths, so the UI is structurally unable to fabricate
 * coverage or quota numbers.
 */
let client: ReturnType<typeof createBrowserClient<Database>> | null = null;

export function getSupabaseBrowserClient() {
  client ??= createBrowserClient<Database>(publicEnv.supabaseUrl, publicEnv.supabaseAnonKey);
  return client;
}
