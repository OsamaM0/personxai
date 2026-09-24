-- 0001_core: extensions, shared trigger, users, user_identities, settings, audit_logs
-- Security model: Worker uses service_role only. RLS enabled with zero policies (deny-all
-- for anon/authenticated); per-user columns exist everywhere so real policies can be added later.

create extension if not exists vector with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- Shared updated_at trigger
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Enums
create type public.user_role as enum ('owner', 'admin', 'user', 'viewer');
create type public.msg_role as enum ('user', 'assistant', 'system', 'tool', 'system_routine_task');
create type public.actor_kind as enum ('user', 'agent', 'system');
create type public.entity_kind as enum (
  'project', 'task', 'note', 'file', 'reminder', 'link', 'memory',
  'inbox_item', 'skill', 'conversation', 'setting', 'user'
);

-- Users (channel-agnostic; identities live in user_identities)
create table public.users (
  id uuid primary key default gen_random_uuid(),
  role public.user_role not null default 'user',
  is_allowed boolean not null default false,
  display_name text,
  timezone text not null default 'UTC',
  language text not null default 'en',
  autonomy_level smallint not null default 1 check (autonomy_level between 0 and 3),
  tz_confirmed boolean not null default false,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger users_set_updated_at before update on public.users
  for each row execute function public.set_updated_at();

-- One row per (channel, external id); a user can have identities on many channels
create table public.user_identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  channel text not null,
  external_id text not null,
  chat_ref text,
  username text,
  created_at timestamptz not null default now(),
  unique (channel, external_id)
);
create index user_identities_user_id_idx on public.user_identities (user_id);

create table public.settings (
  user_id uuid not null references public.users(id) on delete cascade,
  key text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);
create trigger settings_set_updated_at before update on public.settings
  for each row execute function public.set_updated_at();

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete set null,
  actor public.actor_kind not null,
  action text not null,
  entity_kind public.entity_kind,
  entity_id uuid,
  details jsonb not null default '{}',
  status text not null default 'ok',
  created_at timestamptz not null default now()
);
create index audit_logs_user_created_idx on public.audit_logs (user_id, created_at desc);

-- Deny-all: RLS on, no policies; only service_role (bypasses RLS) can access
alter table public.users enable row level security;
alter table public.user_identities enable row level security;
alter table public.settings enable row level security;
alter table public.audit_logs enable row level security;

revoke all on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
