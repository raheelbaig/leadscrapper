-- 0010_enrichment.sql
-- Email enrichment: schema and boundary only.
--
-- The Google Places API does not return business email addresses -- not in any
-- field, tier, or endpoint. Email is derived later from `leads.website` by a
-- separate subsystem that is never called from the Places search loop.
--
-- This migration creates the tables so the UI can render real statuses and so
-- Phase 7 requires no changes to the Places, grid, or coverage logic. No
-- provider is registered and no third-party request is made until one is
-- explicitly chosen and approved.

create table if not exists public.lead_enrichment_attempts (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  lead_id      uuid not null references public.leads(id) on delete cascade,
  provider     text not null,
  status       public.email_status not null,
  email        text,
  confidence   numeric(4, 3),
  cost_sku     text,
  cost_units   integer not null default 0,
  duration_ms  integer,
  error        text,
  raw          jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists enrichment_lead_idx
  on public.lead_enrichment_attempts (lead_id, created_at desc);
create index if not exists enrichment_user_idx
  on public.lead_enrichment_attempts (user_id, created_at desc);

alter table public.lead_enrichment_attempts enable row level security;

drop policy if exists enrichment_read on public.lead_enrichment_attempts;
create policy enrichment_read on public.lead_enrichment_attempts
  for select to authenticated using (user_id = (select auth.uid()));

-- Counts for the /enrichment dashboard. `enrichable` is the number of leads
-- that have a website, since the website is the only bridge Google gives us
-- from a place to a possible email address.
create or replace function public.enrichment_summary(p_user uuid)
returns table (
  total         bigint,
  enrichable    bigint,
  no_website    bigint,
  not_enriched  bigint,
  queued        bigint,
  found         bigint,
  verified      bigint,
  unverified    bigint,
  not_found     bigint,
  failed        bigint
)
language sql
stable
security definer
set search_path = public
as $fn$
  select
    count(*),
    count(*) filter (where website is not null and website <> ''),
    count(*) filter (where website is null or website = ''),
    count(*) filter (where email_status = 'not_enriched'),
    count(*) filter (where email_status = 'queued'),
    count(*) filter (where email_status = 'found'),
    count(*) filter (where email_status = 'verified'),
    count(*) filter (where email_status = 'unverified'),
    count(*) filter (where email_status = 'not_found'),
    count(*) filter (where email_status = 'failed')
  from public.leads
  where user_id = p_user;
$fn$;

grant execute on function public.enrichment_summary(uuid) to authenticated;
