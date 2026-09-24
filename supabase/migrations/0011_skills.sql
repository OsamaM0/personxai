-- 0011_skills: skill registry, MCP server registry, versioned personalization layer

create table public.skills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete cascade,  -- null = built-in / global
  name text not null,
  description text,
  instructions text not null,
  tools text[] not null default '{}',      -- tool names this skill may use ('*' = all registered)
  permission_level text not null default 'write',
  triggers jsonb not null default '{}',    -- { keywords: [], commands: [] }
  input_schema jsonb,
  version integer not null default 1,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger skills_set_updated_at before update on public.skills
  for each row execute function public.set_updated_at();
-- Per-user names are unique; global skills (user_id null) are unique on their own.
create unique index skills_user_name_idx on public.skills (user_id, name) where user_id is not null;
create unique index skills_global_name_idx on public.skills (name) where user_id is null;
create index skills_enabled_idx on public.skills (user_id, enabled);

create table public.mcp_servers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  name text not null,
  url text not null,
  auth_header text,                        -- stored server-side only, never shown to the model
  enabled boolean not null default true,
  last_connected_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);
create trigger mcp_servers_set_updated_at before update on public.mcp_servers
  for each row execute function public.set_updated_at();

-- Versioned personalization layer (natural-db pattern): the base prompt is
-- immutable in code; only this layer is editable, and only one row is active.
create table public.system_prompts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  prompt_content text not null,
  version integer not null default 1,
  created_by_role public.msg_role not null default 'user',
  description text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index system_prompts_one_active_idx on public.system_prompts (user_id)
  where is_active;
create index system_prompts_user_version_idx on public.system_prompts (user_id, version desc);

alter table public.skills enable row level security;
alter table public.mcp_servers enable row level security;
alter table public.system_prompts enable row level security;
