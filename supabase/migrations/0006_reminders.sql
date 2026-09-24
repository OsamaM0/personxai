-- 0006_reminders: reminders + transactional job outbox
-- Ported from openmemo (github.com/haerincode/openmemo) migrations 0001_init_office.sql,
-- generalized to multi-user and trimmed to the kinds this project uses.

create type public.reminder_kind as enum ('static', 'recurring', 'dynamic');
create type public.reminder_status as enum (
  'scheduled', 'active', 'paused', 'completed', 'cancelled', 'failed'
);
create type public.job_status as enum ('pending', 'in_flight', 'delivered', 'failed', 'dead_letter');

create table public.reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  kind public.reminder_kind not null default 'static',
  status public.reminder_status not null default 'scheduled',
  content text,                  -- what to remind about (directive for the agent, not verbatim user text)
  raw_text text,                 -- original user phrasing
  recurrence_rule text,          -- RRULE string for recurring
  start_at timestamptz,
  next_trigger_at timestamptz,
  deadline_at timestamptz,
  timezone text not null default 'UTC',
  template_id text,              -- 'daily_brief' | 'heartbeat' for dynamic kind
  template_params jsonb,
  linked_task_id uuid references public.tasks(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (kind <> 'recurring' or recurrence_rule is not null),
  check (kind <> 'dynamic' or template_id is not null)
);
create trigger reminders_set_updated_at before update on public.reminders
  for each row execute function public.set_updated_at();
create index reminders_due_idx on public.reminders (next_trigger_at)
  where status in ('scheduled', 'active');
create index reminders_user_status_idx on public.reminders (user_id, status);
create index reminders_linked_task_idx on public.reminders (linked_task_id);

create table public.job_outbox (
  id uuid primary key default gen_random_uuid(),
  reminder_id uuid not null references public.reminders(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  occurrence_at timestamptz not null,
  idempotency_key text not null unique,  -- 'rem:<reminder_id>:<epoch>'
  status public.job_status not null default 'pending',
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  in_flight_until timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);
create index job_outbox_due_idx on public.job_outbox (next_attempt_at)
  where status in ('pending', 'in_flight');
create index job_outbox_reminder_id_idx on public.job_outbox (reminder_id);
create index job_outbox_user_id_idx on public.job_outbox (user_id);

alter table public.reminders enable row level security;
alter table public.job_outbox enable row level security;
