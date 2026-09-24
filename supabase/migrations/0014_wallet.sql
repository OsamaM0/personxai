-- 0014_wallet: personal money ledger — every expense and every bit of income,
-- with the running history the user can list, correct, and total.
--
-- One flat table rather than accounts + double entry: this tracks a person's
-- cash flow ("2 kg sugar, 25 LE"), not a business's books. Direction ('in' /
-- 'out') plus a per-entry currency is enough to answer "what did I spend this
-- month" and "what am I left with", and it keeps every write a single insert.
--
-- Deletes are soft, like notes and files: a mistyped amount stays recoverable
-- and the audit trail keeps meaning.

create type public.wallet_direction as enum ('in', 'out');

create table public.wallet_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  direction public.wallet_direction not null,
  amount numeric(14, 2) not null check (amount > 0),
  currency text not null default 'EGP' check (char_length(currency) between 2 and 8),
  description text not null,
  category text,
  -- What was bought, when the user said it: "2 kg sugar" → quantity 2, unit 'kg'.
  quantity numeric(12, 3) check (quantity is null or quantity > 0),
  unit text,
  -- cash / card / bank / instapay … free text: the set differs per country.
  method text,
  occurred_at timestamptz not null default now(),
  project_id uuid references public.projects(id) on delete set null,
  tags text[] not null default '{}',
  note text,
  source text not null default 'chat',
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger wallet_entries_set_updated_at before update on public.wallet_entries
  for each row execute function public.set_updated_at();
create index wallet_entries_user_time_idx on public.wallet_entries (user_id, occurred_at desc)
  where deleted_at is null;
create index wallet_entries_user_category_idx on public.wallet_entries (user_id, category)
  where deleted_at is null;
create index wallet_entries_project_id_idx on public.wallet_entries (project_id);
create index wallet_entries_tags_idx on public.wallet_entries using gin (tags);
create index wallet_entries_fts_idx on public.wallet_entries
  using gin (to_tsvector('simple', description || ' ' || coalesce(category, '') || ' ' || coalesce(note, '')));

alter table public.wallet_entries enable row level security;

-- Totals per currency for a window. The window is half-open [from, to) so
-- month-to-month sums never double-count the boundary instant.
create or replace function public.wallet_summary(
  p_user_id uuid,
  p_from timestamptz default null,
  p_to timestamptz default null
)
returns table (currency text, money_in numeric, money_out numeric, net numeric, entries bigint)
language sql
stable
set search_path = ''
as $fn$
  select
    w.currency,
    coalesce(sum(w.amount) filter (where w.direction = 'in'), 0)::numeric,
    coalesce(sum(w.amount) filter (where w.direction = 'out'), 0)::numeric,
    (coalesce(sum(w.amount) filter (where w.direction = 'in'), 0)
      - coalesce(sum(w.amount) filter (where w.direction = 'out'), 0))::numeric,
    count(*)::bigint
  from public.wallet_entries w
  where w.user_id = p_user_id
    and w.deleted_at is null
    and (p_from is null or w.occurred_at >= p_from)
    and (p_to is null or w.occurred_at < p_to)
  group by w.currency
  order by 3 desc;
$fn$;

-- "Where does the money go" — one row per category/currency/direction.
create or replace function public.wallet_category_totals(
  p_user_id uuid,
  p_direction public.wallet_direction default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_limit int default 20
)
returns table (
  category text,
  currency text,
  direction public.wallet_direction,
  total numeric,
  entries bigint
)
language sql
stable
set search_path = ''
as $fn$
  select
    coalesce(w.category, '')::text,
    w.currency,
    w.direction,
    sum(w.amount)::numeric,
    count(*)::bigint
  from public.wallet_entries w
  where w.user_id = p_user_id
    and w.deleted_at is null
    and (p_direction is null or w.direction = p_direction)
    and (p_from is null or w.occurred_at >= p_from)
    and (p_to is null or w.occurred_at < p_to)
  group by 1, w.currency, w.direction
  order by 4 desc
  limit least(coalesce(p_limit, 20), 100);
$fn$;

-- Same posture as every other user-facing aggregate (0012): a pathological
-- window must not pin the instance.
alter function public.wallet_summary(uuid, timestamptz, timestamptz)
  set statement_timeout = '5s';
alter function public.wallet_category_totals(uuid, public.wallet_direction, timestamptz, timestamptz, int)
  set statement_timeout = '5s';

revoke all on public.wallet_entries from anon, authenticated;
