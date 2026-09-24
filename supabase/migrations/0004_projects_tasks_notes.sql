-- 0004_projects_tasks_notes: project management layer + notes

create type public.project_status as enum (
  'idea', 'planned', 'active', 'waiting', 'blocked', 'completed', 'archived'
);
create type public.priority_level as enum ('critical', 'high', 'medium', 'low');
create type public.task_status as enum (
  'inbox', 'todo', 'in_progress', 'waiting', 'blocked', 'done', 'cancelled'
);
create type public.note_source as enum ('manual', 'research', 'url', 'file', 'voice', 'agent');

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  name text not null,
  slug text not null,
  description text,
  status public.project_status not null default 'active',
  priority public.priority_level not null default 'medium',
  category text,
  start_date date,
  due_date date,
  progress smallint not null default 0 check (progress between 0 and 100),
  tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, slug)
);
create trigger projects_set_updated_at before update on public.projects
  for each row execute function public.set_updated_at();
create index projects_user_status_idx on public.projects (user_id, status);
create index projects_tags_idx on public.projects using gin (tags);

create table public.project_members (
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  role public.user_role not null default 'user',
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);
create index project_members_user_id_idx on public.project_members (user_id);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  parent_task_id uuid references public.tasks(id) on delete cascade,
  title text not null,
  description text,
  status public.task_status not null default 'todo',
  priority public.priority_level not null default 'medium',
  start_at timestamptz,
  due_at timestamptz,
  recurrence_rule text,
  tags text[] not null default '{}',
  source text not null default 'chat',
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger tasks_set_updated_at before update on public.tasks
  for each row execute function public.set_updated_at();
create index tasks_user_status_due_idx on public.tasks (user_id, status, due_at);
create index tasks_project_id_idx on public.tasks (project_id);
create index tasks_parent_task_id_idx on public.tasks (parent_task_id);
create index tasks_tags_idx on public.tasks using gin (tags);

create table public.task_dependencies (
  task_id uuid not null references public.tasks(id) on delete cascade,
  depends_on_task_id uuid not null references public.tasks(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (task_id, depends_on_task_id),
  check (task_id <> depends_on_task_id)
);
create index task_dependencies_depends_on_idx on public.task_dependencies (depends_on_task_id);

create table public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  title text,
  content text not null,
  source public.note_source not null default 'manual',
  tags text[] not null default '{}',
  pinned boolean not null default false,
  embedding extensions.vector(1024),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger notes_set_updated_at before update on public.notes
  for each row execute function public.set_updated_at();
create index notes_user_created_idx on public.notes (user_id, created_at desc) where deleted_at is null;
create index notes_project_id_idx on public.notes (project_id);
create index notes_tags_idx on public.notes using gin (tags);
create index notes_fts_idx on public.notes
  using gin (to_tsvector('simple', coalesce(title, '') || ' ' || content));
create index notes_embedding_idx on public.notes
  using hnsw (embedding extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 64)
  where deleted_at is null;

alter table public.conversations
  add constraint conversations_project_id_fkey
  foreign key (project_id) references public.projects(id) on delete set null;
create index conversations_project_id_idx on public.conversations (project_id);

alter table public.projects enable row level security;
alter table public.project_members enable row level security;
alter table public.tasks enable row level security;
alter table public.task_dependencies enable row level security;
alter table public.notes enable row level security;
