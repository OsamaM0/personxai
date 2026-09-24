-- 0015_wallet_revisions: the wallet forgets nothing.
--
-- Every write to wallet_entries — from chat, the dashboard, MCP, or a hand-run
-- SQL statement — leaves a full before/after snapshot here. The log is written
-- by a trigger rather than by the application so that no code path can skip it,
-- which is what makes "everything is documented in the database" true rather
-- than aspirational.
--
-- Rows are kept even when the entry itself is hard-deleted (there is no FK to
-- wallet_entries on purpose); only removing the user removes their history.

create table public.wallet_entry_revisions (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null,
  user_id uuid not null references public.users(id) on delete cascade,
  -- create | update | delete (soft) | restore | purge (hard delete)
  action text not null check (action in ('create', 'update', 'delete', 'restore', 'purge')),
  -- Which columns actually moved, so a diff never has to be recomputed.
  changed_fields text[] not null default '{}',
  before jsonb,
  after jsonb,
  -- Who wrote it: 'chat', 'web', 'mcp', … Set per-transaction where the caller
  -- can (see below), otherwise inherited from the entry's own source.
  actor text not null default 'system',
  created_at timestamptz not null default now()
);

create index wallet_entry_revisions_entry_idx
  on public.wallet_entry_revisions (user_id, entry_id, created_at desc);
create index wallet_entry_revisions_user_time_idx
  on public.wallet_entry_revisions (user_id, created_at desc);

alter table public.wallet_entry_revisions enable row level security;
revoke all on public.wallet_entry_revisions from anon, authenticated;

/*
 * The revision writer. `personxai.actor` is a per-transaction setting a caller
 * may set (select set_config('personxai.actor', 'web', true)); when it is
 * absent — the usual case over PostgREST — the entry's own source is used.
 */
create or replace function public.wallet_log_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_action text;
  v_changed text[];
  v_actor text;
begin
  v_actor := coalesce(
    nullif(current_setting('personxai.actor', true), ''),
    case when tg_op = 'DELETE' then old.source else new.source end,
    'system'
  );

  if tg_op = 'INSERT' then
    insert into public.wallet_entry_revisions (entry_id, user_id, action, after, actor)
    values (new.id, new.user_id, 'create', to_jsonb(new), v_actor);
    return new;
  end if;

  if tg_op = 'DELETE' then
    insert into public.wallet_entry_revisions (entry_id, user_id, action, before, actor)
    values (old.id, old.user_id, 'purge', to_jsonb(old), v_actor);
    return old;
  end if;

  -- UPDATE: name the transition by what happened to deleted_at, so the history
  -- reads "deleted" / "restored" instead of "deleted_at changed".
  if old.deleted_at is null and new.deleted_at is not null then
    v_action := 'delete';
  elsif old.deleted_at is not null and new.deleted_at is null then
    v_action := 'restore';
  else
    v_action := 'update';
  end if;

  select coalesce(array_agg(n.key order by n.key), '{}')
    into v_changed
    from jsonb_each(to_jsonb(new)) as n(key, value)
    where n.value is distinct from (to_jsonb(old) -> n.key)
      -- updated_at moves on every write and would drown the real diff.
      and n.key <> 'updated_at';

  -- A no-op update (same values re-sent) is not history.
  if v_action = 'update' and cardinality(v_changed) = 0 then
    return new;
  end if;

  insert into public.wallet_entry_revisions
    (entry_id, user_id, action, changed_fields, before, after, actor)
  values (new.id, new.user_id, v_action, v_changed, to_jsonb(old), to_jsonb(new), v_actor);
  return new;
end;
$fn$;

create trigger wallet_entries_log_revision
  after insert or update or delete on public.wallet_entries
  for each row execute function public.wallet_log_revision();

/*
 * "What did I change, and when" for one entry or the whole ledger. Returned as
 * a function so the diff summary is built once, in the database, next to the
 * data it describes.
 */
create or replace function public.wallet_history(
  p_user_id uuid,
  p_entry_id uuid default null,
  p_limit int default 20
)
returns table (
  id uuid,
  entry_id uuid,
  action text,
  changed_fields text[],
  actor text,
  created_at timestamptz,
  description text,
  before jsonb,
  after jsonb
)
language sql
stable
set search_path = ''
as $fn$
  select
    r.id,
    r.entry_id,
    r.action,
    r.changed_fields,
    r.actor,
    r.created_at,
    coalesce(r.after ->> 'description', r.before ->> 'description')::text,
    r.before,
    r.after
  from public.wallet_entry_revisions r
  where r.user_id = p_user_id
    and (p_entry_id is null or r.entry_id = p_entry_id)
  order by r.created_at desc
  limit least(coalesce(p_limit, 20), 100);
$fn$;

alter function public.wallet_history(uuid, uuid, int) set statement_timeout = '5s';
