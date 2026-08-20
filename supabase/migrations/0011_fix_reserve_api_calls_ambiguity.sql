-- 0011_fix_reserve_api_calls_ambiguity.sql
--
-- Fixes a runtime error in reserve_api_calls() found by `supabase db lint`
-- against the live database:
--
--   column reference "period" is ambiguous (SQLSTATE 42702)
--   It could refer to either a PL/pgSQL variable or a table column.
--   ...at: on conflict (period, sku) do update set updated_at = now()
--
-- Cause: the function is declared RETURNS TABLE (..., period text, ...), and
-- every RETURNS TABLE output column is also a PL/pgSQL variable in scope. The
-- INSERT *column list* is not an expression context, so `(period, sku, calls)`
-- is fine -- but the ON CONFLICT *inference clause* IS parsed as an expression
-- context, so PL/pgSQL tried to resolve `period` and found both a variable and
-- a column.
--
-- CREATE FUNCTION does not resolve names inside the body, so the function was
-- created successfully and would only have raised on the first real call --
-- which is the first quota reservation, i.e. before any Google request. It
-- fails closed (exception => no call is made => nothing is billed), so the
-- FREE-ONLY guarantee was never at risk, but the guard would have blocked every
-- search.
--
-- Fix: infer the conflict target by CONSTRAINT NAME instead of by column list.
-- `on conflict on constraint` names no columns, so there is no expression
-- context and no ambiguity. Everything else about the function is byte for byte
-- unchanged -- same locking upsert, same NULL guard, same ceiling test, same
-- return shape (`period` is still returned under that name).
--
-- api_usage_counters_pkey is the PRIMARY KEY (period, sku) declared in 0005;
-- inferring by that constraint selects exactly the same unique index the column
-- list did, so `do update` still takes the row lock and still always returns a
-- row.

do $$
begin
  if not exists (
    select 1
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'api_usage_counters'
      and c.conname = 'api_usage_counters_pkey'
      and c.contype = 'p'
  ) then
    raise exception using
      message = 'Expected primary key constraint public.api_usage_counters_pkey was not found.',
      hint    = 'reserve_api_calls infers its ON CONFLICT target from this constraint name.';
  end if;
end $$;

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
  -- load-bearing: it ALWAYS returns the row and ALWAYS takes the row lock, even
  -- when another transaction inserted this counter and has not committed yet.
  -- A `do nothing` + separate `select ... for update` pair has a read-committed
  -- window where the select sees no row, v_used is NULL, the comparison
  -- evaluates to NULL, and the guard falls through to `granted` while recording
  -- nothing -- authorising a billable call without counting it. A FREE-ONLY
  -- guarantee must not contain a path that grants without counting.
  --
  -- The conflict target is named by CONSTRAINT rather than by column list,
  -- because `on conflict (period, sku)` is an expression context in which
  -- `period` collides with this function's RETURNS TABLE output variable.
  insert into public.api_usage_counters (period, sku, calls)
  values (v_period, p_sku, 0)
  on conflict on constraint api_usage_counters_pkey do update set updated_at = now()
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

-- CREATE OR REPLACE resets privileges to the defaults, so re-apply the explicit
-- grant the worker depends on (and re-revoke browser access) from 0008.
revoke execute on function public.reserve_api_calls(text, integer, integer, integer, text)
  from public, anon, authenticated;
grant execute on function public.reserve_api_calls(text, integer, integer, integer, text)
  to service_role;
