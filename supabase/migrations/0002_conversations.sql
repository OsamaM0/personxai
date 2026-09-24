-- 0002_conversations: conversation contexts + messages with embeddings

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  project_id uuid, -- FK added in 0004 once projects exists
  title text,
  is_active boolean not null default false,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger conversations_set_updated_at before update on public.conversations
  for each row execute function public.set_updated_at();
create index conversations_user_id_idx on public.conversations (user_id, created_at desc);
-- exactly one active conversation (context) per user
create unique index conversations_one_active_per_user_idx
  on public.conversations (user_id) where is_active;

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  role public.msg_role not null,
  content text not null,
  channel text,               -- e.g. 'telegram'; null for internal/system turns
  external_message_id text,   -- channel-native message id
  media jsonb,                -- normalized media refs when the turn carried attachments
  tokens_in integer,
  tokens_out integer,
  embedding extensions.vector(1024),
  created_at timestamptz not null default now()
);
create index messages_conversation_created_idx on public.messages (conversation_id, created_at);
create index messages_user_created_idx on public.messages (user_id, created_at desc);
create index messages_embedding_idx on public.messages
  using hnsw (embedding extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 64)
  where embedding is not null;

alter table public.conversations enable row level security;
alter table public.messages enable row level security;
