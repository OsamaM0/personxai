-- 0016_bots_chats_google: dashboard-managed bot tokens, group chats, Google accounts
--
-- Three things move out of the environment and into the database, because all
-- three are things a user changes at runtime rather than at deploy time:
--
--   bots            BotFather tokens. The worker used to read exactly one from
--                   TELEGRAM_BOT_TOKEN; now a row here is the source of truth
--                   and the env var is only the first-run bootstrap. Each bot
--                   owns its webhook secret, so a token swap re-registers
--                   without touching secrets or redeploying.
--   chats           Every group/supergroup/channel the bot has been added to,
--                   discovered from my_chat_member updates and from traffic.
--                   `reply_mode` is the per-group gate the orchestrator reads.
--   oauth_accounts  Per-user third-party tokens (Google). Refresh tokens live
--                   here so a turn can mint an access token on demand.

-- ── Bots ─────────────────────────────────────────────────────────────────────
create table public.bots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  channel text not null default 'telegram',
  token text not null,                        -- BotFather token; never leaves the worker
  bot_external_id text,                       -- numeric telegram id from getMe
  username text,                              -- @name, without the "@"
  title text,                                 -- bot's display name
  webhook_secret text not null,               -- per-bot X-Telegram-Bot-Api-Secret-Token
  webhook_url text,                           -- what setWebhook was last called with
  is_active boolean not null default true,
  is_default boolean not null default false,  -- answers the legacy secret-less webhook path
  last_error text,
  registered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index bots_user_idx on public.bots(user_id);
-- The same bot may not be registered twice: two rows would race on setWebhook.
create unique index bots_channel_external_uniq
  on public.bots(channel, bot_external_id) where bot_external_id is not null;
-- One default per channel — the legacy /channels/<name>/webhook path resolves to it.
create unique index bots_one_default_per_channel
  on public.bots(channel) where is_default;
create trigger bots_set_updated_at before update on public.bots
  for each row execute function public.set_updated_at();

-- ── Chats (groups the bot is in) ─────────────────────────────────────────────
create table public.chats (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  bot_id uuid references public.bots(id) on delete set null,
  channel text not null default 'telegram',
  external_chat_id text not null,
  chat_type text not null default 'group',    -- group | supergroup | channel | private
  title text,
  username text,
  is_enabled boolean not null default true,
  -- mention: only @mentions, replies to the bot and /commands wake it (default)
  -- all: every message in the group is a turn
  -- off: the bot stays silent here
  reply_mode text not null default 'mention'
    check (reply_mode in ('mention', 'all', 'off')),
  member_count integer,
  bot_status text,                            -- member | administrator | left | kicked
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel, external_chat_id)
);
create index chats_user_idx on public.chats(user_id, channel);
create trigger chats_set_updated_at before update on public.chats
  for each row execute function public.set_updated_at();

-- ── OAuth accounts (Google) ──────────────────────────────────────────────────
-- One account per provider per user: a second Google account would double every
-- "which calendar?" question for no benefit the user has asked for.
create table public.oauth_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  provider text not null,                     -- 'google'
  account_id text,                            -- provider's stable subject id
  account_email text,
  access_token text,
  refresh_token text,
  expires_at timestamptz,
  scopes text[] not null default '{}',
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider)
);
create index oauth_accounts_user_idx on public.oauth_accounts(user_id);
create trigger oauth_accounts_set_updated_at before update on public.oauth_accounts
  for each row execute function public.set_updated_at();

-- RLS stays deny-all (service_role only), like every other table here.
alter table public.bots enable row level security;
alter table public.chats enable row level security;
alter table public.oauth_accounts enable row level security;
