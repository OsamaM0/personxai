/**
 * Access tokens for the MCP server surface.
 *
 * Same trust model as the dashboard: the Telegram bot is the identity provider.
 * The owner asks for a token in chat (or on the dashboard, where the session
 * already proves who they are) and pastes it into Claude Code / Codex. Tokens
 * are stateless HMAC blobs signed with the same secret as the web session, but
 * they carry a rotation nonce that is stored in `settings` — so issuing a new
 * token, or revoking, instantly kills every token that came before.
 *
 * A token also carries its SCOPE, which is the whole authorisation story on
 * this surface:
 *   read — only read-level tools are listed or callable
 *   full — everything the user's role allows, without a Telegram confirmation
 *          button, because the MCP client (Claude Code, Codex) already asks the
 *          human before every tool call. Every call is still audited.
 */
import type { Env } from "../../env";
import type { Db } from "../../database/client";
import type { Json, UserIdentityRow, UserRow } from "../../database/types";
import { getSetting, setSetting } from "../../database/repos/settings";
import { findAnyIdentityByUser, getUserById } from "../../database/repos/users";
import { insertAudit } from "../../database/repos/audit";
import { constantTimeEquals } from "../../channels/telegram/webhook";
import { mintToken, randomNonce, verifyToken, webSecret, type McpPayload } from "../../web/session";

export type McpScope = "read" | "full";
export const MCP_SCOPES = ["read", "full"] as const;

export const MCP_ACCESS_KEY = "mcp.access";
export const MCP_DEFAULT_TTL_DAYS = 90;
const MAX_TTL_DAYS = 365;

export function isMcpScope(value: unknown): value is McpScope {
  return value === "read" || value === "full";
}

/** Shape stored in `settings`; the index signature is what makes it a `Json`. */
export interface McpAccessState {
  [key: string]: Json | undefined;
  nonce?: string;
  scope?: McpScope;
  /** epoch seconds */
  issued_at?: number;
  expires_at?: number;
  /** Free-text note for the human ("laptop", "codex") — never used for auth. */
  label?: string | null;
}

/** What the caller of an authenticated MCP request turns out to be. */
export interface McpSession {
  user: UserRow;
  identity: UserIdentityRow;
  /** Channel-native chat to reach this user on (file delivery, confirmations). */
  chatRef: string;
  scope: McpScope;
}

/** Public view of the current grant — never includes the token itself. */
export interface McpAccessSummary {
  active: boolean;
  scope: McpScope | null;
  issuedAt: string | null;
  expiresAt: string | null;
  label: string | null;
}

const toIso = (seconds: number | undefined): string | null =>
  typeof seconds === "number" && Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;

export async function describeMcpAccess(
  db: Db,
  userId: string,
  nowMs: number
): Promise<McpAccessSummary> {
  const state = (await getSetting<McpAccessState>(db, userId, MCP_ACCESS_KEY)) ?? {};
  const live = Boolean(state.nonce) && (state.expires_at ?? 0) * 1000 > nowMs;
  return {
    active: live,
    scope: live && isMcpScope(state.scope) ? state.scope : null,
    issuedAt: toIso(state.issued_at),
    expiresAt: toIso(state.expires_at),
    label: (state.label as string | null | undefined) ?? null,
  };
}

/**
 * Mint a token, replacing any previous one. Returned exactly once — nothing
 * stores it, so a lost token is re-issued rather than recovered.
 */
export async function issueMcpToken(
  env: Env,
  db: Db,
  user: UserRow,
  opts: { scope: McpScope; ttlDays?: number; label?: string | null },
  nowMs: number
): Promise<{ token: string; scope: McpScope; expiresAt: string }> {
  const ttlDays = Math.min(Math.max(Math.round(opts.ttlDays ?? MCP_DEFAULT_TTL_DAYS), 1), MAX_TTL_DAYS);
  const issuedAt = Math.floor(nowMs / 1000);
  const expiresAt = issuedAt + ttlDays * 24 * 3600;
  const nonce = randomNonce();

  // Store the nonce BEFORE handing out the token: a token whose nonce was never
  // persisted is unusable, which is the safer of the two failures.
  await setSetting(db, user.id, MCP_ACCESS_KEY, {
    nonce,
    scope: opts.scope,
    issued_at: issuedAt,
    expires_at: expiresAt,
    label: opts.label ?? null,
  } satisfies McpAccessState);

  const token = await mintToken(webSecret(env), "mcp", {
    u: user.id,
    e: expiresAt,
    i: issuedAt,
    n: nonce,
    s: opts.scope,
  } satisfies McpPayload);

  await insertAudit(db, {
    user_id: user.id,
    actor: "user",
    action: "mcp.token_issued",
    entity_kind: "user",
    entity_id: user.id,
    details: { scope: opts.scope, ttlDays },
  });
  return { token, scope: opts.scope, expiresAt: new Date(expiresAt * 1000).toISOString() };
}

/** Drop the stored nonce, which invalidates every outstanding token at once. */
export async function revokeMcpToken(db: Db, userId: string): Promise<boolean> {
  const state = (await getSetting<McpAccessState>(db, userId, MCP_ACCESS_KEY)) ?? {};
  if (!state.nonce) return false;
  await setSetting(db, userId, MCP_ACCESS_KEY, {} satisfies McpAccessState);
  await insertAudit(db, {
    user_id: userId,
    actor: "user",
    action: "mcp.token_revoked",
    entity_kind: "user",
    entity_id: userId,
  });
  return true;
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) return null;
  const value = header.slice(7).trim();
  return value.length > 0 ? value : null;
}

/**
 * Resolve an `Authorization: Bearer …` header to a live user, or null.
 *
 * Deliberately silent about *why* it failed: an unauthenticated caller learns
 * only that the token did not work.
 */
export async function authenticateMcp(
  request: Request,
  env: Env,
  db: Db,
  nowMs: number
): Promise<McpSession | null> {
  const token = bearerToken(request);
  if (!token) return null;

  const payload = await verifyToken<McpPayload>(webSecret(env), "mcp", token, nowMs);
  if (!payload || typeof payload.n !== "string" || !isMcpScope(payload.s)) return null;

  const state = (await getSetting<McpAccessState>(db, payload.u, MCP_ACCESS_KEY)) ?? {};
  // A re-issue or a revoke rotates the nonce, so older tokens stop verifying.
  if (!state.nonce || !constantTimeEquals(state.nonce, payload.n)) return null;

  const user = await getUserById(db, payload.u);
  // Revoking access in Postgres must lock the token out on its next call.
  if (!user || !user.is_allowed) return null;

  const identity = await findAnyIdentityByUser(db, user.id);
  if (!identity) return null;

  return {
    user,
    identity,
    chatRef: identity.chat_ref ?? identity.external_id,
    // The stored scope wins: narrowing a grant must take effect without asking
    // the holder to swap tokens.
    scope: isMcpScope(state.scope) ? state.scope : payload.s,
  };
}
