-- 0003_agent_runs: per-turn accounting + tool call audit

create type public.run_status as enum ('ok', 'error', 'aborted');
create type public.run_trigger as enum (
  'message', 'command', 'callback', 'schedule', 'heartbeat', 'daily_brief', 'dispatch'
);

create table public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  trigger public.run_trigger not null,
  model text,
  iterations integer not null default 0,
  tool_call_count integer not null default 0,
  prompt_tokens integer,
  completion_tokens integer,
  cost_usd numeric(10, 6),
  status public.run_status not null,
  error text,
  latency_ms integer,
  created_at timestamptz not null default now()
);
create index agent_runs_user_created_idx on public.agent_runs (user_id, created_at desc);
create index agent_runs_conversation_idx on public.agent_runs (conversation_id);

create table public.tool_calls (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.agent_runs(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  tool_name text not null,
  args jsonb,           -- redacted before insert
  result_summary text,  -- truncated
  status text not null,
  error text,
  duration_ms integer,
  created_at timestamptz not null default now()
);
create index tool_calls_run_id_idx on public.tool_calls (run_id);
create index tool_calls_user_created_idx on public.tool_calls (user_id, created_at desc);

alter table public.agent_runs enable row level security;
alter table public.tool_calls enable row level security;
