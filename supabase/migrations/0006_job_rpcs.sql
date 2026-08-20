-- 0006_job_rpcs.sql
-- The durable job protocol: lease, heartbeat, release, crash recovery,
-- subdivision, dedupe insert, progress recomputation, coverage invariants.
--
-- Correctness must not depend on how long a worker tick is allowed to run.
-- Every function here is small and idempotent; a tick that dies at any point
-- loses at most the single in-flight page, and the next tick resumes cleanly.

-- ---------------------------------------------------------------------------
-- claim_search_job: the mutual-exclusion primitive.
--
-- At most one worker may hold a search at a time. This is what makes it
-- impossible for two ticks to bill Google for the same tile.
-- ---------------------------------------------------------------------------
create or replace function public.claim_search_job(
  p_worker         uuid,
  p_lease_seconds  integer default 90
) returns setof public.searches
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_id uuid;
begin
  select s.id into v_id
  from public.searches s
  where s.status in ('queued', 'running')
    and (
      s.locked_at is null
      or s.heartbeat_at is null
      or s.heartbeat_at < now() - make_interval(secs => p_lease_seconds)
    )
  order by (s.status = 'running') desc, s.queued_at asc nulls last
  limit 1
  for update skip locked;

  if v_id is null then
    return;
  end if;

  return query
  update public.searches s
  set status       = 'running',
      locked_by    = p_worker,
      locked_at    = now(),
      heartbeat_at = now(),
      tick_count   = s.tick_count + 1,
      started_at   = coalesce(s.started_at, now()),
      last_error   = null
  where s.id = v_id
  returning s.*;
end;
$fn$;

-- Returns false if the lease was lost (stolen or released). The worker must
-- then abort immediately without issuing another Google request.
create or replace function public.heartbeat_job(
  p_search uuid,
  p_worker uuid,
  p_status_text text default null,
  p_current_tile uuid default null,
  p_current_page integer default null
) returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_ok boolean;
begin
  update public.searches
  set heartbeat_at    = now(),
      status_text     = coalesce(p_status_text, status_text),
      current_tile_id = coalesce(p_current_tile, current_tile_id),
      current_page    = coalesce(p_current_page, current_page)
  where id = p_search and locked_by = p_worker and status = 'running'
  returning true into v_ok;

  return coalesce(v_ok, false);
end;
$fn$;

create or replace function public.release_job(
  p_search      uuid,
  p_worker      uuid,
  p_status      public.search_status,
  p_stop_reason text default null,
  p_last_error  text default null
) returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_ok boolean;
begin
  update public.searches
  set status      = p_status,
      stop_reason = coalesce(p_stop_reason, stop_reason),
      last_error  = p_last_error,
      locked_by   = null,
      locked_at   = null,
      status_text = null,
      current_tile_id = null,
      current_page    = null,
      finished_at = case
                      when p_status in ('completed', 'failed', 'canceled') then now()
                      else finished_at
                    end
  where id = p_search and (locked_by = p_worker or locked_by is null)
  returning true into v_ok;

  return coalesce(v_ok, false);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- recover_stalled_tiles: a dead process cannot have completed a tile.
