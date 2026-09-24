-- 0008_files: file vault metadata, extraction chunks, tags
-- Vault pattern from TeleFileBot-CloudFlare: bytes live in a private Telegram
-- channel; Postgres holds metadata + extracted text only.

create type public.file_source as enum ('telegram', 'generated');
create type public.file_storage as enum ('vault', 'r2');
create type public.extraction_status as enum ('pending', 'done', 'failed', 'skipped');

create table public.files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  file_name text not null,
  caption text,
  mime_type text,
  file_size bigint,
  media_kind text,                    -- document/photo/video/audio/voice/... (MediaKind)
  tg_file_id text,
  tg_file_unique_id text,
  vault_chat_id text,
  vault_message_id bigint,
  origin_chat_id text,                -- original chat + message for reply-linking
  origin_message_id text,
  storage public.file_storage not null default 'vault',
  r2_key text,
  source public.file_source not null default 'telegram',
  extraction_status public.extraction_status not null default 'pending',
  extracted_text text,
  summary text,
  embedding extensions.vector(1024), -- of summary/caption
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, tg_file_unique_id)
);
create trigger files_set_updated_at before update on public.files
  for each row execute function public.set_updated_at();
create index files_user_created_idx on public.files (user_id, created_at desc) where deleted_at is null;
create index files_project_id_idx on public.files (project_id);
create index files_name_trgm_idx on public.files using gin (file_name extensions.gin_trgm_ops);
create index files_fts_idx on public.files
  using gin (to_tsvector('simple', coalesce(file_name, '') || ' ' || coalesce(caption, '') || ' ' || coalesce(extracted_text, '')));
create index files_origin_idx on public.files (user_id, origin_message_id);
create index files_embedding_idx on public.files
  using hnsw (embedding extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 64)
  where deleted_at is null;

create table public.file_chunks (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references public.files(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  chunk_index integer not null,
  content text not null,
  embedding extensions.vector(1024),
  created_at timestamptz not null default now(),
  unique (file_id, chunk_index)
);
create index file_chunks_user_id_idx on public.file_chunks (user_id);
create index file_chunks_embedding_idx on public.file_chunks
  using hnsw (embedding extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 64);

create table public.tags (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

create table public.file_tags (
  file_id uuid not null references public.files(id) on delete cascade,
  tag_id uuid not null references public.tags(id) on delete cascade,
  primary key (file_id, tag_id)
);
create index file_tags_tag_id_idx on public.file_tags (tag_id);

alter table public.files enable row level security;
alter table public.file_chunks enable row level security;
alter table public.tags enable row level security;
alter table public.file_tags enable row level security;
