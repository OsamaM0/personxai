# Google: Gmail, Calendar + Meet, Tasks, Contacts

The assistant can read and send your mail, put things on your calendar (with a
Google Meet link), keep your Google Tasks list, and look people up in your
contacts. Everything here works on an ordinary free Google account — there is no
Workspace requirement and no paid API.

- [What it can do](#what-it-can-do)
- [Setting up the OAuth client](#setting-up-the-oauth-client)
- [Connecting your account](#connecting-your-account)
- [How it behaves](#how-it-behaves)
- [Where the tokens live](#where-the-tokens-live)
- [Troubleshooting](#troubleshooting)

## What it can do

| Tool | What it does |
| --- | --- |
| `search_email` | search Gmail with its own query syntax (`is:unread`, `from:sara`, `newer_than:7d`) |
| `read_email` | read one message, body flattened to text |
| `send_email` | send, or reply inside an existing thread |
| `email_summary` | unread count plus the newest few — used for "anything important?" |
| `list_calendar_events` | what is on the calendar in a window |
| `create_calendar_event` | add an event; `withMeet` attaches a **Google Meet** link |
| `update_calendar_event` | move, rename, re-invite, or add a Meet link afterwards |
| `delete_calendar_event` | cancel (Google notifies attendees) |
| `find_free_time` | gaps in the calendar, before proposing a slot |
| `list_google_tasks` / `add_google_task` / `complete_google_task` | the Google Tasks list on your phone — separate from this assistant's own tasks |
| `search_contacts` | turn "Sara" into an email address |
| `google_status` | whether the account is linked, and to which address |

**Creating a meeting** is `create_calendar_event` with `withMeet: true`. Google
issues the Meet link as part of the event, which is why there is no separate Meet
integration: the calendar event *is* the meeting.

Ask in either language:

> اعملي ميتنج مع أحمد بكرة الساعة ٤ ونص ساعة، وابعتله الرابط

> Anything unread from the bank this week? Summarise it.

> When am I free on Thursday afternoon for an hour?

## Setting up the OAuth client

One OAuth client covers the whole deployment; each user then links their own
Google account. You do this once.

1. Open the [Google Cloud console](https://console.cloud.google.com/) and create
   a project (or pick an existing one).
2. **APIs & Services → Library** — enable these four:
   - Gmail API
   - Google Calendar API
   - Google Tasks API
   - People API
3. **APIs & Services → OAuth consent screen** — choose **External**, fill in the
   app name and your own email. While the app is in *Testing*, add your Google
   address under **Test users**; that is all a personal deployment needs, and it
   avoids Google's verification review entirely. (Refresh tokens for an
   unverified app expire after 7 days — see Troubleshooting.)
4. **APIs & Services → Credentials → Create credentials → OAuth client ID →
   Web application**. Under **Authorized redirect URIs** add exactly:

   ```
   https://<your dashboard origin>/auth/google/callback
   ```

   That origin is `PUBLIC_BASE_URL` when you set one, otherwise the worker's own
   URL. The dashboard's Google card shows the exact URI it will use — copy it
   from there if in doubt. A mismatch of even a trailing slash is rejected by
   Google with `redirect_uri_mismatch`.
5. Put the two values into your worker's secrets:

   ```bash
   wrangler secret put GOOGLE_CLIENT_ID
   wrangler secret put GOOGLE_CLIENT_SECRET
   ```

   For local development or Docker, add them to `.dev.vars`. If your redirect URI
   is not `<PUBLIC_BASE_URL>/auth/google/callback` — for instance the dashboard
   is on Vercel and the worker is elsewhere — pin it with `GOOGLE_REDIRECT_URI`.

With neither variable set, the Google tools are not offered at all and the
assistant says plainly that mail and calendar are not connected.

## Connecting your account

Dashboard → **Settings** → **Connect Google**. Google shows you exactly which
permissions are being asked for; approve them and you land back on Settings with
your address shown.

The scopes requested are:

| Scope | For |
| --- | --- |
| `gmail.readonly` | reading and searching mail |
| `gmail.send` | sending and replying |
| `calendar.events` | reading and writing events, including Meet links |
| `tasks` | Google Tasks |
| `contacts.readonly` | resolving names to addresses |
| `userinfo.email` | showing which account is connected |

There is no scope for deleting mail, and none for anything outside these four
products.

**Disconnect** on the same card revokes the token at Google and deletes the
stored row.

## How it behaves

Every Google tool is an *external* tool, so at low autonomy levels the assistant
asks before it acts and you approve with a button in chat. Two of them are
irreversible and confirm **at every autonomy level**, because they are visible to
other people and cannot be taken back:

- `send_email` — mail cannot be unsent
- `delete_calendar_event` — Google emails the cancellation to attendees

Sending an invitation is opt-in separately: attendees are added to an event
without being emailed unless the assistant sets `sendInvites`, which it does only
when you asked for people to be invited.

Contacts are read-only, and the assistant is instructed to ask rather than guess
when a name matches several people or none.

Every call is written to the audit log (`google.mail.send`,
`google.calendar.create`, …), visible on the dashboard's Activity page.

## Where the tokens live

In your own Supabase database, table `oauth_accounts`, one row per user. It holds
the access token, the refresh token, the expiry and the granted scopes. Tokens
are never sent to the browser: the dashboard is shown the account's email address
and its scopes, nothing more.

Access tokens last about an hour. Every call refreshes on demand and re-persists
the new token, so nothing expires mid-conversation.

## Troubleshooting

**`redirect_uri_mismatch`** — the URI in the Google console does not match the
one the dashboard sent. Copy the exact value from the Settings card (it is in the
`redirectUri` field of `GET /api/google`) into **Authorized redirect URIs**.

**"Google is not connected" after it worked for a week** — while your OAuth
consent screen is in *Testing*, Google expires refresh tokens after 7 days. Press
Reconnect, or publish the consent screen. For a personal deployment where you are
the only user, reconnecting weekly is usually less trouble than verification;
publishing without verification also works and simply shows an "unverified app"
warning on the consent screen.

**"this deployment has no Google OAuth client configured"** — `GOOGLE_CLIENT_ID`
or `GOOGLE_CLIENT_SECRET` is missing from the worker. Check with `wrangler secret
list`, and remember a secret change needs no redeploy but a *variable* change
does.

**`insufficient authentication scopes` (403)** — the account was linked before a
scope was added. Press Reconnect; the consent screen is forced on every connect,
so the new scope is granted.

**Contacts search returns nothing the first time** — Google's contacts search
reads a server-side cache that is built on first use. The client sends a warmup
request for exactly this reason, but a brand-new account can still need a second
try.

**Meet link missing from an event you created** — the assistant only asks for one
when it understood the request as a meeting. Ask for it explicitly ("add a Meet
link to that") and `update_calendar_event` attaches one to the existing event.
