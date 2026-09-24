-- 0009_memory_links: long-term memory (typed + vector), user facts (KV), bookmarks
-- Memory split follows openmemo: KV facts are injected into every prompt, while
-- vector memories are retrieved on demand.

create type public.memory_type as enum (
  'preference', 'decision', 'project_context', 'fact', 'workflow', 'event'
);

create table public.memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  memory_type public.memory_type not null default 'fact',
  content text not null,
  tags text[] not null default '{}',
  importance smallint not null default 3 check (importance between 1 and 5),
  embedding extensions.vector(1024),
  source_message_id uuid references public.messages(id) on delete set null,
  last_accessed_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger memories_set_updated_at before update on public.memories
  for each row execute function public.set_updated_at();
create index memories_user_created_idx on public.memories (user_id, created_at desc)
  where deleted_at is null;
create index memories_project_id_idx on public.memories (project_id);
create index memories_source_message_idx on public.memories (source_message_id);
create index memories_tags_idx on public.memories using gin (tags);
create index memories_embedding_idx on public.memories
  using hnsw (embedding extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 64)
  where deleted_at is null;

-- Structured facts about the user, injected into every system prompt.
-- The key IS the dedup: upsert on (user_id, key).
create table public.user_facts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  category text not null default 'general',
  key text not null,
  value text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, key)
);
create trigger user_facts_set_updated_at before update on public.user_facts
  for each row execute function public.set_updated_at();

create table public.links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  url text not null,
  title text,
  description text,
  site_name text,
  summary text,
  tags text[] not null default '{}',
  embedding extensions.vector(1024),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, url)
);
create trigger links_set_updated_at before update on public.links
  for each row execute function public.set_updated_at();
create index links_user_created_idx on public.links (user_id, created_at desc)
  where deleted_at is null;
create index links_project_id_idx on public.links (project_id);
create index links_tags_idx on public.links using gin (tags);
create index links_embedding_idx on public.links
  using hnsw (embedding extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 64)
  where deleted_at is null;

alter table public.memories enable row level security;
alter table public.user_facts enable row level security;
alter table public.links enable row level security;
