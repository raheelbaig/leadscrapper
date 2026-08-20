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

export type DashboardSummary = {
  totalLeads: number;
  leadsThisMonth: number;
  totalSearches: number;
  activeSearches: SearchRow[];
  recentSearches: SearchRow[];
};

const SEARCH_COLUMNS =
  "id, niche, label, city, state, country, status, stop_reason, target_leads, leads_found, coverage_pct, api_calls_run, tiles_total, tiles_pending, created_at, finished_at";

export async function getDashboardSummary(): Promise<DashboardSummary> {
  const supabase = await getSupabaseServerClient();

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const [totalLeads, monthLeads, totalSearches, active, recent] = await Promise.all([
    supabase.from("leads").select("id", { count: "exact", head: true }),
    supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .gte("created_at", monthStart.toISOString()),
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
  ]);

  return {
    totalLeads: totalLeads.count ?? 0,
    leadsThisMonth: monthLeads.count ?? 0,
    totalSearches: totalSearches.count ?? 0,
    activeSearches: (active.data ?? []) as unknown as SearchRow[],
    recentSearches: (recent.data ?? []) as unknown as SearchRow[],
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
