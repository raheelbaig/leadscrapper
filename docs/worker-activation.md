# Activating the background worker

**Status: OFF.** `private.worker_config.enabled` is `false`, and `worker_url` and
`worker_secret` are unset. Phase 4C built the endpoint and left it closed.

Nothing in the application can turn it on. `private` is not exposed through
PostgREST, so there is no HTTP path to the switch — flipping it is a deliberate
SQL statement you run yourself, which is the design.

## What is already in place

| Piece                            | Where                              | State                                                  |
| -------------------------------- | ---------------------------------- | ------------------------------------------------------ |
| `pg_cron`, `pg_net`              | migration 0009                     | installed                                              |
| `private.worker_config`          | migration 0009                     | row exists, `enabled = false`                          |
| `private.dispatch_worker_tick()` | migration 0009                     | returns immediately while disabled                     |
| `private.sweep_expired_leases()` | migration 0009                     | safe to run; recovers dead leases                      |
| 3 cron jobs                      | migration 0009                     | scheduled, currently no-ops                            |
| `POST /api/jobs`                 | `src/app/api/jobs/route.ts`        | refuses unless `WORKER_SECRET` is set                  |
| Tick logic                       | `src/server/worker/worker-tick.ts` | calls the same `runControlledTick` the Run button does |

`dispatch_worker_tick()` skips the HTTP call entirely when nothing is runnable,
so even once enabled an idle app makes no requests at all.

## Before you enable it

The worker will spend money without anyone watching. Confirm all of these
first:

1. **The per-search budget is right.** `SEARCH_LIMITS.maxCallsPerSearch` is
   **150** (approved 2026-08-22). The worker cannot exceed it — the budget is
   cumulative across every resume and is checked against `searches.api_calls_run`
   — but it _will_ spend up to it without further prompting.
2. **Check the month's usage.** `/usage`, or `select * from api_usage_counters`.
3. **Decide which searches are runnable.** The worker picks up anything in
   `queued` or `running`. Pause or cancel anything you do not want worked on —
   in particular, a search created before 2026-08-22 that still carries
   `stopOnTargetReached: true` will stop at its target rather than continue.
4. **Nothing else should be running.** The lease makes concurrent runs
   impossible rather than merely unlikely, but a manual run and a cron tick
   competing for the same search is still confusing to read.

## Enabling

Set the environment variables on the deployment first:

```
WORKER_SECRET=<32+ random characters>
WORKER_SLICE_MS=25000
WORKER_LEASE_SECONDS=90
WORKER_MAX_TILES_PER_TICK=25
WORKER_SELF_CHAIN=false
```

`WORKER_MAX_TILES_PER_TICK` is clamped by `SEARCH_LIMITS.maxTilesPerTick` (12),
so a larger value here has no effect. That is intentional.

Verify the endpoint answers before scheduling anything at it:

```bash
curl -i -X GET https://<your-app>/api/jobs -H "x-worker-secret: <the secret>"
# 200 {"ok":true,...}   -> configured
# 401                   -> secret mismatch
# 503                   -> WORKER_SECRET not set on the deployment
```

Then, and only then, in the Supabase SQL editor:

```sql
update private.worker_config
set worker_url    = 'https://<your-app>/api/jobs',
    worker_secret = '<the same secret>',
    enabled       = true
where id = 1;
```

The `lead-scrapper-worker-tick` job runs every 30 seconds and will pick up the
next runnable search on its next pass.

## Watching it

```sql
-- what the worker did
select * from public.search_events order by id desc limit 50;

-- did the cron job actually fire
select jobname, status, return_message, start_time
from cron.job_run_details order by start_time desc limit 20;

-- what it has spent this month
select * from public.api_usage_counters;
```

## Turning it off

```sql
update private.worker_config set enabled = false where id = 1;
```

That is enough — `dispatch_worker_tick()` returns immediately and no further
HTTP call is made. A tick already in flight finishes its slice and releases its
lease normally; it does not need to be killed. To stop a specific search
instead, press Pause in the UI: the tick reads the status between tiles and
stops itself.

If a worker process dies without releasing, `sweep_expired_leases()` runs every
five minutes and returns its tiles to `pending`. Nothing is lost; the work is
simply still owed.
