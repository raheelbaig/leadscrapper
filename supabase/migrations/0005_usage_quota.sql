-- 0005_usage_quota.sql
-- The quota ledger and the atomic budget guard.
--
-- FREE ONLY is the product's only mode. There is no paid path, no flag, and no
-- setting that enables one. reserve_api_calls is the single chokepoint every
-- Google request must pass through, and it is atomic inside Postgres so that
-- concurrent workers can never both be granted the last call.
--
-- Free limits and the safety reserve are supplied by the caller from the
-- versioned pricing catalog in the repo, so Google billing numbers live in
-- exactly one place while the atomicity lives here.

create table if not exists public.api_usage_counters (
  period     text not null,       -- YYYY-MM in the Google billing timezone
  sku        text not null,
  calls      integer not null default 0 check (calls >= 0),
  updated_at timestamptz not null default now(),
  primary key (period, sku)
);

-- Audit trail. Powers per-run usage, the usage chart, avgPagesPerTile learning,
-- and reconciliation against the real Google console figures.
create table if not exists public.api_call_log (
  id           bigserial primary key,
  period       text not null,
  sku          text not null,
  search_id    uuid references public.searches(id) on delete set null,
  tile_id      uuid references public.search_tiles(id) on delete set null,
  endpoint     text not null,
  page_index   integer,
  http_status  integer,
  billable     boolean not null default true,
  result_count integer,
  duration_ms  integer,
  error        text,
  created_at   timestamptz not null default now()
);

create index if not exists api_call_log_period_idx on public.api_call_log (period, sku, created_at desc);
create index if not exists api_call_log_search_idx on public.api_call_log (search_id, created_at desc);

-- Daily/history queries index the raw timestamp, NOT a derived day value.
--
-- The obvious `(sku, (created_at::date))` is rejected by PostgreSQL: casting
-- timestamptz to date reads the session TimeZone, which makes it STABLE rather
-- than IMMUTABLE, and an index expression must be immutable. Declaring it
-- immutable anyway would be a lie to the planner -- the stored index entries
-- would silently disagree with the same expression evaluated under a different
-- session timezone, and the index would return wrong rows.
--
-- Two plain stored columns have nothing for PostgreSQL to evaluate, so this
-- index is immutable by construction and cannot fail to build.
--
-- Bucketing by day stays correct because it happens in the QUERY, not the
-- index: the application supplies explicit half-open ranges computed from the
-- pricing catalog's billing timezone (the same timezone that decides the
-- monthly quota reset), e.g.
--
--   where sku = $1 and created_at >= $2 and created_at < $3
--
-- and groups with an explicit `created_at at time zone 'America/Los_Angeles'`.
-- Nothing anywhere depends on the session timezone.
create index if not exists api_call_log_sku_time_idx
  on public.api_call_log (sku, created_at desc);

-- ---------------------------------------------------------------------------
-- reserve_api_calls: THE budget guard. Called before EVERY Google request.
--
-- Each *page* of a Text Search response is a separate billable call, so a fully
-- paginated tile reserves three times, not once.
-- ---------------------------------------------------------------------------
create or replace function public.reserve_api_calls(
  p_sku        text,
  p_n          integer,
  p_free_limit integer,
  p_reserve    integer,
  p_tz         text
) returns table (
  granted   boolean,
  used      integer,
  remaining integer,
  period    text,
  effective_limit integer
)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_period text;
  v_used   integer;
  v_limit  integer;
