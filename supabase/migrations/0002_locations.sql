-- 0002_locations.sql
-- Resolved city bounding boxes (cached forever) and user-defined custom areas.

-- One row per city, ever. Resolved through the bbox resolver chain:
--   cache -> custom area -> Geocoding API -> Places viewport -> manual entry
-- Bbox resolution uses the Geocoding SKU and must NEVER touch the Enterprise
-- search quota. Lifetime cost of a city is one Geocoding call.
create table if not exists public.locations (
  id                 uuid primary key default gen_random_uuid(),
  country            text not null,
  state              text,
  city               text not null,
  normalized_key     text generated always as (
                       lower(trim(country)) || '|' ||
                       lower(coalesce(trim(state), '')) || '|' ||
                       lower(trim(city))
                     ) stored,
  label              text not null,
  min_lat            double precision not null,
  min_lng            double precision not null,
  max_lat            double precision not null,
  max_lng            double precision not null,
  source             public.bbox_source not null,
  google_place_id    text,
  formatted_address  text,
  address_components jsonb not null default '{}'::jsonb,
  width_km           double precision generated always as (
                       public.rect_width_km(min_lat, min_lng, max_lat, max_lng)
                     ) stored,
  height_km          double precision generated always as (
                       public.rect_height_km(min_lat, max_lat)
                     ) stored,
  area_km2           double precision generated always as (
                       public.rect_area_km2(min_lat, min_lng, max_lat, max_lng)
                     ) stored,
  resolved_at        timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint locations_bbox_ordered check (min_lat < max_lat and min_lng < max_lng),
  constraint locations_bbox_range check (
    min_lat >= -90 and max_lat <= 90 and min_lng >= -180 and max_lng <= 180
  )
);

create unique index if not exists locations_normalized_key_idx
  on public.locations (normalized_key);

drop trigger if exists set_updated_at on public.locations;
create trigger set_updated_at before update on public.locations
  for each row execute function public.tg_set_updated_at();

-- Manual boundaries, e.g. "Greater Houston" instead of Houston city proper.
create table if not exists public.custom_areas (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  name             text not null,
  base_location_id uuid references public.locations(id) on delete set null,
  country          text not null,
  state            text,
  city             text,
  min_lat          double precision not null,
  min_lng          double precision not null,
  max_lat          double precision not null,
  max_lng          double precision not null,
  area_km2         double precision generated always as (
                     public.rect_area_km2(min_lat, min_lng, max_lat, max_lng)
                   ) stored,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint custom_areas_bbox_ordered check (min_lat < max_lat and min_lng < max_lng)
);

create index if not exists custom_areas_user_idx on public.custom_areas (user_id, name);

drop trigger if exists set_updated_at on public.custom_areas;
create trigger set_updated_at before update on public.custom_areas
  for each row execute function public.tg_set_updated_at();
