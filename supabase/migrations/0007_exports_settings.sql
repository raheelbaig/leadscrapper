-- 0007_exports_settings.sql
-- Generated workbooks and the single-user application settings row.

create table if not exists public.exports (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  search_id    uuid references public.searches(id) on delete set null,
  kind         text not null default 'xlsx',
  label        text not null,
  filters      jsonb not null default '{}'::jsonb,
  status       public.export_status not null default 'pending',
  storage_path text,
  row_count    integer,
  file_size    integer,
  error        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists exports_user_created_idx on public.exports (user_id, created_at desc);
create index if not exists exports_search_idx on public.exports (search_id, created_at desc);

drop trigger if exists set_updated_at on public.exports;
create trigger set_updated_at before update on public.exports
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- app_settings: one row per user. This app has exactly one user.
--
-- free_only is intentionally a constant `true`, enforced by a CHECK. There is
-- no paid mode to switch to; if one is ever added it will be a deliberate
-- product feature with its own migration, not a toggle someone can flip.
-- ---------------------------------------------------------------------------
create table if not exists public.app_settings (
  user_id         uuid primary key references auth.users(id) on delete cascade,
  grid_defaults   jsonb not null default jsonb_build_object(
                    'sizingStrategy',       'coverage-first',
                    'seedTileEdgeKm',       8,
                    'maxSubdivisionDepth',  3,
                    'minTileEdgeKm',        0.5,
                    'saturationRatio',      0.95,
                    'minSeedTiles',         4,
                    'maxSeedTiles',         400,
                    'stopOnTargetReached',  true
                  ),
  free_only       boolean not null default true,
  reserve_override jsonb,
  default_country text,
  default_state   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint app_settings_free_only_always check (free_only = true)
);

drop trigger if exists set_updated_at on public.app_settings;
create trigger set_updated_at before update on public.app_settings
  for each row execute function public.tg_set_updated_at();

-- Seed a settings row for every account that exists or is created.
create or replace function public.tg_seed_app_settings()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  insert into public.app_settings (user_id) values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$fn$;

drop trigger if exists seed_app_settings on auth.users;
create trigger seed_app_settings after insert on auth.users
  for each row execute function public.tg_seed_app_settings();

insert into public.app_settings (user_id)
select id from auth.users
on conflict (user_id) do nothing;

-- ---------------------------------------------------------------------------
-- Private storage bucket for generated workbooks. Downloads are handed out as
-- short-lived signed URLs minted server-side.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('exports', 'exports', false)
on conflict (id) do nothing;
