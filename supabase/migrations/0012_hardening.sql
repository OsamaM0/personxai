-- 0012_hardening: statement timeouts on user-facing search functions.
-- A pathological query must never pin the free-tier instance; the Worker's own
-- tool timeouts are the second line of defence.

alter function public.hybrid_search(uuid, text, extensions.vector, public.entity_kind[], int)
  set statement_timeout = '10s';
alter function public.match_memories(uuid, extensions.vector, uuid, text[], int)
  set statement_timeout = '5s';
alter function public.match_file_chunks(uuid, extensions.vector, uuid, int)
  set statement_timeout = '5s';
alter function public.match_messages(uuid, uuid, extensions.vector, int)
  set statement_timeout = '5s';
alter function public.match_notes(uuid, extensions.vector, uuid, int)
  set statement_timeout = '5s';

-- The dispatcher path must stay snappy: a slow claim blocks the whole tick.
alter function public.claim_due_jobs(int) set statement_timeout = '10s';
alter function public.select_due_reminders() set statement_timeout = '10s';

-- Re-assert the deny-all posture for anything added since 0001.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
