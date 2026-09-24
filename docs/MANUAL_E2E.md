# Manual end-to-end checklist

Unit tests cover the pure logic; this covers the parts only a real Telegram round trip can prove. Run it after the first deploy and after any phase-level change.

Keep `npx wrangler tail` open in a second terminal throughout.

## 0. Setup sanity

- [ ] `GET /health` returns `{"ok":true,"service":"personxai","channels":{"telegram":true,"whatsapp":<true if configured>}}`
- [ ] `wrangler tail` shows no `Missing/invalid required secrets` on first message
- [ ] Webhook registered: `curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"` shows your Worker URL, `pending_update_count: 0`, and no `last_error_message`

## 1. Foundation

- [ ] DM `/start` from the **owner** account → welcome + timezone prompt; `users` gains one row with `role='owner'`
- [ ] Answer `/tz Africa/Cairo` (or `/tz 21:30`) → confirmation; `users.timezone` updated, `tz_confirmed=true`
- [ ] Send `hello` → a real reply; `messages` gains a user row and an assistant row
- [ ] `/status` → run count and token usage for the last 24h
- [ ] **From a second, non-allowlisted account**: DM the bot → one polite refusal, and *nothing further* on subsequent messages (the notice is once-per-user)
- [ ] Send 25 messages quickly → rate-limit notice appears at most once a minute
- [ ] **Duplicate webhook**: replay the same update twice with curl (copy a real update body from `wrangler tail`) → only one reply, and only one `agent_runs` row

## 2. Productivity

- [ ] "add a high-priority task to deploy the bot before Sunday" → task created; `/tasks` lists it with 🟠
- [ ] "remind me in 2 minutes to stretch" → confirmation of the local time, then the reminder actually arrives within ~1 minute of due
- [ ] "every Sunday at 9am remind me to review my projects" → recurring reminder; after it fires, `reminders.next_trigger_at` advances by a week (check the row)
- [ ] "start a project called ResumeForge" → project created; `/projects` lists it
- [ ] "what should I focus on today?" → answers from real rows, no invented tasks
- [ ] `/today` with nothing due → the all-clear message, **zero** new `agent_runs` rows
- [ ] Set `/settings autonomy 0`, then "add a task to buy milk" → inline Confirm/Cancel buttons appear; press **Confirm** → task created and the prompt message is edited to the outcome
- [ ] Press a **stale** button (one from ≥10 minutes ago) → "that confirmation expired", no action taken
- [ ] `/cancel` with a pending confirmation → cleared; pressing the old button afterwards does nothing
- [ ] Restore `/settings autonomy 1`

## 3. Files

- [ ] Send a PDF → saved confirmation; if a matching project exists, Save/Keep/Ignore buttons appear
- [ ] `/files` lists it with size
- [ ] Wait ~15s, then "summarize the PDF I just sent" → a summary grounded in the actual text (verify `files.extraction_status='done'` and `file_chunks` rows exist)
- [ ] **Reply** to the file message with "what does this say about X?" → answers without you naming the file
- [ ] "find the PDF about <topic>" → `find_files` locates it
- [ ] Ask for it back → the file is delivered from the vault with no "forwarded from" header
- [ ] Send the **same** file again → recognized as a duplicate, no second row
- [ ] Send a voice note → transcribed and answered
- [ ] Send a photo album (2+ images at once) → all are stored, one summary message (not one per image)
- [ ] Check the private vault channel: every file above appears there

## 4. Memory & search

- [ ] "remember that I prefer practical examples over theory" → stored; `memories` gains a row
- [ ] `/newchat`, then "what do you remember about how I like to learn?" → recalls it across conversations
- [ ] "remember that my wake time is 06:30" → stored as a user fact; confirm it appears in later prompts by asking "when do I usually wake up?"
- [ ] Send a bare URL → fetched, summarized, bookmarked (no LLM turn spent on the capture — check `agent_runs`)
- [ ] `/links` lists it with a title
- [ ] `/find <term>` → grouped results across projects/tasks/notes/files/links
- [ ] "forget what I said about X" → asks for confirmation before deleting

## 5. Automation

- [ ] `/brief now` → real overdue/today/waiting sections, then a focus suggestion drawn only from those items
- [ ] `/brief on 08:00` → confirmation; a `reminders` row with `kind='dynamic'`, `template_id='daily_brief'`
- [ ] Next morning (or set the time 3 minutes out): the brief arrives on its own
- [ ] `/heartbeat now` with nothing overdue → the all-clear reply and **zero** new `agent_runs` rows (this is the free-tier guarantee)
- [ ] `/brief off` → cancelled

## 6. Skills & MCP

- [ ] "create a skill called weekly review that lists my projects, finds stale ones, and drafts a summary note" → skill saved; `/skills` lists it
- [ ] Say "run my weekly review" → the model calls `run_skill` and follows the stored instructions
- [ ] `/mcp` with none connected → the empty-state message
- [ ] (If you have an MCP server) "connect the MCP server at <url>" → confirmation prompt; after confirming, its tools appear on the *next* message and each external call asks for confirmation at autonomy ≤1

## 7. WhatsApp (if configured — docs/WHATSAPP.md)

- [ ] Meta's **Verify and save** on the webhook form succeeds (GET handshake); `GET /health` shows `"whatsapp": true`
- [ ] First message from `OWNER_WHATSAPP_ID` → "channel linked" welcome; `user_identities` gains a `whatsapp` row with the **same** `user_id` as the Telegram owner (no second `users` row)
- [ ] `/tasks` on WhatsApp lists the tasks created on Telegram
- [ ] Set `/settings autonomy 0`, then "add a task to buy milk" → **reply buttons** Confirm / Cancel; tap Confirm → task created and a *new* confirmation message arrives (WhatsApp cannot edit)
- [ ] Read receipt (blue ticks) and typing indicator appear while the model answers
- [ ] Send a PDF on WhatsApp → it appears in the **Telegram vault channel** and in `/files` on both channels; "summarise the PDF I just sent" works
- [ ] Dashboard → a file → **Send** while signed in through WhatsApp → the document arrives on WhatsApp
- [ ] A voice note on WhatsApp → transcribed and answered
- [ ] From a second WhatsApp number → one polite refusal
- [ ] Replay a webhook body with a wrong `X-Hub-Signature-256` via curl → `403`, nothing processed
- [ ] Restore `/settings autonomy 1`

## Language

- [ ] Repeat a few of the above in Arabic ("فكرني بكرة الساعة ٩ أكلم أحمد", "ايه المهام المتأخرة؟") → replies in Arabic, technical terms left in English, dates rendered with Latin digits
- [ ] Mix Arabic and English in one message → the reply follows the dominant language without translating your technical terms

## Failure handling

- [ ] Temporarily set a bad `LLM_MAIN_API_KEY` and send a message → a plain error reply, no crash, `agent_runs.status='error'`
- [ ] Restore the key
- [ ] Send a >20MB document → stored in the vault, and the assistant says plainly that it cannot read its contents
