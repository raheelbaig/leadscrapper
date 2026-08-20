-- 0003_searches_tiles.sql
-- Searches (also the durable job record) and the tile grid with its
-- database-enforced state machine and append-only event ledger.

-- ---------------------------------------------------------------------------
-- searches: search definition + denormalized progress + worker lease
-- ---------------------------------------------------------------------------
create table if not exists public.searches (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references auth.users(id) on delete cascade,

  -- definition (frozen at creation; never mutated afterwards)
  niche                  text not null,
  query_text             text not null,          -- the niche ALONE, never "niche in city"
  location_id            uuid references public.locations(id) on delete restrict,
  custom_area_id         uuid references public.custom_areas(id) on delete set null,
  country                text not null,
  state                  text,
  city                   text not null,
  label                  text not null,
  min_lat                double precision not null,
  min_lng                double precision not null,
  max_lat                double precision not null,
  max_lng                double precision not null,
  target_leads           integer not null check (target_leads > 0),
  grid_config            jsonb not null,
  grid_key               text not null,
  pricing_version        text not null,
  field_mask             text[] not null,
  search_sku             text not null,

  -- lifecycle
  status                 public.search_status not null default 'draft',
  stop_reason            text,
  last_error             text,

  -- denormalized progress (this row is the Realtime payload for the UI)
  leads_found            integer not null default 0,
  tiles_total            integer not null default 0,
  tiles_pending          integer not null default 0,
  tiles_in_progress      integer not null default 0,
  tiles_covered          integer not null default 0,
  tiles_empty            integer not null default 0,
  tiles_subdivided       integer not null default 0,
  tiles_saturated_floor  integer not null default 0,
  tiles_failed           integer not null default 0,
  tiles_skipped_quota    integer not null default 0,
  area_total_km2         double precision not null default 0,
  area_covered_km2       double precision not null default 0,
  coverage_pct           double precision not null default 0,
  api_calls_run          integer not null default 0,
  current_tile_id        uuid,
  current_page           integer,
  status_text            text,

  -- worker lease (see claim_search_job / heartbeat_job / release_job)
  locked_by              uuid,
  locked_at              timestamptz,
  heartbeat_at           timestamptz,
  tick_count             integer not null default 0,

  coverage_report        jsonb,
  queued_at              timestamptz,
  started_at             timestamptz,
  finished_at            timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint searches_bbox_ordered check (min_lat < max_lat and min_lng < max_lng)
);

create index if not exists searches_user_created_idx
  on public.searches (user_id, created_at desc);
create index if not exists searches_runnable_idx
  on public.searches (queued_at)
  where status in ('queued', 'running');
create index if not exists searches_grid_key_idx on public.searches (grid_key);

drop trigger if exists set_updated_at on public.searches;
create trigger set_updated_at before update on public.searches
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- search_tiles: the geographic grid. A tile with state 'subdivided' is a
-- container, not a leaf; coverage accounting counts leaves only.
-- ---------------------------------------------------------------------------
create table if not exists public.search_tiles (
  id               uuid primary key default gen_random_uuid(),
  search_id        uuid not null references public.searches(id) on delete cascade,
  parent_tile_id   uuid references public.search_tiles(id) on delete cascade,
  depth            integer not null default 0,
  path             text not null,               -- materialized path, e.g. 12.3.1
  label            text not null,               -- human label, e.g. Tile #21

  min_lat          double precision not null,
  min_lng          double precision not null,
  max_lat          double precision not null,
  max_lng          double precision not null,
  edge_km          double precision generated always as (
                     greatest(
                       public.rect_width_km(min_lat, min_lng, max_lat, max_lng),
                       public.rect_height_km(min_lat, max_lat)
                     )
                   ) stored,
  area_km2         double precision generated always as (
                     public.rect_area_km2(min_lat, min_lng, max_lat, max_lng)
                   ) stored,

  state            public.tile_state not null default 'pending',
  last_reason      text,                        -- copied into tile_events by trigger

  results_count    integer not null default 0,  -- R: unique results seen across pages
  unique_new_count integer not null default 0,  -- rows actually inserted (post-dedupe)
  pages_fetched    integer not null default 0,  -- P
  token_after_last boolean not null default false,
  next_page_token  text,
  api_calls        integer not null default 0,
  attempts         integer not null default 0,
  last_error       text,

  started_at       timestamptz,
  completed_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint search_tiles_bbox_ordered check (min_lat < max_lat and min_lng < max_lng)
);

