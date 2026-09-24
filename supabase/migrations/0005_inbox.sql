-- 0005_inbox: universal capture inbox with AI classification cache

create type public.inbox_source as enum ('message', 'file', 'link', 'forward', 'voice', 'photo');
create type public.inbox_status as enum ('pending', 'organized', 'dismissed');

create table public.inbox_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  source public.inbox_source not null,
  raw_content text,
  channel text,
  external_message_id text,
  media jsonb,
  suggested_kind public.entity_kind,
  suggested_project_id uuid references public.projects(id) on delete set null,
  classification jsonb,       -- cached small-model output {kind, project, tags, confidence}
  status public.inbox_status not null default 'pending',
  resolved_kind public.entity_kind,
  resolved_entity_id uuid,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger inbox_items_set_updated_at before update on public.inbox_items
  for each row execute function public.set_updated_at();
create index inbox_items_user_status_idx on public.inbox_items (user_id, status, created_at desc);
create index inbox_items_suggested_project_idx on public.inbox_items (suggested_project_id);

alter table public.inbox_items enable row level security;
