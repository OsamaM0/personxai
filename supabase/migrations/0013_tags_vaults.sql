-- 0013_tags_vaults: first-class tags on files + multiple vault channels + tag facets
--
-- Tags: every entity already carries `tags text[]` with a GIN index, except files,
-- which used a join table. Denormalise files onto the same shape so one query
-- form (`tags @> '{x}'`) serves every kind and grouping stays cheap. The join
-- tables remain (kept in sync by the repo) for anything that still reads them.
alter table public.files add column if not exists tags text[] not null default '{}';
update public.files f
   set tags = coalesce(
     (select array_agg(t.name order by t.name)
        from public.file_tags ft join public.tags t on t.id = ft.tag_id
       where ft.file_id = f.id), '{}')
 where f.tags = '{}';
create index if not exists files_tags_idx on public.files using gin (tags);

-- Vault channels: a user may connect several private Telegram channels, each with
-- a category and tags (parsed from the channel description), so files can be
-- routed to the right one. The env VAULT_CHANNEL_ID is registered lazily as the
-- default the first time a user's list is read.
create table public.vault_channels (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  chat_id text not null,                      -- telegram chat id, "-100…"
  title text,
  category text,                              -- one short label: research, personal, receipts …
  description text,                           -- raw channel description (source of category/tags)
  tags text[] not null default '{}',
  is_default boolean not null default false,
  enabled boolean not null default true,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, chat_id)
);
create trigger vault_channels_set_updated_at before update on public.vault_channels
  for each row execute function public.set_updated_at();
create unique index vault_channels_default_idx on public.vault_channels (user_id) where is_default;
create index vault_channels_tags_idx on public.vault_channels using gin (tags);
alter table public.vault_channels enable row level security;

-- Tag facets: one call returns every tag with per-kind counts, for /tags, the
-- dashboard chips, and the live-context "tags in use" line.
create or replace function public.tag_counts(p_user_id uuid)
returns table (name text, kind public.entity_kind, count bigint)
language sql
stable
set search_path = ''
as $fn$
  select x.name, x.kind, count(*)::bigint as count
  from (
    select unnest(t.tags) as name, 'task'::public.entity_kind as kind
      from public.tasks t where t.user_id = p_user_id and t.status not in ('done', 'cancelled')
    union all
    select unnest(p.tags), 'project'::public.entity_kind
      from public.projects p where p.user_id = p_user_id and p.status <> 'archived'
    union all
    select unnest(n.tags), 'note'::public.entity_kind
      from public.notes n where n.user_id = p_user_id and n.deleted_at is null
    union all
    select unnest(f.tags), 'file'::public.entity_kind
      from public.files f where f.user_id = p_user_id and f.deleted_at is null
    union all
    select unnest(l.tags), 'link'::public.entity_kind
      from public.links l where l.user_id = p_user_id and l.deleted_at is null
    union all
    select unnest(m.tags), 'memory'::public.entity_kind
      from public.memories m where m.user_id = p_user_id and m.deleted_at is null
  ) x
  group by x.name, x.kind
  order by count desc, x.name;
$fn$;
