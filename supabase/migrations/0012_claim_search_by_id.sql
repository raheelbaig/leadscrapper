-- 0012_claim_search_by_id.sql
--
-- claim_search_job_by_id: take the lease on ONE named search.
--
-- Why this exists
-- ---------------
-- `claim_search_job(worker)` picks whichever search is runnable, which is
-- exactly right for the cron-driven worker: it does not care which job it gets.
-- A manually started run does care. Phase 3A starts one specific controlled
-- test from a button in the application, and it must be able to say WHICH
-- search it is running.
--
-- The alternative -- calling claim_search_job() and hoping it returns the
-- intended row -- is only correct while exactly one search exists, and it would
-- disturb an unrelated search the moment a second one did (claim mutates
-- status and bumps tick_count before the caller can look at the id).
--
-- Everything else is byte-for-byte the same protocol as claim_search_job:
-- the same runnable predicate, the same expired-lease test, the same
-- FOR UPDATE SKIP LOCKED, the same fields set. Mutual exclusion is preserved,
-- and that is what makes it impossible for two runners to bill Google for the
-- same tile.
--
-- Returns zero rows when the search does not exist, is not runnable, or is held
-- by a live lease. The caller must treat "no row" as "you did not get it" and
-- must not issue a Google request.

create or replace function public.claim_search_job_by_id(
  p_search        uuid,
  p_worker        uuid,
  p_lease_seconds integer default 90
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
  where s.id = p_search
    and s.status in ('queued', 'running')
    and (
      s.locked_at is null
      or s.heartbeat_at is null
      or s.heartbeat_at < now() - make_interval(secs => p_lease_seconds)
    )
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

-- Same privilege posture as every other worker RPC: the browser must not be
-- able to take a lease, because holding one is what authorises Google requests.
revoke execute on function public.claim_search_job_by_id(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_search_job_by_id(uuid, uuid, integer)
  to service_role;
