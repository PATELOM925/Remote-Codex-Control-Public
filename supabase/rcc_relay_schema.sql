-- RCC hosted relay durable storage schema for Supabase/Postgres.
-- Run in the Supabase SQL Editor for the RCC project before setting Vercel env vars.

create table if not exists public.rcc_relay_commands (
  -- Text keeps the hosted relay compatible with client-provided idempotency ids
  -- as well as server-generated UUIDs.
  id text primary key,
  action text not null check (action in ('run', 'plan', 'say', 'interrupt', 'approve', 'deny', 'refresh', 'thread_detail', 'list_threads', 'list_skills', 'start_with_skills', 'set_mode', 'attach_file')),
  target_kind text not null check (target_kind in ('thread', 'approval', 'daemon')),
  target_id text,
  message text,
  client_request_id text,
  status text not null default 'pending' check (status in ('pending', 'delivered', 'completed', 'failed')),
  mac_id text,
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  completed_at timestamptz
);

-- Keep this idempotent because alpha command names are still evolving.
alter table public.rcc_relay_commands
  drop constraint if exists rcc_relay_commands_action_check;

alter table public.rcc_relay_commands
  add constraint rcc_relay_commands_action_check
  check (action in ('run', 'plan', 'say', 'interrupt', 'approve', 'deny', 'refresh', 'thread_detail', 'list_threads', 'list_skills', 'start_with_skills', 'set_mode', 'attach_file'));

create index if not exists idx_rcc_relay_commands_pending
  on public.rcc_relay_commands (created_at)
  where status = 'pending';

create index if not exists idx_rcc_relay_commands_mac_status
  on public.rcc_relay_commands (mac_id, status, created_at);

create table if not exists public.rcc_relay_results (
  command_id text primary key references public.rcc_relay_commands(id) on delete cascade,
  ok boolean not null,
  message text not null,
  data jsonb,
  completed_at timestamptz not null default now()
);

create index if not exists idx_rcc_relay_results_completed_at
  on public.rcc_relay_results (completed_at desc);

create table if not exists public.rcc_relay_snapshots (
  mac_id text primary key,
  payload jsonb not null,
  generated_at timestamptz,
  last_mac_poll_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists idx_rcc_relay_snapshots_updated_at
  on public.rcc_relay_snapshots (updated_at desc);

alter table public.rcc_relay_commands enable row level security;
alter table public.rcc_relay_results enable row level security;
alter table public.rcc_relay_snapshots enable row level security;

-- No anon/authenticated policies are created intentionally.
-- The Vercel relay function must use the Supabase service_role key server-side only.
