# Bots and groups

The bot token is no longer a deployment secret. It lives in the `bots` table and
is managed from the dashboard, so putting a new BotFather token in takes a paste
and a click — no `wrangler secret put`, no redeploy, no downtime.

- [Adding a bot](#adding-a-bot)
- [What registration actually does](#what-registration-actually-does)
- [Several bots at once](#several-bots-at-once)
- [Group chats](#group-chats)
- [The env variables that remain](#the-env-variables-that-remain)
- [Troubleshooting](#troubleshooting)

## Adding a bot

1. In Telegram, open [@BotFather](https://t.me/BotFather) and send `/newbot`.
   Answer its two questions and copy the token it gives you — it looks like
   `123456789:AAExampleTokenFromBotFather`.
2. Open the dashboard → **Bots** → **Add a bot**, paste the token, and submit.
3. Send your new bot a message from the Telegram account whose id is in
   `OWNER_TELEGRAM_ID`. It answers.

That is the whole procedure. The token is verified with Telegram's `getMe`
before anything is stored, so a typo fails at the form with
*"Telegram rejected that token"* instead of being saved and silently never
receiving an update.

The token is stored in your own Supabase database and is never sent back to the
browser: the Bots page shows the username, the webhook URL and the last error,
and nothing else.

## What registration actually does

Adding a bot performs, in one request:

| Call | Why |
| --- | --- |
| `getMe` | proves the token works and gives the bot's id and @username |
| `setWebhook` | points Telegram at `/channels/telegram/webhook/<bot id>` with a freshly generated per-bot secret |
| `setMyCommands` | publishes the `/` menu, in English and Arabic |
| `setMyDescription` | the text shown on an empty chat |
| `setChatMenuButton` | points the chat menu button at the dashboard as a Mini App |

Each bot gets **its own webhook secret and its own webhook path**, which is what
makes running more than one safe: an update is attributed to a bot before its
body is even parsed, and a leaked secret for one bot says nothing about another.

`allowed_updates` includes `my_chat_member`, which is how groups register
themselves (see below).

**Re-register** on the Bots page re-runs all of the above. Use it after changing
`PUBLIC_BASE_URL`, moving the worker, or if the Webhook column says *points
elsewhere*.

## Several bots at once

The dashboard can hold any number of bots. One of them is the **default**, which
is what everything that did not arrive on a webhook speaks as: reminders, the
daily brief, dashboard login links, files sent from the Files page, and MCP
calls. Chat replies always go out through the bot the message came in on.

**Disable** stops a bot from being resolved without deleting it — its webhook
path starts returning 404. **Remove** additionally calls `deleteWebhook` so
Telegram stops trying.

## Group chats

Add the bot to a group the ordinary Telegram way. It appears on the dashboard's
**Groups** page the moment it joins, because Telegram sends a `my_chat_member`
update — you do not have to message it first.

**By default the bot stays quiet in a group.** It answers only when it is
actually addressed:

- someone `@mentions` it,
- someone replies to one of its messages,
- someone sends a slash command that either names it (`/tasks@yourbot`) or names
  no bot at all.

Per group you can change this on the Groups page:

| When to answer | Behaviour |
| --- | --- |
| **Only when mentioned** (default) | as above |
| **Every message** | every message in the group becomes a turn — noisy, and every turn costs a model call |
| **Stay silent** | the bot ignores the group entirely |

**Disable** has the same effect as *Stay silent* and survives a reply-mode
change. **Forget** deletes the row; the bot stays in the group but falls back to
the default behaviour.

### Whose data does a group turn use?

The speaker's own. A group message is resolved to the sender's account exactly
as a private message is, so the assistant reads and writes *their* tasks, notes
and wallet. Someone who is not already allowed to use this assistant is ignored
in silence — no "you are not allowed" message, because that would be shouted at
everyone in the room. The denial is still written to the audit log.

Replies land in the group. Out-of-band messages (reminders, login links) still go
to the person's private chat: a group id never overwrites their `chat_ref`.

### Telegram's privacy mode

By default BotFather gives a bot *group privacy*, which means Telegram only
delivers messages that mention it, reply to it, or are commands. That matches
the default reply mode, so nothing extra is needed.

If you want **Every message** to actually work, turn privacy mode off:
BotFather → `/mybots` → your bot → Bot Settings → Group Privacy → Turn off. Then
remove and re-add the bot to the group (Telegram applies the setting at join
time).

## The env variables that remain

| Variable | Still required? | Notes |
| --- | --- | --- |
| `OWNER_TELEGRAM_ID` | **yes** | the account that becomes the owner on first contact, and the only one that can sign into the dashboard before anything exists |
| `TELEGRAM_BOT_TOKEN` | no | first-run bootstrap; seeded into `bots` the first time the dashboard lists them |
| `TELEGRAM_WEBHOOK_SECRET` | no | only used with the bootstrap token, on the legacy path |
| `VAULT_CHANNEL_ID` | no | vault channels can be connected from `/vault` or the dashboard |

A worker with none of the optional three boots normally and waits for a bot to be
added. The legacy webhook path `/channels/telegram/webhook` (no bot id) keeps
working and resolves to the default bot, so an existing deployment does not break
on upgrade.

`POST /admin/register-webhook?secret=<DISPATCH_SECRET>` still works too: it
re-registers the default bot if there is one, and otherwise falls back to the env
credentials.

## Troubleshooting

**The bot does not answer at all.** Check the Bots page: does the row say
*webhook set*, and does the Webhook column match `expectedWebhook`? If not, press
Re-register. If registration fails, the error Telegram returned is shown in the
row.

**"cannot work out this deployment's public URL"** — set `PUBLIC_BASE_URL` to the
origin Telegram should call back on.

**The bot answers in private but not in a group.** Either the group's reply mode
is *Stay silent*/disabled, or the message was not addressed to it. Try
`@yourbot hello`.

**The bot answers in a group but ignores one person.** That person's Telegram
account is not an allowed user of this assistant.

**A second deployment stole the webhook.** Telegram allows one webhook per bot
token. Two deployments sharing a token will fight; give each its own bot.