-- Makes subdivision idempotent under retry: re-creating the same child is a no-op.
create unique index if not exists search_tiles_rect_idx
  on public.search_tiles (search_id, min_lat, min_lng, max_lat, max_lng);

create index if not exists search_tiles_state_idx on public.search_tiles (search_id, state);
create index if not exists search_tiles_parent_idx on public.search_tiles (search_id, parent_tile_id);
create index if not exists search_tiles_pending_idx
  on public.search_tiles (search_id, depth, path)
  where state = 'pending';

-- ---------------------------------------------------------------------------
-- Legal state transitions. Enforced by trigger, not by application code:
-- a bug in the runner cannot silently record coverage that never happened.
-- ---------------------------------------------------------------------------
create table if not exists public.tile_state_transitions (
  from_state public.tile_state not null,
  to_state   public.tile_state not null,
  note       text,
  primary key (from_state, to_state)
);

insert into public.tile_state_transitions (from_state, to_state, note) values
  ('pending',       'in_progress',     'worker claimed the tile'),
  ('pending',       'skipped_quota',   'budget guard denied before any request'),
  ('in_progress',   'covered',         'R3: Google exhausted its results'),
  ('in_progress',   'empty',           'R2: verified, nothing here'),
  ('in_progress',   'subdivided',      'R4a: saturated, children enqueued'),
  ('in_progress',   'saturated_floor', 'R4b: saturated at depth/size floor - permanent gap'),
  ('in_progress',   'failed',          'R1: API error after retries'),
  ('in_progress',   'skipped_quota',   'quota exhausted mid-tile'),
  ('in_progress',   'pending',         'crash recovery: a dead process cannot have completed'),
  ('failed',        'pending',         'retry on resume'),
  ('skipped_quota', 'pending',         'retry on resume')
on conflict (from_state, to_state) do nothing;
-- Terminal states (deliberately absent above): covered, empty,
-- saturated_floor, subdivided.

-- ---------------------------------------------------------------------------
-- tile_events: append-only ledger (replaces the v2 events.ndjson)
-- ---------------------------------------------------------------------------
create table if not exists public.tile_events (
  id         bigserial primary key,
  search_id  uuid not null references public.searches(id) on delete cascade,
  tile_id    uuid not null references public.search_tiles(id) on delete cascade,
  from_state public.tile_state,
  to_state   public.tile_state not null,
  reason     text,
  meta       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists tile_events_search_idx on public.tile_events (search_id, id desc);
create index if not exists tile_events_tile_idx on public.tile_events (tile_id, id desc);

create or replace function public.tg_tile_transition_guard()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if new.state is distinct from old.state then
    if not exists (
      select 1 from public.tile_state_transitions t
      where t.from_state = old.state and t.to_state = new.state
    ) then
      raise exception
        'illegal tile transition % -> % for tile % (search %)',
        old.state, new.state, old.id, old.search_id
        using errcode = 'check_violation';
    end if;
  end if;
  new.updated_at = now();
  return new;
end;
$fn$;

create or replace function public.tg_tile_event_log()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if tg_op = 'INSERT' then
    insert into public.tile_events (search_id, tile_id, from_state, to_state, reason, meta)
    values (new.search_id, new.id, null, new.state, coalesce(new.last_reason, 'created'),
            jsonb_build_object('depth', new.depth, 'path', new.path, 'area_km2', new.area_km2));
  elsif new.state is distinct from old.state then
    insert into public.tile_events (search_id, tile_id, from_state, to_state, reason, meta)
    values (new.search_id, new.id, old.state, new.state, new.last_reason,
            jsonb_build_object(
              'results_count', new.results_count,
              'pages_fetched', new.pages_fetched,
              'token_after_last', new.token_after_last,
              'api_calls', new.api_calls,
              'depth', new.depth
            ));
  end if;
  return null;
end;
$fn$;

drop trigger if exists tile_transition_guard on public.search_tiles;
create trigger tile_transition_guard before update on public.search_tiles
  for each row execute function public.tg_tile_transition_guard();

drop trigger if exists tile_event_log on public.search_tiles;
create trigger tile_event_log after insert or update on public.search_tiles
  for each row execute function public.tg_tile_event_log();

-- ---------------------------------------------------------------------------
-- search_events: human-readable timeline shown in the UI activity log
-- ---------------------------------------------------------------------------
create table if not exists public.search_events (
  id         bigserial primary key,
  search_id  uuid not null references public.searches(id) on delete cascade,
  level      public.event_level not null default 'info',
  code       text not null,
  message    text not null,
  meta       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists search_events_search_idx on public.search_events (search_id, id desc);
