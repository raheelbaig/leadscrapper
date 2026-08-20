-- 0008_rls.sql
-- Row Level Security.
--
-- This is a single-user personal application: no organizations, no teams, no
-- tenants, no roles. Every policy is simply "the row belongs to the signed-in
-- account". The service-role key used by the worker bypasses RLS by design and
-- must never reach the browser.

alter table public.locations              enable row level security;
alter table public.custom_areas           enable row level security;
alter table public.searches               enable row level security;
alter table public.search_tiles           enable row level security;
alter table public.tile_state_transitions enable row level security;
alter table public.tile_events            enable row level security;
alter table public.search_events          enable row level security;
alter table public.leads                  enable row level security;
alter table public.places_seen            enable row level security;
alter table public.api_usage_counters     enable row level security;
alter table public.api_call_log           enable row level security;
alter table public.exports                enable row level security;
alter table public.app_settings           enable row level security;

-- ---------------------------------------------------------------------------
-- Reference data: readable by the signed-in account, written only by the
-- server (service role bypasses RLS; no write policy exists for clients).
-- ---------------------------------------------------------------------------
drop policy if exists locations_read on public.locations;
create policy locations_read on public.locations
  for select to authenticated using (true);

drop policy if exists transitions_read on public.tile_state_transitions;
create policy transitions_read on public.tile_state_transitions
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Owned rows
-- ---------------------------------------------------------------------------
drop policy if exists custom_areas_own on public.custom_areas;
create policy custom_areas_own on public.custom_areas
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists searches_own on public.searches;
create policy searches_own on public.searches
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists app_settings_own on public.app_settings;
create policy app_settings_own on public.app_settings
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists exports_own on public.exports;
create policy exports_own on public.exports
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists places_seen_own on public.places_seen;
create policy places_seen_own on public.places_seen
  for select to authenticated
  using (user_id = (select auth.uid()));

-- Leads are readable and updatable (e.g. manual email edits) by the owner, but
-- never insertable from the browser: lead rows may only originate from a
-- verified Google response processed on the server.
drop policy if exists leads_read on public.leads;
create policy leads_read on public.leads
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists leads_update on public.leads;
create policy leads_update on public.leads
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists leads_delete on public.leads;
create policy leads_delete on public.leads
  for delete to authenticated using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Search children: ownership flows through the parent search. Read-only from
-- the browser -- tile state may only be changed by the worker, so the UI can
-- never fabricate coverage.
-- ---------------------------------------------------------------------------
drop policy if exists search_tiles_read on public.search_tiles;
create policy search_tiles_read on public.search_tiles
  for select to authenticated
  using (exists (
    select 1 from public.searches s
    where s.id = search_tiles.search_id and s.user_id = (select auth.uid())
  ));

drop policy if exists tile_events_read on public.tile_events;
create policy tile_events_read on public.tile_events
  for select to authenticated
  using (exists (
    select 1 from public.searches s
    where s.id = tile_events.search_id and s.user_id = (select auth.uid())
  ));

drop policy if exists search_events_read on public.search_events;
create policy search_events_read on public.search_events
  for select to authenticated
  using (exists (
    select 1 from public.searches s
    where s.id = search_events.search_id and s.user_id = (select auth.uid())
  ));

-- ---------------------------------------------------------------------------
-- Usage ledger: readable so the dashboard can show it, never writable from the
-- browser. Client-supplied usage numbers are not trusted anywhere.
-- ---------------------------------------------------------------------------
drop policy if exists api_usage_read on public.api_usage_counters;
create policy api_usage_read on public.api_usage_counters
  for select to authenticated using (true);

