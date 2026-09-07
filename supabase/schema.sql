-- Unstuck — Supabase schema. Paste into SQL Editor → New query → Run. Safe to run more than once.
-- One row per countdown plan; tasks live in a jsonb blob keyed by ISO date, matching the app's local shape.
-- Sync merges per task (union by task id, tombstones for deletes); same-task conflicts resolve by updated_at.

create table if not exists public.plans (
  id          text primary key,                        -- client-generated UUID (matches localStorage)
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null,
  start_date  date not null,
  end_date    date not null,
  tasks       jsonb not null default '{}'::jsonb,       -- { "2026-09-07": [ {id,title,min,done,star}, ... ] }
  tombstones  jsonb not null default '[]'::jsonb,       -- ids of deleted tasks so a delete on one device sticks everywhere
  updated_at  timestamptz not null default now(),
  deleted     boolean not null default false,
  created_at  timestamptz not null default now()
);
alter table public.plans add column if not exists tombstones jsonb not null default '[]'::jsonb;

create index if not exists plans_user_idx on public.plans (user_id, updated_at desc);

-- Clamp client clocks: a phone with its clock set 3 years ahead would otherwise "win" every merge forever.
-- Anything more than 2 minutes in the future is replaced with server time; the past is left alone
-- (an offline edit from yesterday is legitimately older than today's).
create or replace function public.plans_clamp_updated_at() returns trigger language plpgsql as $$
begin
  if new.updated_at is null or new.updated_at > now() + interval '2 minutes' then
    new.updated_at := now();
  end if;
  return new;
end $$;
drop trigger if exists plans_clamp_updated_at on public.plans;
create trigger plans_clamp_updated_at before insert or update on public.plans
  for each row execute function public.plans_clamp_updated_at();

-- Row Level Security: a user can only ever see or touch their own rows. This is what makes the
-- anon key safe to ship in the browser.
alter table public.plans enable row level security;

drop policy if exists "plans: own rows select" on public.plans;
create policy "plans: own rows select" on public.plans for select using (auth.uid() = user_id);

drop policy if exists "plans: own rows insert" on public.plans;
create policy "plans: own rows insert" on public.plans for insert with check (auth.uid() = user_id);

drop policy if exists "plans: own rows update" on public.plans;
create policy "plans: own rows update" on public.plans for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "plans: own rows delete" on public.plans;
create policy "plans: own rows delete" on public.plans for delete using (auth.uid() = user_id);

-- Realtime: lets a second open device see changes without reloading. Idempotent.
do $$ begin
  alter publication supabase_realtime add table public.plans;
exception when duplicate_object then null;
end $$;
