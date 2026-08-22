-- 0014_generation_runs.sql
-- The guided one-button flow: Generate -> Searching -> Finding emails -> Ready.
--
-- WHAT THIS TABLE IS FOR, AND WHAT IT DELIBERATELY IS NOT.
--
-- The MVP already knows how to search, cover, enrich and export. What it has no
-- record of is the thing a guided flow needs: that one person, at one moment,
-- approved ONE bounded run and consented to this application fetching pages
-- from other people's web servers. Three facts cannot be derived from any
-- existing table:
--
--   1. WHICH PHASE the flow is in. `searches.status` says whether the SEARCH is
--      done; it says nothing about whether email discovery is running, finished
--      or was never consented to.
--   2. WHETHER ENRICHMENT WAS CONSENTED TO. Without this, reopening a finished
--      search with unchecked leads is ambiguous between "still working" and
--      "never asked" -- and resolving that ambiguity by guessing would mean
--      firing requests at small businesses' websites nobody approved.
--   3. WHAT THIS APPROVAL WAS FOR. One press authorises at most
--      `call_ceiling` Google calls. Continuing past it is a NEW approval, which
--      is a new row.
--
-- NOTHING COUNTABLE IS STORED HERE. No lead counts, no coverage, no tile
-- counts, no enrichment counts, no API usage. Every one of those is read from
-- the table that already owns it -- `searches`, `search_tiles`, `leads`,
-- `lead_enrichment_attempts`, `api_usage_counters` -- on every request, exactly
-- as the rest of the application does. A second copy of a number is a second
-- chance to be wrong about it.
--
-- The ONE number here is `api_calls_at_start`, and it is a WATERMARK rather
-- than a count: calls used by this approval are always computed as
-- `searches.api_calls_run - api_calls_at_start`, so the authoritative counter
-- stays the only counter.
--
-- This table spends nothing. Creating a run makes no Google request, reserves
-- no quota and reaches no website.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

-- Where the guided flow is. Note there is no 'exporting': an export is a
-- separate, free, read-only act the user takes from the results page, and
-- modelling it as a phase would imply the run is not finished until a workbook
-- exists.
do $$ begin
  create type public.generation_phase as enum ('searching', 'enriching', 'ready');
exception when duplicate_object then null; end $$;

-- What became of the approval itself -- distinct from `searches.status`, which
-- describes the geography. A run can be 'stopped' while its search is 'paused'
-- with tiles still owed; that is the normal outcome of reaching the call
-- ceiling, and it is not a failure.
do $$ begin
  create type public.generation_status as enum ('running', 'stopped', 'completed', 'failed');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

create table if not exists public.generation_runs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  search_id   uuid not null references public.searches(id) on delete cascade,

  status      public.generation_status not null default 'running',
  phase       public.generation_phase  not null default 'searching',

  -- The approval. `call_ceiling` is the guaranteed maximum the user was shown
  -- and agreed to; it is written once, at creation, from the server's own
  -- constant and never from the browser.
  --
  -- This sits BELOW `SEARCH_LIMITS.maxCallsPerSearch` (150) in the hierarchy
  -- and never above it: per generation run -> per search -> protected monthly
  -- allowance. Reaching this ceiling stops the run and asks again.
  call_ceiling        integer not null default 30 check (call_ceiling > 0),
  -- Watermark of `searches.api_calls_run` at the instant of approval. Usage is
  -- DERIVED from it, never accumulated here.
  api_calls_at_start  integer not null default 0 check (api_calls_at_start >= 0),

  -- The consent record. NULL means email discovery was never approved for this
  -- run, and the orchestrator refuses to start it. This is the whole reason the
  -- table exists.
  enrichment_consented_at  timestamptz,

  -- Phase boundaries. These are what make elapsed time and the ETA survive a
  -- refresh, a closed tab, or a different device: the clock is read from
  -- Postgres, never from anything the browser remembers.
  created_at               timestamptz not null default now(),
  search_started_at        timestamptz,
  search_completed_at      timestamptz,
  enrichment_started_at    timestamptz,
  enrichment_completed_at  timestamptz,
  completed_at             timestamptz,

  -- Why the run ended, in the orchestrator's own vocabulary
  -- ('coverage_complete', 'generation_call_ceiling', 'stopped_by_user', ...).
  -- Deliberately NOT the search's `stop_reason`: one describes the approval,
  -- the other describes the geography, and conflating them is what made a
  -- search that covered 83% of its area report itself as complete.
  stop_reason  text,
  last_error   text,

  updated_at   timestamptz not null default now()
);

create index if not exists generation_runs_user_idx
  on public.generation_runs (user_id, created_at desc);
create index if not exists generation_runs_search_idx
  on public.generation_runs (search_id, created_at desc);

-- One live approval per search at a time.
--
-- Not a convenience: two concurrent runs over one search would each compute
-- their usage from the same `searches.api_calls_run`, so each would see the
-- other's spending as its own and both ceilings would be wrong. The database
-- refuses the situation rather than the application remembering not to create
-- it. (The search LEASE still remains the mutual-exclusion primitive for the
-- work itself; this only bounds the approvals.)
create unique index if not exists generation_runs_one_active_per_search
  on public.generation_runs (search_id)
  where status = 'running';

drop trigger if exists generation_runs_set_updated_at on public.generation_runs;
create trigger generation_runs_set_updated_at
  before update on public.generation_runs
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- READ ONLY for the browser, matching `search_tiles` and `locations`.
--
-- There is no authenticated INSERT, UPDATE or DELETE policy, and that is the
-- point: a generation run records a spending approval and a consent to reach
-- third-party websites. Both may only ever be written by the server, through
-- the service-role client, after the server itself has computed the numbers the
-- user was shown. A row the browser could write is a ceiling the browser could
-- raise.

alter table public.generation_runs enable row level security;

drop policy if exists generation_runs_read on public.generation_runs;
create policy generation_runs_read on public.generation_runs
  for select to authenticated using (user_id = (select auth.uid()));