begin
  if p_n <= 0 then
    raise exception 'reserve_api_calls: p_n must be positive (got %)', p_n;
  end if;

  v_period := public.billing_period(p_tz);
  v_limit  := greatest(p_free_limit - p_reserve, 0);

  -- Locking upsert. `do update` (rather than `do nothing`) is deliberate and
  -- load-bearing: it ALWAYS returns the row and ALWAYS takes the row lock,
  -- even when another transaction inserted this counter and has not committed
  -- yet. The earlier `do nothing` + separate `select ... for update` pair had a
  -- read-committed window where the select saw no row, v_used was NULL, the
  -- comparison evaluated to NULL, and the guard fell through to `granted` while
  -- recording nothing -- authorising a billable call without counting it.
  -- A FREE-ONLY guarantee must not contain a path that grants without counting.
  insert into public.api_usage_counters (period, sku, calls)
  values (v_period, p_sku, 0)
  on conflict (period, sku) do update set updated_at = now()
  returning api_usage_counters.calls into v_used;

  -- Belt and braces: after the upsert v_used cannot be NULL, but a NULL here
  -- would silently disable the ceiling test, so refuse to guess.
  if v_used is null then
    raise exception
      'reserve_api_calls: could not read the counter for sku=% period=%', p_sku, v_period
      using errcode = 'internal_error';
  end if;

  if v_used + p_n > v_limit then
    return query select false, v_used, greatest(v_limit - v_used, 0), v_period, v_limit;
    return;
  end if;

  update public.api_usage_counters
  set calls = calls + p_n, updated_at = now()
  where api_usage_counters.period = v_period and api_usage_counters.sku = p_sku;

  return query
    select true, v_used + p_n, greatest(v_limit - (v_used + p_n), 0), v_period, v_limit;
end;
$fn$;

-- Refund a reservation for a request that produced no billable response
-- (connection error, timeout before any HTTP status). Under countMode
-- 'all-requests' the server simply never calls this.
create or replace function public.release_api_calls(
  p_sku text,
  p_n   integer,
  p_tz  text
) returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_period text;
  v_calls  integer;
begin
  v_period := public.billing_period(p_tz);

  update public.api_usage_counters
  set calls = greatest(calls - p_n, 0), updated_at = now()
  where period = v_period and sku = p_sku
  returning calls into v_calls;

  return coalesce(v_calls, 0);
end;
$fn$;

-- Log an API call and bump the search's run counter in one statement.
create or replace function public.record_api_call(
  p_sku          text,
  p_endpoint     text,
  p_tz           text,
  p_search_id    uuid    default null,
  p_tile_id      uuid    default null,
  p_page_index   integer default null,
  p_http_status  integer default null,
  p_billable     boolean default true,
  p_result_count integer default null,
  p_duration_ms  integer default null,
  p_error        text    default null
) returns bigint
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_id bigint;
begin
  insert into public.api_call_log (
    period, sku, search_id, tile_id, endpoint, page_index,
    http_status, billable, result_count, duration_ms, error
  ) values (
    public.billing_period(p_tz), p_sku, p_search_id, p_tile_id, p_endpoint, p_page_index,
    p_http_status, p_billable, p_result_count, p_duration_ms, p_error
  ) returning id into v_id;

  if p_search_id is not null and p_billable then
    update public.searches
    set api_calls_run = api_calls_run + 1
    where id = p_search_id;
  end if;

  -- Guarded separately: a null tile id would otherwise run a zero-row update
  -- that still fires both tile triggers for nothing.
  if p_tile_id is not null and p_billable then
    update public.search_tiles
    set api_calls = api_calls + 1
    where id = p_tile_id;
  end if;

  return v_id;
end;
$fn$;

-- Read-only quota snapshot for the dashboard and preflight.
create or replace function public.quota_snapshot(
  p_sku        text,
  p_free_limit integer,
  p_reserve    integer,
  p_tz         text
) returns table (
  period          text,
  sku             text,
  used            integer,
  free_limit      integer,
  reserve         integer,
  effective_limit integer,
  remaining       integer
)
language sql
stable
security definer
set search_path = public
as $fn$
  select
    public.billing_period(p_tz)                                          as period,
    p_sku                                                                as sku,
    coalesce(c.calls, 0)                                                 as used,
    p_free_limit                                                         as free_limit,
    p_reserve                                                            as reserve,
    greatest(p_free_limit - p_reserve, 0)                                as effective_limit,
    greatest(greatest(p_free_limit - p_reserve, 0) - coalesce(c.calls, 0), 0) as remaining
  from (select 1) s
  left join public.api_usage_counters c
    on c.period = public.billing_period(p_tz) and c.sku = p_sku;
$fn$;
