-- 0010_search_fns: vector + hybrid retrieval RPCs.
-- All are user-scoped, SECURITY DEFINER, service_role-only. Vector ordering is
-- impossible through PostgREST's query builder, so every similarity search goes
-- through one of these functions.
-- Callers apply their own similarity thresholds (openmemo pattern): memories ~0.3,
-- conversation recall ~0.7.
-- Keyword matching uses strpos() containment so user text needs no LIKE-escaping.

create or replace function public.match_memories(
  p_user_id uuid,
  p_query_embedding extensions.vector(1024),
  p_project uuid default null,
  p_tag_filter text[] default null,
  p_limit int default 10
)
returns table (id uuid, content text, memory_type public.memory_type, tags text[],
               importance smallint, project_id uuid, similarity float)
language sql
stable
security definer
set search_path = ''
as $fn$
  select m.id, m.content, m.memory_type, m.tags, m.importance, m.project_id,
         (1 - (m.embedding operator(extensions.<=>) p_query_embedding))::float as similarity
  from public.memories m
  where m.user_id = p_user_id
    and m.deleted_at is null
    and m.embedding is not null
    and (p_project is null or m.project_id = p_project)
    and (p_tag_filter is null or m.tags && p_tag_filter)
  order by m.embedding operator(extensions.<=>) p_query_embedding
  limit p_limit;
$fn$;

create or replace function public.match_file_chunks(
  p_user_id uuid,
  p_query_embedding extensions.vector(1024),
  p_project uuid default null,
  p_limit int default 8
)
returns table (chunk_id uuid, file_id uuid, file_name text, chunk_index int,
               content text, similarity float)
language sql
stable
security definer
set search_path = ''
as $fn$
  select c.id, c.file_id, f.file_name, c.chunk_index, c.content,
         (1 - (c.embedding operator(extensions.<=>) p_query_embedding))::float as similarity
  from public.file_chunks c
  join public.files f on f.id = c.file_id
  where c.user_id = p_user_id
    and c.embedding is not null
    and f.deleted_at is null
    and (p_project is null or f.project_id = p_project)
  order by c.embedding operator(extensions.<=>) p_query_embedding
  limit p_limit;
$fn$;

create or replace function public.match_messages(
  p_user_id uuid,
  p_conversation uuid,
  p_query_embedding extensions.vector(1024),
  p_limit int default 5
)
returns table (id uuid, role public.msg_role, content text, created_at timestamptz,
               similarity float)
language sql
stable
security definer
set search_path = ''
as $fn$
  select m.id, m.role, m.content, m.created_at,
         (1 - (m.embedding operator(extensions.<=>) p_query_embedding))::float as similarity
  from public.messages m
  where m.user_id = p_user_id
    and m.embedding is not null
    and (p_conversation is null or m.conversation_id = p_conversation)
  order by m.embedding operator(extensions.<=>) p_query_embedding
  limit p_limit;
$fn$;

create or replace function public.match_notes(
  p_user_id uuid,
  p_query_embedding extensions.vector(1024),
  p_project uuid default null,
  p_limit int default 8
)
returns table (id uuid, title text, content text, tags text[], similarity float)
language sql
stable
security definer
set search_path = ''
as $fn$
  select n.id, n.title, n.content, n.tags,
         (1 - (n.embedding operator(extensions.<=>) p_query_embedding))::float as similarity
  from public.notes n
  where n.user_id = p_user_id
    and n.deleted_at is null
    and n.embedding is not null
    and (p_project is null or n.project_id = p_project)
  order by n.embedding operator(extensions.<=>) p_query_embedding
  limit p_limit;
$fn$;

