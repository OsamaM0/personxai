# PersonXAI as an MCP server

PersonXAI is both an MCP **client** (it connects to your servers — see [SKILLS.md](SKILLS.md)) and an MCP **server**. This page is about the second one: pointing Claude Code, Codex, or any other MCP client at your deployment so it can read and write your projects, tasks, notes, files, links, reminders and memory — and talk to the assistant itself.

It is the same data, the same repositories and the same audit trail the Telegram bot uses. Anything an MCP client writes shows up in Telegram and on the dashboard immediately, and vice versa.

```
Claude Code / Codex ──POST /mcp──▶ Worker ──RPC──▶ UserAgent (Durable Object) ──▶ Supabase
   (bearer token)                (auth, catalogue)   (the same tools Telegram uses)
```

---

## 1 · Get a token

In Telegram:

```
/connect
```

The bot replies with a token plus a ready-to-paste command for each client. The token is shown **once** — nothing stores it, so a lost token is replaced rather than recovered.

| | |
|---|---|
| `/connect` | issue a **full**-scope token (default, 90 days) |
| `/connect read` | issue a **read**-scope token |
| `/connect status` | is access on, at which scope, until when |
| `/connect off` | revoke — every token issued before stops working immediately |

The dashboard has the same three operations at `GET`/`POST`/`DELETE /api/mcp-access`.

Issuing a token always replaces the previous one. Treat it like a password: it is bearer authentication, so whoever holds it is you.

---

## 2 · Connect a client

**Claude Code** — the `/connect` reply contains this line with your token already in it:

```bash
claude mcp add --transport http personxai https://<your-worker>/mcp \
  --header "Authorization: Bearer <token>"
```

Then `/mcp` inside Claude Code shows `personxai` connected, and `claude mcp list` confirms it from the shell.

**Codex** — put the token in an environment variable and reference it by name, so the secret never lands in a file you might commit. In `~/.codex/config.toml`:

```toml
[mcp_servers.personxai]
url = "https://<your-worker>/mcp"
bearer_token_env_var = "PERSONXAI_TOKEN"
```

**Anything else** — the endpoint is plain [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports), so the generic `.mcp.json` shape works too:

```json
{
  "mcpServers": {
    "personxai": {
      "type": "http",
      "url": "https://<your-worker>/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

Locally, `npm run dev` serves the same endpoint at `http://127.0.0.1:8787/mcp`.

---

## 3 · What the client sees

**Every tool in the registry** ([src/tools/defs](../src/tools/defs)) — projects, tasks, notes, inbox, files, links, memory, reminders, search, skills, tags. There is no second registry and no second permission model: a tool added for the chat surface appears over MCP on the next deploy, with its own schema and permission level.

**Plus `ask_assistant`** (full scope only) — one complete assistant turn: your conversation history, retrieved memories, stored facts, saved skills, the system prompt, and every tool the assistant would have had in Telegram. Use it for anything open-ended; use the specific tools when you already know the operation.

```
ask_assistant({ message: "what's overdue, and what should I do first?" })
ask_assistant({ message: "file these notes under the right projects",
                deliver_to_telegram: true })
```

The turn is written to your conversation, so it appears in `/contexts`, on the dashboard, and in the next Telegram turn's history — one thread across all three surfaces. `deliver_to_telegram` also sends the reply to your phone; by default the answer only goes back to the MCP client.

Tools carry MCP annotations, so a client can warn before it acts: `readOnlyHint` on read tools, `destructiveHint` on deletes and anything irreversible, `openWorldHint` on tools that reach outside your own data.

---

## 4 · The permission model

Two independent gates, and both apply:

**Scope**, chosen when the token is minted:

| scope | tools listed and callable |
|---|---|
| `read` | read-level tools only. No `ask_assistant` — an assistant turn can call write tools. |
| `full` | everything the account's role allows, plus `ask_assistant`. |

**Role**, from your PersonXAI account: a `viewer` gets read-level tools whatever the token says. Everything else is single-tenant — the token's user id is the only tenancy key, and it comes from the signed token, never from the request body.

