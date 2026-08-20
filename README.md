# Lead Scrapper

A personal, single-account web application that finds local businesses through the
Google Places API (New) and exports them to Excel, for an embroidery digitizing
business.

Two rules shape the whole design:

1. **Coverage first.** The grid is derived from the city's real bounding box, never
   from the lead target. Saturated tiles are split into four, and no tile is ever
   silently skipped. Every export states what fraction of the city went unsearched.
2. **Free only.** There is no paid mode, no override flag, and no automatic overage.
   When the protected free allowance runs out, the search pauses and keeps everything
   it has already collected.

---

## Stack

| Layer | Choice |
| --- | --- |
| Framework | Next.js 16 (App Router, Turbopack, Node runtime) |
| UI | React 19, Tailwind v4, shadcn/ui (Base UI), TanStack Query |
| Database | Supabase Postgres — schema, job state, ledgers, RLS |
| Scheduler | Supabase Cron (`pg_cron` + `pg_net`) |
| Auth | Supabase Auth, email + password, one account, sign-ups disabled |
| Files | Supabase Storage (private `exports` bucket) |

---

## How a search runs

A search is not an HTTP request. It is a row in `searches` with a lease, advanced by
short, idempotent *ticks*.

```
pg_cron (every 30s)  ──►  POST /api/jobs/tick  ──►  claim lease (FOR UPDATE SKIP LOCKED)
                                                     recover interrupted tiles
                                                     work a bounded slice
                                                     release lease
```

- **The browser is never a worker.** It starts, views, pauses, resumes, cancels. Closing
  the tab, losing the network, or shutting the laptop has no effect on a running search.
- **Correctness does not depend on the slice length.** State is persisted after every
  page fetch, so a tick that dies at any point loses at most the single in-flight page.
  `WORKER_SLICE_MS` can be shortened to any value without breaking anything; it only
  changes how many ticks a search takes.
- **At most one worker holds a search at a time**, which is what makes it impossible for
  two ticks to bill Google for the same tile.
- A self-chain (`WORKER_SELF_CHAIN`) is available purely as a latency optimisation and is
  **off by default**. pg_cron alone is sufficient.

---

## Setup

### 1. Install

```bash
npm install
cp .env.example .env.local
```

### 2. Create the Supabase project

Create a project at [supabase.com](https://supabase.com), then fill in `.env.local`:

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` — safe in the browser
- `SUPABASE_SERVICE_ROLE_KEY` — **server only**, bypasses RLS, never `NEXT_PUBLIC_`
- `GOOGLE_MAPS_API_KEY` — **server only**
- `WORKER_SECRET` — generate with
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

### 3. Apply migrations

```bash
npx supabase link --project-ref <your-project-ref>
npm run db:push
npm run db:types      # regenerates src/server/db/types.gen.ts
```

Enable the `pg_cron` and `pg_net` extensions in the Supabase dashboard first if
`0009_cron_worker.sql` reports that they are unavailable.

### 4. Create the single account

In the Supabase dashboard: **Authentication → Users → Add user**, with an email and
password. Then **Authentication → Providers → Email** and **disable sign-ups**. This
application has one user and no invite flow.

### 5. Point pg_cron at the deployed worker

After deploying (or when using a tunnel in development), run this once in the SQL editor:

```sql
update private.worker_config
set worker_url    = 'https://<your-app>/api/jobs/tick',
    worker_secret = '<the same WORKER_SECRET from .env.local>',
    enabled       = true
where id = 1;
```

The cron job skips the HTTP call entirely when no search is queued or running, so an
idle app makes no requests at all.

### 6. Google Cloud

Enable **Places API (New)** and **Geocoding API**. Restrict the key to those two APIs.
Geocoding resolves city bounding boxes; it is a separate SKU with a separate counter and
can never consume the Places search quota.

### 7. Verify the pricing catalog

`src/server/pricing/catalog.json` holds every Google billing number in the application.
The shipped values are **unverified**. Check them against your billing page, then set
`"verified": true` and update `lastVerified`. Until then `/usage` shows a warning.
Correcting a price is a config change, never a code change.

### 8. Run

```bash
npm run dev
```

---

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` / `npm start` | Production build and serve |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint, including the architectural boundary rules |
| `npm test` | Vitest |
| `npm run db:push` | Apply migrations to the linked project |
| `npm run db:types` | Regenerate database types |

---

## Architecture boundaries

These are enforced by ESLint and fail the build, rather than being conventions:

- `src/components/**`, `src/hooks/**`, `src/lib/**` may **not** import `@/server/*`.
  This is what keeps the Google key and the service-role key out of the client bundle.
- `src/server/{places,geo,grid,coverage,search,export}/**` may **not** import
  `@/server/enrichment/**`. Email discovery is a separate subsystem and never runs
  inside the Places search loop.

Additional invariants live in the database rather than in application code:

- **Tile transitions** are validated by a trigger against `tile_state_transitions`. An
  illegal move raises. A bug in the runner cannot silently record coverage that never
  happened.
- **Every state change is appended** to `tile_events` by trigger — the replayable ledger.
- **Deduplication** is a unique constraint on `(search_id, place_id)`, so it stays correct
  across crashes, resumes, and concurrent ticks.
- **The budget guard** (`reserve_api_calls`) is an atomic Postgres function called before
  every Google request. The browser cannot write usage counters at all.
- **The coverage invariant** (`verify_search_coverage`) checks that leaf states sum to the
  leaf count, that leaf areas sum to the bounding box within epsilon, that leaves are
  pairwise disjoint, and that nothing is left `in_progress`.

---

## What email means here

The Google Places API returns **no email address** — not in any field, tier, or endpoint.
What it returns is the business website, and that website is the input to a separate
enrichment subsystem. The database columns, the attempt log, and the UI statuses exist;
the provider registry is empty, and the application makes no network request to any host
other than Google's API endpoints until a provider is explicitly chosen.

---

## Build phases

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | App shell, all routes, database schema, auth, RLS | **done** |
| 2 | Pricing service, quota service, bbox resolver, `/usage` live | next |
| 3 | Places client, tiling, subdivision, tile rules, dedupe | |
| 4 | Tick worker, lease, crash recovery, preflight, live progress | |
| 5 | Lead management: filters, sorting, detail | |
| 6 | Excel export with the Coverage worksheet | |
| 7 | Enrichment providers | |
