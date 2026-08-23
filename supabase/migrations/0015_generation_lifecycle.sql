-- 0015_generation_lifecycle.sql
-- One click approves the whole lifecycle.
--
-- WHAT CHANGED, AND WHY IT IS A POLICY CHANGE RATHER THAN A TUNING ONE.
--
-- 0014 gave each generation run its own 30-call ceiling, so a press of Generate
-- Leads authorised 30 Google calls and then stopped to ask again. A real
-- production run showed what that actually feels like: a search of a real city
-- needs roughly ninety calls, so the user was asked to press "Continue
-- generation" three times to get one lead list. That is a search-management
-- console, not a one-click product.
--
-- PRODUCT DECISION (2026-08-23): one press approves the ENTIRE lifecycle. The
-- run's ceiling therefore becomes the per-search spending limit that already
-- bounded it -- `SEARCH_LIMITS.maxCallsPerSearch`, 150 -- rather than a second,
-- narrower gate in front of it.
--
-- NO SAFETY LIMIT IS WEAKENED BY THIS. Every hard boundary is untouched and
-- still enforced exactly where it was:
--
--   * 150 calls per search           -- SEARCH_LIMITS.maxCallsPerSearch,
--                                       checked by the tick runner itself
--   * the protected monthly free allowance and its reserve
--                                    -- reserve_api_calls(), per page
--   * FREE ONLY                      -- app_settings.free_only, CHECK-enforced
--   * per-tick tile/call/time slices -- SEARCH_LIMITS
--   * enrichment batch cap, concurrency 1, MAX_ATTEMPTS_PER_LEAD
--
-- What is removed is a gate the user had to press through. What remains is
-- every gate that protects the money. Reaching one of those now ends the run
-- with an honest "paused for safety" state instead of an invitation to
-- continue.

alter table public.generation_runs
  alter column call_ceiling set default 150;

comment on column public.generation_runs.call_ceiling is
  'Google calls this approval permits. Mirrors SEARCH_LIMITS.maxCallsPerSearch: one press approves the whole lifecycle, and the per-search budget is what bounds it. Written by the server from its own constant, never from a request.';

-- ---------------------------------------------------------------------------
-- The liveness guard for an automatically-advancing run.
-- ---------------------------------------------------------------------------
--
-- A run that stops to ask the user after every slice cannot spin: the human is
-- the loop condition. One that advances itself can, and this column is what
-- makes that impossible.
--
-- The failure it prevents is real rather than theoretical. A tick can end
-- having done nothing and spent nothing -- a lease it could not claim, a tile
-- that errored before any request was authorised -- and the orchestrator would
-- correctly report "still running, more to do", and the client would correctly
-- ask again, forever. Counting consecutive advances that changed nothing turns
-- that into a bounded, visible failure.
--
-- Reset to zero by any advance that completes an area or spends a call, so a
-- merely slow run is never mistaken for a stuck one.
alter table public.generation_runs
  add column if not exists no_progress_ticks integer not null default 0
    check (no_progress_ticks >= 0);

comment on column public.generation_runs.no_progress_ticks is
  'Consecutive advances that completed no area and spent no call. Bounds the self-advancing loop; reset by any real progress.';
