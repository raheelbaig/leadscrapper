-- 0009_cron_worker.sql
-- The durable worker driver.
--
-- pg_cron is the PRIMARY and only required driver. The browser is never a
-- worker: closing the tab, losing the network, or shutting the laptop has no
-- effect on a running search. A self-chain from inside the worker is available
-- purely as a latency optimization and is off by default -- correctness never
-- depends on it.

-- ---------------------------------------------------------------------------
-- SECTION 0 -- PREFLIGHT.
--
-- Everything that can fail for environmental reasons happens here, BEFORE any
-- object is created. If pg_cron or pg_net is unavailable this migration aborts
-- having created nothing at all, so the worker setup can never end up half
-- configured. All checks are idempotent, so a re-run after enabling the
-- extensions in the Dashboard proceeds cleanly.
--
-- Schemas follow Supabase's documented layout:
--   create extension pg_cron with schema pg_catalog;   (functions live in `cron`)
--   create extension pg_net  with schema "extensions"; (functions live in `net`)
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      execute 'create extension pg_cron with schema pg_catalog';
    exception when others then
      raise exception using
        message = 'pg_cron is not installed and could not be created automatically.',
        detail  = sqlerrm,
        hint    = 'Enable pg_cron in the Supabase Dashboard (Database > Extensions), then re-run this migration.';
    end;
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    begin
      execute 'create extension pg_net with schema "extensions"';
    exception when others then
      raise exception using
        message = 'pg_net is not installed and could not be created automatically.',
        detail  = sqlerrm,
        hint    = 'Enable pg_net in the Supabase Dashboard (Database > Extensions), then re-run this migration.';
    end;
  end if;
end $$;

-- Supabase documents these two grants as part of the pg_cron install. They
-- matter when the extension was enabled from the Dashboard (owned by
-- supabase_admin) rather than created by `postgres` here.
do $$
begin
  execute 'grant usage on schema cron to postgres';
  execute 'grant all privileges on all tables in schema cron to postgres';
exception when others then
  raise notice 'cron schema grants skipped (%); continuing to the access probe.', sqlerrm;
end $$;

-- Probe actual usability rather than assuming it. If this cannot read cron.job,
-- neither can cron.schedule below -- and failing here means nothing has been
-- created yet.
do $$
declare
  v_probe integer;
begin
  select count(*) into v_probe from cron.job;
exception when others then
  raise exception using
    message = 'pg_cron is installed but not usable by this role.',
    detail  = sqlerrm,
    hint    = 'Run: grant usage on schema cron to postgres; grant all privileges on all tables in schema cron to postgres;';
end $$;

-- Confirm pg_net exposed the function this migration calls.
do $$
begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'net' and p.proname = 'http_post'
  ) then
    raise exception using
      message = 'pg_net is installed but net.http_post was not found.',
      hint    = 'Re-enable pg_net in the Supabase Dashboard (Database > Extensions).';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- SECTION 1 -- WORKER CONFIGURATION AND FUNCTIONS.
-- Config lives in a `private` schema, which PostgREST does not expose, so the
-- worker secret is unreachable from the browser under any policy mistake.
-- ---------------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.worker_config (
  id             integer primary key default 1 check (id = 1),
  worker_url     text,
  worker_secret  text,
  lease_seconds  integer not null default 90,
  enabled        boolean not null default false,
  updated_at     timestamptz not null default now()
);

insert into private.worker_config (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- dispatch_worker_tick: fire a tick at the Next.js worker endpoint.
--
-- Skips the HTTP call entirely when nothing is runnable, so an idle app makes
-- no requests at all.
-- ---------------------------------------------------------------------------
create or replace function private.dispatch_worker_tick()
returns void
language plpgsql
security definer
set search_path = private, public, net, extensions
as $fn$
declare
  cfg private.worker_config;
begin
  select * into cfg from private.worker_config where id = 1;

  if cfg.worker_url is null or not cfg.enabled then
    return;
  end if;

  if not exists (
    select 1 from public.searches where status in ('queued', 'running')
  ) then
    return;
  end if;

  perform http_post(
    url     := cfg.worker_url,
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-worker-secret', coalesce(cfg.worker_secret, '')
               ),
    body    := jsonb_build_object('source', 'pg_cron', 'at', now()),
    timeout_milliseconds := 5000
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- sweep_expired_leases: if a worker died without releasing, return its tiles
-- to pending so the next tick picks the search back up. This is the safety net
-- that makes crash recovery automatic rather than manual.
-- ---------------------------------------------------------------------------
create or replace function private.sweep_expired_leases()
returns integer
language plpgsql
security definer
set search_path = private, public
as $fn$
declare
  r       record;
  v_count integer := 0;
begin
  for r in
    select s.id, s.locked_by
    from public.searches s, private.worker_config c
    where c.id = 1
      and s.status = 'running'
      and s.locked_at is not null
      and s.heartbeat_at < now() - make_interval(secs => c.lease_seconds * 3)
  loop
    perform public.recover_stalled_tiles(r.id);

    update public.searches
    set locked_by = null, locked_at = null, status_text = null
    where id = r.id;

    insert into public.search_events (search_id, level, code, message, meta)
    values (r.id, 'warn', 'lease_expired',
            'Worker lease expired; search returned to the queue',
            jsonb_build_object('previous_worker', r.locked_by));

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- SECTION 2 -- SCHEDULES. Sub-minute schedules require Postgres 15.1.1.61+.
--
-- Rerunnable by construction: each job is unscheduled by name if present, then
-- scheduled fresh. Section 0 has already proven cron is usable, so a failure
-- here would be a genuine defect rather than an environment problem, and is
-- allowed to abort loudly.
--
-- cron.job_run_details is never pruned automatically and a 30-second schedule
-- writes roughly 86k rows a month, so the third job cleans up after the others.
-- ---------------------------------------------------------------------------
do $$
declare
  j record;
begin
  for j in
    select * from (values
      ('lead-scrapper-worker-tick',
       '30 seconds',
       'select private.dispatch_worker_tick();'),
      ('lead-scrapper-lease-sweep',
       '*/5 * * * *',
       'select private.sweep_expired_leases();'),
      ('lead-scrapper-cron-cleanup',
       '0 4 * * *',
       'delete from cron.job_run_details where end_time < now() - interval ''7 days'';')
    ) as v(jobname, schedule, command)
  loop
    if exists (select 1 from cron.job where jobname = j.jobname) then
      perform cron.unschedule(j.jobname);
    end if;

    perform cron.schedule(j.jobname, j.schedule, j.command);
  end loop;
end $$;
