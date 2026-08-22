import "server-only";

import { getSupabaseServerClient } from "@/server/db/server-client";

export type SearchRow = {
  id: string;
  niche: string;
  label: string;
  city: string;
  state: string | null;
  country: string;
  status: string;
  stop_reason: string | null;
  target_leads: number;
  leads_found: number;
  coverage_pct: number;
  api_calls_run: number;
  tiles_total: number;
  tiles_pending: number;
  created_at: string;
  finished_at: string | null;
};

/**
 * A generation the user could return to.
 *
 * Only the identity and the phase: every figure the dashboard shows about it is
 * read from the authoritative tables, exactly as the results page does.
 */
export type ActiveGeneration = {
  id: string;
  search_id: string;
  phase: string;
  created_at: string;
  niche: string;
  label: string;
};

export type DashboardSummary = {
  totalLeads: number;
  leadsThisMonth: number;
  emailsFound: number;
  totalSearches: number;
  activeSearches: SearchRow[];
  recentSearches: SearchRow[];
  /** The generation still open, if there is one. At most one can be running. */
  activeGeneration: ActiveGeneration | null;
};

const SEARCH_COLUMNS =
  "id, niche, label, city, state, country, status, stop_reason, target_leads, leads_found, coverage_pct, api_calls_run, tiles_total, tiles_pending, created_at, finished_at";

export async function getDashboardSummary(): Promise<DashboardSummary> {
  const supabase = await getSupabaseServerClient();

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const [totalLeads, monthLeads, emailsFound, totalSearches, active, recent, generation] =
    await Promise.all([
      supabase.from("leads").select("id", { count: "exact", head: true }),
      supabase
        .from("leads")
        .select("id", { count: "exact", head: true })
        .gte("created_at", monthStart.toISOString()),
      supabase
        .from("leads")
        .select("id", { count: "exact", head: true })
        .in("email_status", ["found", "verified", "unverified"]),
      supabase.from("searches").select("id", { count: "exact", head: true }),
      supabase
        .from("searches")
        .select(SEARCH_COLUMNS)
        .in("status", ["queued", "running", "paused"])
        .order("created_at", { ascending: false })
        .limit(5),
      supabase
        .from("searches")
        .select(SEARCH_COLUMNS)
        .order("created_at", { ascending: false })
        .limit(8),
      supabase
        .from("generation_runs")
        .select("id, search_id, phase, created_at, searches!inner(niche, label)")
        .eq("status", "running")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

  const generationRow = generation.data as {
    id: string;
    search_id: string;
    phase: string;
    created_at: string;
    searches: { niche: string; label: string };
  } | null;

  return {
    totalLeads: totalLeads.count ?? 0,
    leadsThisMonth: monthLeads.count ?? 0,
    emailsFound: emailsFound.count ?? 0,
    totalSearches: totalSearches.count ?? 0,
    activeSearches: (active.data ?? []) as unknown as SearchRow[],
    recentSearches: (recent.data ?? []) as unknown as SearchRow[],
    activeGeneration: generationRow
      ? {
          id: generationRow.id,
          search_id: generationRow.search_id,
          phase: generationRow.phase,
          created_at: generationRow.created_at,
          niche: generationRow.searches.niche,
          label: generationRow.searches.label,
        }
      : null,
  };
}

export async function listSearches(): Promise<SearchRow[]> {
  const supabase = await getSupabaseServerClient();
  const { data } = await supabase
    .from("searches")
    .select(SEARCH_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(100);

  return (data ?? []) as unknown as SearchRow[];
}
