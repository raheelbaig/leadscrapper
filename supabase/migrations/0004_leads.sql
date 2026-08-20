-- 0004_leads.sql
-- Leads and cross-run place awareness.
--
-- Deduplication is a database constraint, not an in-memory Set: it stays
-- correct across crashes, resumes, and concurrent ticks.

create table if not exists public.leads (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  search_id           uuid not null references public.searches(id) on delete cascade,
  tile_id             uuid references public.search_tiles(id) on delete set null,

  place_id            text not null,
  name                text not null,
  phone_national      text,
  phone_international text,
  address             text,
  website             text,
  maps_url            text,
  city                text,
  state               text,
  country             text,
  lat                 double precision,
  lng                 double precision,
  query_tile          text,     -- exported "Query Tile" column: tile label + query

  -- Email is ALWAYS null at insert time. The Google Places API has no email
  -- field in any tier or endpoint. Email arrives later, from the enrichment
  -- subsystem, using `website` as its input.
  email               text,
  email_status        public.email_status not null default 'not_enriched',
  email_source        text,
  email_confidence    numeric(4, 3),
  email_checked_at    timestamptz,

  is_new_globally     boolean not null default true,
  raw                 jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint leads_email_null_until_enriched check (
    email is null or email_status <> 'not_enriched'
  )
);

-- The dedupe key. insert ... on conflict do nothing returning id makes the
-- returned row count the exact number of new unique leads.
create unique index if not exists leads_search_place_idx
  on public.leads (search_id, place_id);

create index if not exists leads_search_created_idx on public.leads (search_id, created_at desc);
create index if not exists leads_user_place_idx on public.leads (user_id, place_id);
create index if not exists leads_email_status_idx on public.leads (user_id, email_status);
create index if not exists leads_tile_idx on public.leads (tile_id);
create index if not exists leads_enrichable_idx
  on public.leads (user_id)
  where website is not null and email_status = 'not_enriched';

drop trigger if exists set_updated_at on public.leads;
create trigger set_updated_at before update on public.leads
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- places_seen: cross-run awareness WITHOUT discarding data.
--
-- Re-running the same city still returns its full dataset; we only flag which
-- leads are new to this account. Dropping already-seen places would make a
-- re-run report "0 new leads" and lose the rest of the sheet.
-- ---------------------------------------------------------------------------
create table if not exists public.places_seen (
  place_id        text not null,
  user_id         uuid not null references auth.users(id) on delete cascade,
  first_search_id uuid references public.searches(id) on delete set null,
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  times_seen      integer not null default 1,
  primary key (user_id, place_id)
);
