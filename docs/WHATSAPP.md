# WhatsApp channel

PersonXAI speaks WhatsApp through the **WhatsApp Cloud API** (Meta's hosted Business API — no phone plugged into a server, no third-party gateway). It is a second door into the **same brain**: the owner's WhatsApp number is linked to the existing owner account, so projects, tasks, notes, files, memory, reminders and skills are shared with Telegram.

```
WhatsApp ──POST /channels/whatsapp/webhook──▶ Worker ──▶ u:whatsapp:<wa_id> Durable Object
           X-Hub-Signature-256 (HMAC over body)          same orchestrator, tools, prompts
```

Telegram stays required: it is the **file vault** (files sent on WhatsApp are relayed into the private Telegram channel) and the channel the wizard bootstraps the owner on. WhatsApp is optional and all-or-nothing — set all four `WHATSAPP_*` secrets or none.

## What works, and how it degrades

| Telegram feature | WhatsApp |
|---|---|
| Text, Markdown | ✅ `*bold*`, `_italic_`, `` `code` `` render natively; `**bold**`, `[label](url)` and `# headings` are rewritten ([`format.ts`](../src/channels/whatsapp/format.ts)) |
| Slash commands (`/today`, `/tasks` …) | ✅ same commands, typed by hand (no `/` menu on WhatsApp) |
| Inline **Confirm / Cancel** buttons | ✅ interactive **reply buttons** (≤ 3), a **list message** for 4–10 choices, a **CTA URL** button for a lone link, numbered text beyond that |
| Editing a message in place ("confirmed ✓") | ↘ a fresh message — WhatsApp cannot edit sent messages |
| Typing indicator | ✅ read receipt + typing indicator on the message being answered |
| Voice notes → transcription | ✅ (`audio` with `voice: true`) |
| Documents, photos, videos, stickers | ✅ downloaded (≤ 20 MB) and **relayed into the Telegram vault**, so `/files`, search, extraction and "summarise the PDF" work identically |
| Sending a stored file back | ✅ the vault file is fetched via Telegram (≤ 20 MB) and uploaded to WhatsApp |
| Location pins | ✅ arrive as text (`📍 name — lat,lng`) the model can act on |
| Reactions, contacts, unsupported types | ignored |
| Dashboard `/dashboard` sign-in link, `/connect` MCP token | ✅ delivered on WhatsApp |
| Reminders, daily brief, heartbeat | ✅ delivered on the channel the identity was created on first (Telegram if you started there) |

WhatsApp Business also enforces a **24-hour customer-service window**: the bot can message you freely for 24 h after your last message. Reminders that fall outside that window need an approved *message template* — see [Limitations](#limitations).

## Setup (≈ 15 minutes)

### 1 · Meta app with the WhatsApp product

1. Go to [developers.facebook.com/apps](https://developers.facebook.com/apps) → **Create app** → type **Business** → name it (`PersonXAI`) → create.
2. In the app dashboard, **Add product → WhatsApp → Set up**. Pick or create a Meta Business portfolio.
3. Open **WhatsApp → API Setup**. Note two values:
   - **Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID` (digits; *not* the WhatsApp Business Account ID).
   - The **test number** Meta gives you works immediately with up to 5 recipient numbers — add your own number under *To* and confirm the code it sends. For a real number, follow *Add phone number* (it must not be registered on the WhatsApp app).
4. **App settings → Basic → App secret** → *Show* → `WHATSAPP_APP_SECRET`. This signs every webhook.

### 2 · A permanent access token

The token shown on *API Setup* expires in 24 hours. Create a permanent one:

1. [business.facebook.com](https://business.facebook.com) → **Settings → Users → System users → Add** (role *Admin*).
2. **Assign assets** → your app → *Manage app* ✓, and your WhatsApp account → *Manage* ✓.
3. **Generate new token** → select the app → expiry **Never** → permissions `whatsapp_business_messaging` and `whatsapp_business_management` → copy → `WHATSAPP_ACCESS_TOKEN`.

### 3 · Secrets

Generate `WHATSAPP_VERIFY_TOKEN` yourself (any random string ≥ 16 chars — `openssl rand -hex 24`). Put your own number in `OWNER_WHATSAPP_ID` as E.164 digits (`201001234567`; a leading `+` is tolerated).

```bash
# secrets.json (docs/CONFIGURATION.md), then:
npx wrangler secret bulk secrets.json && npx wrangler deploy
```

`npm run setup` has an optional WhatsApp step that asks for exactly these values.

### 4 · Point Meta at the Worker

1. **WhatsApp → Configuration → Webhook → Edit**:
   - Callback URL: `https://personxai.<subdomain>.workers.dev/channels/whatsapp/webhook`
   - Verify token: the value of `WHATSAPP_VERIFY_TOKEN`
   - **Verify and save** — Meta sends a GET handshake; the Worker echoes `hub.challenge` when the token matches.
2. **Manage** (webhook fields) → subscribe to **`messages`**.

`POST /admin/register-webhook` (or the wizard) prints the exact callback URL.

### 5 · First contact

Send anything from your number to the business number. The Worker recognises `OWNER_WHATSAPP_ID`, **links** the WhatsApp identity to the existing owner account (or provisions the owner if Telegram was never used) and replies with a welcome. From then on both channels share everything.

Anyone else who writes gets one polite refusal — same allowlist as Telegram.

## Configuration reference

| Variable | Required | Notes |
|---|---|---|
| `WHATSAPP_ACCESS_TOKEN` | with the channel | Permanent System User token |
| `WHATSAPP_PHONE_NUMBER_ID` | with the channel | Digits; from *API Setup* |
| `WHATSAPP_APP_SECRET` | with the channel | Verifies `X-Hub-Signature-256` on every webhook |
| `WHATSAPP_VERIFY_TOKEN` | with the channel | Your random string, pasted into Meta's webhook form |
| `OWNER_WHATSAPP_ID` | recommended | Your number as E.164 digits; without it nobody can bootstrap through WhatsApp |
| `WHATSAPP_API_VERSION` | no | Graph API version, default `v22.0` |

`GET /health` reports `"channels": {"telegram": true, "whatsapp": true}` when the set is complete. A partial set fails at boot with `WhatsApp is partially configured — also set …`.

## How it is built

- [`src/channels/whatsapp/`](../src/channels/whatsapp/) implements the same [`ChannelAdapter`](../src/channels/types.ts) contract as Telegram: `normalize.ts` (webhook → `IncomingMessage`, never throws), `send.ts` (`OutboundPort` with the degradations above), `webhook.ts` (handshake + HMAC), `api.ts` (Graph client with retries and token redaction).
- The core (`src/agent/`, `src/tools/`, `src/workflows/`) is untouched — it never learns which channel it is talking to.
- Two seams know about channels by design: [`services/media/fetch.ts`](../src/services/media/fetch.ts) (download bytes) and the vault relay in [`workflows/ingest-file.ts`](../src/workflows/ingest-file.ts) (non-Telegram media is uploaded into the vault channel instead of forwarded).
- Button ids reuse the Telegram callback tokens unchanged (≤ 64 bytes, well inside WhatsApp's 256-byte limit), so confirmations, inbox triage and paginated lists work with no new state.

## Limitations

- **24-hour window.** Outside it Meta rejects free-form messages (error 131047). A scheduled reminder that arrives after a day of silence on WhatsApp will be parked as a failed job and reported on the channel that *can* still reach you. If WhatsApp is your only channel, pre-approve a template in *WhatsApp → Message templates* and open an issue — template delivery is a small addition to `WhatsAppOutbound.sendText`.
- **20 MB** per file in either direction (Telegram Bot API download cap on the vault side, Graph upload limits on the WhatsApp side). Larger files still get a metadata row and a "too large" notice.
- **No message editing**, so a confirmed action produces a second message rather than rewriting the prompt.
- **Test numbers** can only message the 5 recipients you register; production numbers need Meta business verification for volume beyond 250 conversations/day.

## Troubleshooting

| Symptom | Cause → fix |
|---|---|
| Meta says *"The callback URL or verify token couldn't be validated"* | `WHATSAPP_VERIFY_TOKEN` differs from what you pasted, or secrets were not redeployed. `curl "https://<worker>/channels/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=1"` must print `1`. |
| Messages arrive in Meta's logs but the bot is silent | `wrangler tail`: `403` → `WHATSAPP_APP_SECRET` wrong (signature mismatch). Nothing at all → the `messages` field is not subscribed. |
| Bot replies *"not allowed"* to you | `OWNER_WHATSAPP_ID` does not match your `wa_id` (digits only, country code, no `+`). Check the `access_denied` row in `audit_logs` for the id it saw. |
| `(#131030) Recipient phone number not in allowed list` | Test number: add your number under *API Setup → To*. |
| `(#131047)` on a reminder | Outside the 24-hour window — see Limitations. |
| Token stops working after a day | You used the temporary *API Setup* token; create a System User token (step 2). |