### Why a named tool call is not confirmed again

On Telegram, autonomy levels decide when the assistant asks before acting. Over MCP the calling client is already the approval surface: Claude Code and Codex show you the exact tool and its exact arguments and wait for you before sending them. Asking a second time on your phone would add nothing and would hang the client. So a **named tool call** runs on the strength of the token's scope, and is recorded in the audit log as `mcp:<tool>` with its arguments, its result summary, the token's scope and the calling client's User-Agent.

`ask_assistant` is different: there, PersonXAI's own model picks the tools, and your MCP client cannot show you what that will be. So the turn keeps the confirmation gate for the two categories that most deserve it — tools marked irreversible, and tools marked confirm-always. Those still send a Confirm/Cancel button to Telegram, and the MCP call returns saying so. Ordinary reads and writes proceed.

### Revoking

`/connect off`, or `DELETE /api/mcp-access`. Both drop the rotation nonce stored in `settings`, which every token is checked against — so revocation is immediate and total, not a matter of waiting for expiry. Setting `is_allowed = false` on the user row in Supabase has the same effect on the token's next call.

---

## 5 · Endpoint reference

`POST /mcp` — JSON-RPC 2.0 over Streamable HTTP. Stateless: no session ids, no server-initiated stream, each request authenticated on its own.

| method | behaviour |
|---|---|
| `initialize` | negotiates `2025-06-18`, `2025-03-26` or `2024-11-05`; advertises `tools` only |
| `tools/list` | the catalogue for this token's scope and role |
| `tools/call` | runs in the caller's Durable Object, serialized against their Telegram traffic |
| `ping` | `{}` |
| `resources/list` · `prompts/list` | empty — this server exposes tools only |

Other verbs: `GET` → `405` (no server-initiated stream), `DELETE` → `204` (nothing to terminate), `OPTIONS` → CORS preflight. A missing or invalid token is `401` with `WWW-Authenticate: Bearer`. CORS is open because this route authenticates by bearer token only and never reads the dashboard's session cookie.

Tool failures come back the MCP way — `isError: true` inside a normal result, so the model can read the message and retry — while protocol-level problems (unknown tool, malformed arguments) are JSON-RPC errors.

---

## 6 · Notes and limits

- **Rate limiting**: the per-minute conversation limit applies inside `ask_assistant`, as it does for a Telegram turn — one budget per account, whichever surface spends it. Named tool calls are a single query and are governed by the token instead.
- **Catalogue size**: a full-scope token lists 59 tools (~32 KB of schema); a read-scope token lists 25. Unlike a chat turn, MCP has no per-message topic filter, so the client sees all of them at once — disable the ones you do not want in your client's own MCP settings, or use a read-scope token.
- **Token lifetime**: 90 days by default, 1–365 via `ttlDays` on the dashboard endpoint. Re-issue whenever you like — it is one Telegram command.
- **`send_file`** delivers to Telegram, because that is where the file vault lives; the MCP client gets the confirmation, your phone gets the file.
- **Latency**: `ask_assistant` is a full LLM turn and takes as long as one. Named tool calls are a single database round trip.
- **Secret**: tokens are signed with `WEB_SESSION_SECRET`, falling back to `DISPATCH_SECRET` — the same key the dashboard uses, domain-separated by purpose, so no new configuration is required.

## 7 · Troubleshooting

| symptom | cause |
|---|---|
| `401` from every call | token revoked or replaced by a newer `/connect`, or expired — issue a new one |
| Client connects but lists few tools | read-scope token, or the account's role is `viewer` |
| `ask_assistant needs a full-scope token` | re-issue with `/connect` (no argument) |
| A call returns "a confirmation is waiting there" | an irreversible tool inside `ask_assistant` — tap Confirm in Telegram |
| `I don't know my own public URL yet` | register the webhook, or set `PUBLIC_BASE_URL` |
| Client gets HTML instead of JSON | `/mcp` missing from `run_worker_first` in `wrangler.jsonc` |