-- Hybrid search: reciprocal-rank fusion (1/(60+rank)) of keyword and vector hits
-- across entity kinds. p_query_embedding may be null, in which case this
-- degrades gracefully to pure keyword search.
create or replace function public.hybrid_search(
  p_user_id uuid,
  p_query text,
  p_query_embedding extensions.vector(1024) default null,
  p_kinds public.entity_kind[] default null,
  p_limit int default 20
)
returns table (kind public.entity_kind, id uuid, title text, snippet text, score float)
language sql
stable
security definer
set search_path = ''
as $fn$
  with q as (select lower(p_query) as needle),
  keyword as (
    select 'project'::public.entity_kind as kind, p.id, p.name as title,
           left(coalesce(p.description, p.name), 200) as snippet,
           row_number() over (order by p.updated_at desc) as rnk
    from public.projects p, q
    where p.user_id = p_user_id
      and (strpos(lower(p.name), q.needle) > 0
           or strpos(lower(coalesce(p.description, '')), q.needle) > 0)
    union all
    select 'task', t.id, t.title, left(coalesce(t.description, t.title), 200),
           row_number() over (order by t.updated_at desc)
    from public.tasks t, q
    where t.user_id = p_user_id
      and (strpos(lower(t.title), q.needle) > 0
           or strpos(lower(coalesce(t.description, '')), q.needle) > 0)
    union all
    select 'note', n.id, coalesce(n.title, left(n.content, 60)), left(n.content, 200),
           row_number() over (order by n.updated_at desc)
    from public.notes n, q
    where n.user_id = p_user_id and n.deleted_at is null
      and (strpos(lower(n.content), q.needle) > 0
           or strpos(lower(coalesce(n.title, '')), q.needle) > 0)
    union all
    select 'file', f.id, f.file_name,
           left(coalesce(f.caption, f.extracted_text, f.file_name), 200),
           row_number() over (order by f.created_at desc)
    from public.files f, q
    where f.user_id = p_user_id and f.deleted_at is null
      and (strpos(lower(f.file_name), q.needle) > 0
           or strpos(lower(coalesce(f.caption, '')), q.needle) > 0
           or strpos(lower(coalesce(f.extracted_text, '')), q.needle) > 0)
    union all
    select 'link', l.id, coalesce(l.title, l.url),
           left(coalesce(l.summary, l.description, l.url), 200),
           row_number() over (order by l.created_at desc)
    from public.links l, q
    where l.user_id = p_user_id and l.deleted_at is null
      and (strpos(lower(l.url), q.needle) > 0
           or strpos(lower(coalesce(l.title, '')), q.needle) > 0
           or strpos(lower(coalesce(l.summary, '')), q.needle) > 0)
    union all
    select 'memory', m.id, left(m.content, 60), left(m.content, 200),
           row_number() over (order by m.importance desc, m.created_at desc)
    from public.memories m, q
    where m.user_id = p_user_id and m.deleted_at is null
      and strpos(lower(m.content), q.needle) > 0
  ),
  vector_hits as (
    select 'memory'::public.entity_kind as kind, v.id, left(v.content, 60) as title,
           left(v.content, 200) as snippet,
           row_number() over (order by v.similarity desc) as rnk
    from public.match_memories(p_user_id, p_query_embedding, null, null, 10) v
    where p_query_embedding is not null
    union all
    select 'note', n.id, coalesce(n.title, left(n.content, 60)), left(n.content, 200),
           row_number() over (order by n.similarity desc)
    from public.match_notes(p_user_id, p_query_embedding, null, 10) n
    where p_query_embedding is not null
    union all
    select 'file', c.file_id, c.file_name, left(c.content, 200),
           row_number() over (order by c.similarity desc)
    from public.match_file_chunks(p_user_id, p_query_embedding, null, 10) c
    where p_query_embedding is not null
  ),
  fused as (
    select all_hits.kind, all_hits.id, min(all_hits.title) as title,
           min(all_hits.snippet) as snippet,
           sum(1.0 / (60 + all_hits.rnk)) as score
    from (select * from keyword union all select * from vector_hits) all_hits
    group by all_hits.kind, all_hits.id
  )
  select f.kind, f.id, f.title, f.snippet, f.score::float
  from fused f
  where p_kinds is null or f.kind = any(p_kinds)
  order by f.score desc
  limit p_limit;
$fn$;

revoke execute on function public.match_memories(uuid, extensions.vector, uuid, text[], int) from public, anon, authenticated;
revoke execute on function public.match_file_chunks(uuid, extensions.vector, uuid, int) from public, anon, authenticated;
revoke execute on function public.match_messages(uuid, uuid, extensions.vector, int) from public, anon, authenticated;
revoke execute on function public.match_notes(uuid, extensions.vector, uuid, int) from public, anon, authenticated;
revoke execute on function public.hybrid_search(uuid, text, extensions.vector, public.entity_kind[], int) from public, anon, authenticated;
grant execute on function public.match_memories(uuid, extensions.vector, uuid, text[], int) to service_role;
grant execute on function public.match_file_chunks(uuid, extensions.vector, uuid, int) to service_role;
grant execute on function public.match_messages(uuid, uuid, extensions.vector, int) to service_role;
grant execute on function public.match_notes(uuid, extensions.vector, uuid, int) to service_role;
grant execute on function public.hybrid_search(uuid, text, extensions.vector, public.entity_kind[], int) to service_role;
