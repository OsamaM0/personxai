-- 0007_scheduler_fns: outbox scheduler functions
-- Ported from openmemo (github.com/haerincode/openmemo) 0004_scheduler_fns.sql.
-- Called by the Worker dispatcher via supabase-js .rpc() on every cron tick (no pg_cron).
-- All SECURITY DEFINER, service_role-only.

-- Materialize due reminders into the outbox (idempotent via idempotency_key)
create or replace function public.select_due_reminders()
returns integer
language sql
security definer
set search_path = ''
as $$
  with inserted as (
    insert into public.job_outbox (reminder_id, user_id, occurrence_at, idempotency_key)
    select
      r.id,
      r.user_id,
      r.next_trigger_at,
      'rem:' || r.id::text || ':' || extract(epoch from r.next_trigger_at)::bigint
    from public.reminders r
    where r.status in ('scheduled', 'active')
      and r.next_trigger_at is not null
      and r.next_trigger_at <= now()
    on conflict (idempotency_key) do nothing
    returning 1
  )
  select coalesce(count(*), 0)::integer from inserted;
$$;

-- Claim a batch of due jobs with queue semantics:
-- FOR UPDATE SKIP LOCKED + 2-minute visibility lease; stale in_flight jobs are reclaimed.
create or replace function public.claim_due_jobs(p_batch integer default 20)
returns table (
  job_id uuid,
  reminder_id uuid,
  user_id uuid,
  occurrence_at timestamptz,
  attempts integer,
  kind public.reminder_kind,
  content text,
  raw_text text,
  recurrence_rule text,
  timezone text,
  template_id text,
  template_params jsonb,
  linked_task_id uuid
)
language sql
security definer
set search_path = ''
as $$
  with claimed as (
    update public.job_outbox j
    set status = 'in_flight',
        attempts = j.attempts + 1,
        in_flight_until = now() + interval '2 minutes'
    where j.id in (
      select id from public.job_outbox
      where (status = 'pending' and next_attempt_at <= now())
         or (status = 'in_flight' and in_flight_until < now())
      order by next_attempt_at asc
      limit p_batch
      for update skip locked
    )
    returning j.id, j.reminder_id, j.user_id, j.occurrence_at, j.attempts
  )
  select
    c.id as job_id,
    c.reminder_id,
    c.user_id,
    c.occurrence_at,
    c.attempts,
    r.kind,
    r.content,
    r.raw_text,
    r.recurrence_rule,
    r.timezone,
    r.template_id,
    r.template_params,
    r.linked_task_id
  from claimed c
  join public.reminders r on r.id = c.reminder_id;
$$;

create or replace function public.mark_job_delivered(p_job_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.job_outbox
  set status = 'delivered', delivered_at = now(), in_flight_until = null
  where id = p_job_id;
$$;

-- Exponential backoff (2^attempts minutes), dead-letter after 5 attempts
create or replace function public.mark_job_failed(p_job_id uuid, p_error text)
returns public.job_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.job_outbox%rowtype;
  v_status public.job_status;
begin
  select * into v_job from public.job_outbox where id = p_job_id for update;
  if not found then
    return null;
  end if;

  if v_job.attempts >= 5 then
    v_status := 'dead_letter';
    update public.job_outbox
    set status = 'dead_letter', last_error = p_error, in_flight_until = null
    where id = p_job_id;
  else
    v_status := 'pending';
    update public.job_outbox
    set status = 'pending',
        last_error = p_error,
        in_flight_until = null,
        next_attempt_at = now() + (power(2, v_job.attempts)::text || ' minutes')::interval
    where id = p_job_id;
  end if;

  return v_status;
end;
$$;

revoke execute on function public.select_due_reminders() from public, anon, authenticated;
revoke execute on function public.claim_due_jobs(integer) from public, anon, authenticated;
revoke execute on function public.mark_job_delivered(uuid) from public, anon, authenticated;
revoke execute on function public.mark_job_failed(uuid, text) from public, anon, authenticated;
grant execute on function public.select_due_reminders() to service_role;
grant execute on function public.claim_due_jobs(integer) to service_role;
grant execute on function public.mark_job_delivered(uuid) to service_role;
grant execute on function public.mark_job_failed(uuid, text) to service_role;
