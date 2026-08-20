-- 0001_extensions_enums.sql
-- Base extensions, enums, and shared helper functions.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

do $$ begin
  create type public.search_status as enum (
    'draft', 'queued', 'running', 'paused', 'completed', 'failed', 'canceled'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.tile_state as enum (
    'pending', 'in_progress', 'covered', 'empty',
    'subdivided', 'saturated_floor', 'failed', 'skipped_quota'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.email_status as enum (
    'not_enriched', 'queued', 'found', 'verified', 'unverified', 'not_found', 'failed'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.export_status as enum ('pending', 'ready', 'failed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.bbox_source as enum (
    'cache', 'manual', 'geocoding', 'places', 'user_entered'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.event_level as enum ('info', 'warn', 'error');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function public.tg_set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Billing-period key ("YYYY-MM") in the Google billing timezone.
-- NEVER compute this in UTC: a UTC rollover zeroes the counter up to 8 hours
-- early, and in that window we would believe we had free quota while Google
-- still billed the previous month.
create or replace function public.billing_period(p_tz text)
returns text
language sql
stable
as $$
  select to_char(now() at time zone p_tz, 'YYYY-MM');
$$;

-- Width of a rectangle in kilometres, longitude corrected by cos(latitude)
-- so tiles are square in KILOMETRES rather than in degrees.
create or replace function public.rect_width_km(
  p_min_lat double precision, p_min_lng double precision,
  p_max_lat double precision, p_max_lng double precision
) returns double precision
language sql
immutable
as $$
  select (p_max_lng - p_min_lng) * 111.320
       * cos(radians((p_min_lat + p_max_lat) / 2.0));
$$;

create or replace function public.rect_height_km(
  p_min_lat double precision, p_max_lat double precision
) returns double precision
language sql
immutable
as $$
  select (p_max_lat - p_min_lat) * 110.574;
$$;

create or replace function public.rect_area_km2(
  p_min_lat double precision, p_min_lng double precision,
  p_max_lat double precision, p_max_lng double precision
) returns double precision
language sql
immutable
as $$
  select public.rect_width_km(p_min_lat, p_min_lng, p_max_lat, p_max_lng)
       * public.rect_height_km(p_min_lat, p_max_lat);
$$;