-- Never record coverage that was not verified, even to save an API call.
-- ---------------------------------------------------------------------------
create or replace function public.recover_stalled_tiles(p_search uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_count integer;
begin
  with reset as (
    update public.search_tiles
    set state           = 'pending',
        last_reason     = 'interrupted',
        next_page_token = null,   -- page tokens expire; restart the tile at page 1
        started_at      = null
    where search_id = p_search and state = 'in_progress'
    returning 1
  )
  select count(*) into v_count from reset;

  if v_count > 0 then
    insert into public.search_events (search_id, level, code, message, meta)
    values (p_search, 'warn', 'tiles_recovered',
            v_count || ' interrupted tile(s) returned to pending',
            jsonb_build_object('count', v_count));
  end if;

  return v_count;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- create_child_tiles: split a rectangle at its lat/lng midpoints into exactly
-- four children, so the union of the children always equals the parent --
-- no gaps and no overlap, by construction.
--
-- Planning is free; only searching costs. Children are created even when the
-- budget is exhausted, so coverage debt stays visible and resumable.
--
-- RETURNS the total number of children the parent has after the call, NOT the
-- number newly inserted. A successful first call and a successful idempotent
-- retry both return 4, so the caller can assert `= 4` and never has to read a
-- legitimate no-op retry as a failure.
--
-- The function is all-or-nothing: it raises unless the parent ends up
-- 'subdivided' with exactly four children. That matters for the coverage
-- invariant -- children existing beside a parent that is still a leaf would
-- overlap it, which is precisely what verify_search_coverage flags as broken.
-- ---------------------------------------------------------------------------
create or replace function public.create_child_tiles(
  p_tile   uuid,
  p_reason text default 'saturated'
) returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  t          public.search_tiles;
  v_mid_lat  double precision;
  v_mid_lng  double precision;
  v_created  integer;
  v_children integer;
  v_state    public.tile_state;
begin
  select * into t from public.search_tiles where id = p_tile for update;
  if not found then
    raise exception 'create_child_tiles: tile % not found', p_tile;
  end if;

  v_mid_lat := (t.min_lat + t.max_lat) / 2.0;
  v_mid_lng := (t.min_lng + t.max_lng) / 2.0;

  with quadrants as (
    select * from (values
      ('sw', t.min_lat, t.min_lng, v_mid_lat, v_mid_lng),
      ('se', t.min_lat, v_mid_lng, v_mid_lat, t.max_lng),
      ('nw', v_mid_lat, t.min_lng, t.max_lat, v_mid_lng),
      ('ne', v_mid_lat, v_mid_lng, t.max_lat, t.max_lng)
    ) as q(quad, min_lat, min_lng, max_lat, max_lng)
  ),
  ins as (
    insert into public.search_tiles (
      search_id, parent_tile_id, depth, path, label,
      min_lat, min_lng, max_lat, max_lng, state, last_reason
    )
    select t.search_id, t.id, t.depth + 1,
           t.path || '.' || q.quad,
           t.label || '/' || upper(q.quad),
           q.min_lat, q.min_lng, q.max_lat, q.max_lng,
           'pending', 'subdivided_from_parent'
    from quadrants q
    on conflict (search_id, min_lat, min_lng, max_lat, max_lng) do nothing
    returning 1
  )
  select count(*) into v_created from ins;

  update public.search_tiles
  set state = 'subdivided', last_reason = p_reason, completed_at = now()
  where id = p_tile and state = 'in_progress';

  -- Verify the parent actually became a container. On an idempotent retry it is
  -- already 'subdivided' and the update above matches nothing, which is fine.
  -- Any other state means we would be leaving four children overlapping a
  -- still-live leaf, so refuse and let the transaction roll back.
  select state into v_state from public.search_tiles where id = p_tile;

  if v_state <> 'subdivided' then
    raise exception
      'create_child_tiles: tile % is in state %, cannot subdivide (expected in_progress or subdivided)',
      p_tile, v_state
      using errcode = 'check_violation';
  end if;

  select count(*) into v_children
  from public.search_tiles
  where parent_tile_id = p_tile;

  if v_children <> 4 then
    raise exception
      'create_child_tiles: tile % has % children after subdivision, expected 4 (newly created: %)',
      p_tile, v_children, v_created
      using errcode = 'check_violation';
  end if;

  return v_children;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- insert_leads_dedup: deduplication as a database constraint.
-- Returns how many rows were actually new for this search.
-- ---------------------------------------------------------------------------
create or replace function public.insert_leads_dedup(
  p_search uuid,
  p_tile   uuid,
  p_leads  jsonb
) returns table (inserted integer, received integer)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_user     uuid;
  v_inserted integer;
  v_received integer;
begin
  select user_id into v_user from public.searches where id = p_search;
  if v_user is null then
    raise exception 'insert_leads_dedup: search % not found', p_search;
  end if;

  select count(*) into v_received
  from jsonb_array_elements(coalesce(p_leads, '[]'::jsonb));

  with incoming as (
    select
      x.place_id, x.name, x.phone_national, x.phone_international, x.address,
      x.website, x.maps_url, x.city, x.state, x.country, x.lat, x.lng,
      x.query_tile, coalesce(x.raw, '{}'::jsonb) as raw
    from jsonb_to_recordset(coalesce(p_leads, '[]'::jsonb)) as x(
      place_id            text,
      name                text,
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
      query_tile          text,
      raw                 jsonb
    )
    where x.place_id is not null and x.name is not null
  ),
  deduped as (
    select distinct on (place_id) * from incoming order by place_id
  ),
  ins as (
    insert into public.leads (
      user_id, search_id, tile_id, place_id, name,
      phone_national, phone_international, address, website, maps_url,
      city, state, country, lat, lng, query_tile, raw, is_new_globally
    )
    select
      v_user, p_search, p_tile, d.place_id, d.name,
      d.phone_national, d.phone_international, d.address, d.website, d.maps_url,
      d.city, d.state, d.country, d.lat, d.lng, d.query_tile, d.raw,
      not exists (
        select 1 from public.places_seen ps
        where ps.user_id = v_user and ps.place_id = d.place_id
      )
    from deduped d
    on conflict (search_id, place_id) do nothing
    returning place_id
  ),
  seen as (
    insert into public.places_seen (place_id, user_id, first_search_id)
    select i.place_id, v_user, p_search from ins i
    on conflict (user_id, place_id) do update
      set last_seen_at = now(), times_seen = places_seen.times_seen + 1
    returning 1
  )
  select count(*) into v_inserted from ins;

  if p_tile is not null then
    update public.search_tiles
    set unique_new_count = unique_new_count + v_inserted
    where id = p_tile;
  end if;

  return query select v_inserted, v_received;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- recompute_search_progress: rebuild every denormalized counter from the
-- tiles and leads tables. Self-healing, so a missed increment can never make
-- the dashboard drift away from the truth. Called at the end of every tick.
-- ---------------------------------------------------------------------------
create or replace function public.recompute_search_progress(p_search uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  with leaf as (
    select * from public.search_tiles
    where search_id = p_search and state <> 'subdivided'
  ),
  agg as (
    select
      (select count(*) from leaf)                                          as total,
      (select count(*) from leaf where state = 'pending')                  as pending,
      (select count(*) from leaf where state = 'in_progress')              as in_progress,
      (select count(*) from leaf where state = 'covered')                  as covered,
      (select count(*) from leaf where state = 'empty')                    as empty_n,
      (select count(*) from leaf where state = 'saturated_floor')          as sat_floor,
      (select count(*) from leaf where state = 'failed')                   as failed_n,
      (select count(*) from leaf where state = 'skipped_quota')            as skipped,
      (select count(*) from public.search_tiles
        where search_id = p_search and state = 'subdivided')               as subdivided,
      (select coalesce(sum(area_km2), 0) from leaf)                        as area_total,
      (select coalesce(sum(area_km2), 0) from leaf
        where state in ('covered', 'empty'))                               as area_covered,
      (select count(*) from public.leads where search_id = p_search)       as leads
  )
  update public.searches s
  set tiles_total           = agg.total,
      tiles_pending         = agg.pending,
      tiles_in_progress     = agg.in_progress,
      tiles_covered         = agg.covered,
      tiles_empty           = agg.empty_n,
      tiles_saturated_floor = agg.sat_floor,
      tiles_failed          = agg.failed_n,
      tiles_skipped_quota   = agg.skipped,
      tiles_subdivided      = agg.subdivided,
      area_total_km2        = agg.area_total,
      area_covered_km2      = agg.area_covered,
      coverage_pct          = case when agg.area_total > 0
                                   then round((agg.area_covered / agg.area_total * 100)::numeric, 2)
                                   else 0 end,
      leads_found           = agg.leads
  from agg
  where s.id = p_search;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- verify_search_coverage: the exit invariant. Runs on EVERY terminal path.
--
--   1. sum of leaf states == leaf count
--   2. union of leaf rects == bbox (within epsilon, by area)
--   3. leaf rects pairwise disjoint
--   4. in_progress == 0
--
-- A violation is a loud, recorded error -- never a silently rounded number.
-- ---------------------------------------------------------------------------
create or replace function public.verify_search_coverage(p_search uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_search      public.searches;
  v_leaf_count  integer;
  v_state_sum   integer;
  v_leaf_area   double precision;
  v_bbox_area   double precision;
  v_in_progress integer;
  v_overlaps    integer := 0;
  v_overlap_checked boolean := false;
  -- The pairwise scan is O(n^2). At the old 5000-leaf gate that is ~12.5M
  -- comparisons, enough to risk a statement timeout -- and a timeout here would
  -- abort the exit path that every terminal tick runs. 1500 leaves is ~1.1M
  -- comparisons, comfortably fast, and still far above any realistic city grid
  -- (Houston at 8km seeds is 90 tiles). Beyond it the check is SKIPPED and said
  -- to be skipped, rather than being quietly reported as passed.
  v_overlap_max_leaves constant integer := 1500;
  v_epsilon     double precision := 0.005;   -- 0.5% of bbox area
  v_report      jsonb;
  v_ok          boolean;
begin
  select * into v_search from public.searches where id = p_search;
  if not found then
    raise exception 'verify_search_coverage: search % not found', p_search;
  end if;

  select count(*), coalesce(sum(area_km2), 0)
    into v_leaf_count, v_leaf_area
  from public.search_tiles
  where search_id = p_search and state <> 'subdivided';

  select
    count(*) filter (where state = 'pending')
      + count(*) filter (where state = 'in_progress')
      + count(*) filter (where state = 'covered')
      + count(*) filter (where state = 'empty')
      + count(*) filter (where state = 'saturated_floor')
      + count(*) filter (where state = 'failed')
      + count(*) filter (where state = 'skipped_quota'),
    count(*) filter (where state = 'in_progress')
    into v_state_sum, v_in_progress
  from public.search_tiles
  where search_id = p_search and state <> 'subdivided';

  v_bbox_area := public.rect_area_km2(
    v_search.min_lat, v_search.min_lng, v_search.max_lat, v_search.max_lng
  );

  -- Pairwise disjointness. Subdivision at midpoints makes overlap structurally
  -- impossible, so this is a check that the structure held -- not a fixup.
  if v_leaf_count <= v_overlap_max_leaves then
    v_overlap_checked := true;

    select count(*) into v_overlaps
    from public.search_tiles a
    join public.search_tiles b
      on a.search_id = b.search_id and a.id < b.id
    where a.search_id = p_search
      and a.state <> 'subdivided' and b.state <> 'subdivided'
      and a.min_lat < b.max_lat - 1e-9 and b.min_lat < a.max_lat - 1e-9
      and a.min_lng < b.max_lng - 1e-9 and b.min_lng < a.max_lng - 1e-9;
  end if;

  v_ok := v_leaf_count = v_state_sum
      and v_in_progress = 0
      and v_overlaps = 0
      and (v_bbox_area = 0 or abs(v_leaf_area - v_bbox_area) / v_bbox_area <= v_epsilon);

  v_report := jsonb_build_object(
    'ok', v_ok,
    'checked_at', now(),
    'leaf_count', v_leaf_count,
    'state_sum', v_state_sum,
    'states_accounted', v_leaf_count = v_state_sum,
    'in_progress', v_in_progress,
    'no_in_progress', v_in_progress = 0,
    'leaf_area_km2', round(v_leaf_area::numeric, 4),
    'bbox_area_km2', round(v_bbox_area::numeric, 4),
    'area_delta_pct', case when v_bbox_area > 0
                           then round((abs(v_leaf_area - v_bbox_area) / v_bbox_area * 100)::numeric, 4)
                           else 0 end,
    'area_matches', (v_bbox_area = 0 or abs(v_leaf_area - v_bbox_area) / v_bbox_area <= v_epsilon),
    'overlap_check', case when v_overlap_checked
                          then 'performed'
                          else 'skipped_too_many_leaves' end,
    'overlap_check_max_leaves', v_overlap_max_leaves,
    'overlapping_pairs', case when v_overlap_checked then v_overlaps else null end,
    -- null, not true: an unperformed check is not a passed check.
    'disjoint', case when v_overlap_checked then (v_overlaps = 0) else null end,
    'epsilon', v_epsilon
  );

  update public.searches set coverage_report = v_report where id = p_search;

  if not v_ok then
    insert into public.search_events (search_id, level, code, message, meta)
    values (p_search, 'error', 'invariant_violation',
            'Coverage invariant failed - results may not represent the stated area',
            v_report);
  end if;

  return v_report;
end;
$fn$;