drop policy if exists api_call_log_read on public.api_call_log;
create policy api_call_log_read on public.api_call_log
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Quota RPCs must not be callable from the browser. Only the server (service
-- role) may reserve, release, or record Google API calls.
-- ---------------------------------------------------------------------------
revoke execute on function public.reserve_api_calls(text, integer, integer, integer, text) from public, anon, authenticated;
revoke execute on function public.release_api_calls(text, integer, text) from public, anon, authenticated;
revoke execute on function public.record_api_call(text, text, text, uuid, uuid, integer, integer, boolean, integer, integer, text) from public, anon, authenticated;
revoke execute on function public.claim_search_job(uuid, integer) from public, anon, authenticated;
revoke execute on function public.heartbeat_job(uuid, uuid, text, uuid, integer) from public, anon, authenticated;
revoke execute on function public.release_job(uuid, uuid, public.search_status, text, text) from public, anon, authenticated;
revoke execute on function public.recover_stalled_tiles(uuid) from public, anon, authenticated;
revoke execute on function public.create_child_tiles(uuid, text) from public, anon, authenticated;
revoke execute on function public.insert_leads_dedup(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.recompute_search_progress(uuid) from public, anon, authenticated;
revoke execute on function public.verify_search_coverage(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- ...but the worker MUST be able to call them.
--
-- `revoke ... from public` removes the implicit PUBLIC grant that CREATE
-- FUNCTION hands out. service_role would then keep EXECUTE only by way of
-- Supabase's project-level default privileges. That is the standard setup and
-- would very probably hold, but if it did not, the failure would appear at the
-- first worker tick as a runtime permission error rather than here at push
-- time -- and every one of these RPCs is on the worker's critical path.
-- Granting explicitly costs nothing and removes the dependency entirely.
-- ---------------------------------------------------------------------------
grant execute on function public.reserve_api_calls(text, integer, integer, integer, text) to service_role;
grant execute on function public.release_api_calls(text, integer, text) to service_role;
grant execute on function public.record_api_call(text, text, text, uuid, uuid, integer, integer, boolean, integer, integer, text) to service_role;
grant execute on function public.claim_search_job(uuid, integer) to service_role;
grant execute on function public.heartbeat_job(uuid, uuid, text, uuid, integer) to service_role;
grant execute on function public.release_job(uuid, uuid, public.search_status, text, text) to service_role;
grant execute on function public.recover_stalled_tiles(uuid) to service_role;
grant execute on function public.create_child_tiles(uuid, text) to service_role;
grant execute on function public.insert_leads_dedup(uuid, uuid, jsonb) to service_role;
grant execute on function public.recompute_search_progress(uuid) to service_role;
grant execute on function public.verify_search_coverage(uuid) to service_role;

-- quota_snapshot is read-only and safe to expose to the dashboard.
grant execute on function public.quota_snapshot(text, integer, integer, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Storage: exports are served through short-lived signed URLs minted on the
-- server. A read policy is added so the owner can also fetch directly.
-- ---------------------------------------------------------------------------
drop policy if exists exports_read_own on storage.objects;
create policy exports_read_own on storage.objects
  for select to authenticated
  using (
    bucket_id = 'exports'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- ---------------------------------------------------------------------------
-- Realtime: the UI subscribes to the denormalized progress row and the event
-- feed. Tile rows are read on demand instead -- subscribing to hundreds of
-- them would be chatty for no added information.
-- ---------------------------------------------------------------------------
-- One block per table, each membership-checked and each with its own handler.
-- Previously a single block wrapped both statements and caught only
-- `duplicate_object`: a failure on the second table would roll back the first
-- (the handler is a subtransaction), and a publication defined FOR ALL TABLES
-- would raise `object_not_in_prerequisite_state`, which went uncaught and would
-- abort the whole migration.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public' and tablename = 'searches'
     )
  then
    alter publication supabase_realtime add table public.searches;
  end if;
exception when others then
  raise notice 'Realtime: could not add public.searches (%). Add it in Dashboard > Database > Replication.', sqlerrm;
end $$;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public' and tablename = 'search_events'
     )
  then
    alter publication supabase_realtime add table public.search_events;
  end if;
exception when others then
  raise notice 'Realtime: could not add public.search_events (%). Add it in Dashboard > Database > Replication.', sqlerrm;
end $$;
