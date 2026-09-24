/**
 * Turn orchestration: resolve user → gate → route → handle → persist → reply.
 * Runs inside the per-user Durable Object (serialized), channel-agnostic.
 */
import type { ModelMessage } from "ai";
import type { Env } from "../env";
import type { AppConfig } from "../config";
import type { IncomingMessage } from "../channels/types";
import { getAdapter } from "../channels/registry";
import type { Db } from "../database/client";
import {
  addIdentity,
  createUserWithIdentity,
  findOwnerUser,
  findUserByIdentity,
  getUserById,
  touchLastSeen,
  updateIdentity,
  type ResolvedIdentity,
} from "../database/repos/users";
import { isOwnerIdentity } from "../config";
import { ensureActiveConversation } from "../database/repos/conversations";
import { insertMessage, recentMessages, setMessageEmbedding } from "../database/repos/messages";
import { insertRun, insertToolCalls } from "../database/repos/runs";
import { insertAudit } from "../database/repos/audit";
import { resolveLocale, t } from "../i18n";
import { takeToken, type BucketState } from "../security/ratelimit";
import { chatModel } from "../services/llm/provider";
import { embedText } from "../services/llm/embeddings";
import { transcribeAudio } from "../services/llm/stt";
import { fetchMediaBytes } from "../services/media/fetch";
import { log, formatError } from "../utils/logger";
import { truncate } from "../utils/text";
import { buildToolSet } from "../tools";
import { ToolCallCollector } from "../tools/registry";
import { selectTopics } from "../tools/topics";
import { getCallbackHandler } from "./callback-registry";
import type { AgentContext } from "./context";
import { consumeCallbackToken, type DecodedCallback } from "./confirmations";
import { kvGet, kvSet, type SqlExecutor } from "./do-schema";
import { runLlmTurn } from "./loop";
import { handleCommand } from "./commands";
import { routeMessage } from "./router";
import { ingestFile } from "../workflows/ingest-file";
import { ingestUrl } from "../workflows/ingest-url";
import { runDailyBrief, runHeartbeat } from "../workflows/daily-brief";
import { findLinkByUrl } from "../database/repos/links";
import { findFileByOriginMessage, findFileByVaultMessage } from "../database/repos/files";
import { findVaultByChatId } from "../database/repos/vaults";
import { connectVaultChannel } from "../services/storage/vault";
import { createCallbackToken, encodeCallbackData } from "./confirmations";
import { registerCallbackKind } from "./callback-registry";
import { showDetail } from "./details";
import { listUserFacts, matchMemories, touchMemories } from "../database/repos/memories";
import { getActiveSystemPrompt, listSkills } from "../database/repos/skills";
import { connectUserMcpServers, mcpToolSet, type McpHost } from "../mcp/client";
import { gateMcpTools } from "../mcp/permissions";
import { matchMessages } from "../database/repos/search";
import { countPendingInbox } from "../database/repos/inbox";
import { countOverdueTasks } from "../database/repos/tasks";
import { topTagNames } from "../database/repos/tags";
import { listVaultChannels } from "../database/repos/vaults";
import { AUTONOMY_LABELS, buildLiveContext } from "./prompts/live-context";
import { SYSTEM_CORE } from "./prompts/system-core";
import { topicFragments } from "./prompts/topic-fragments";

export interface OrchestratorDeps {
  env: Env;
  config: AppConfig;
  db: Db;
  sqlExec: SqlExecutor;
  waitUntil: (p: Promise<unknown>) => void;
  /** The Durable Object, which owns the MCP client manager. */
  mcpHost?: McpHost;
}

export { registerCallbackKind } from "./callback-registry";

const NEWLINE = String.fromCharCode(10);

export async function processIncoming(deps: OrchestratorDeps, msg: IncomingMessage): Promise<void> {
  const { env, config, db, sqlExec } = deps;
  const adapter = getAdapter(msg.channel);
  if (!adapter) {
    log("warn", "unknown_channel", { channel: msg.channel });
    return;
  }
  const out = adapter.outbound(env, msg);
  const chatRef = msg.externalChatId;

  // ── Resolve or bootstrap the user ──────────────────────────────────────────
  let resolved = await resolveCachedIdentity(deps, msg);
  if (!resolved) {
    const existingOwner = isOwnerIdentity(config, msg.channel, msg.externalUserId)
      ? await findOwnerUser(db)
      : null;
    if (existingOwner) {
      // The owner already exists on another channel: link this identity to the
      // same account rather than provisioning a second brain.
      const identity = await addIdentity(db, existingOwner.id, {
        channel: msg.channel,
        externalId: msg.externalUserId,
        chatRef,
        username: msg.username,
      });
      resolved = { user: existingOwner, identity };
      const locale = resolveLocale(existingOwner.language);
      await out.sendText(chatRef, t(locale, "start_channel_linked"));
      await insertAudit(db, {
        user_id: existingOwner.id,
        actor: "system",
        action: "identity_linked",
        entity_kind: "user",
        entity_id: existingOwner.id,
        details: { channel: msg.channel },
      });
    } else if (isOwnerIdentity(config, msg.channel, msg.externalUserId)) {
      resolved = await createUserWithIdentity(db, {
        channel: msg.channel,
        externalId: msg.externalUserId,
        chatRef,
        username: msg.username,
        displayName: msg.displayName,
        role: "owner",
        isAllowed: true,
        timezone: config.defaults.timezone,
        language: msg.languageHint?.startsWith("ar") ? "ar-EG" : config.defaults.language,
      });
      const locale = resolveLocale(resolved.user.language);
      await out.sendText(chatRef, t(locale, "start_owner_bootstrap"));
      await insertAudit(db, {
        user_id: resolved.user.id,
        actor: "system",
        action: "owner_bootstrap",
        entity_kind: "user",
        entity_id: resolved.user.id,
      });
    } else {
      await rejectUnknown(deps, out, msg);
      return;
    }
  }
  const { user, identity } = resolved;

  if (!user.is_allowed) {
    await rejectUnknown(deps, out, msg, user.id);
    return;
  }

  const locale = resolveLocale(user.language);

  // ── Rate limit ─────────────────────────────────────────────────────────────
  const now = Date.now();
  const rateRaw = kvGet(sqlExec, "rate");
  const rateState: BucketState | null = rateRaw ? (JSON.parse(rateRaw) as BucketState) : null;
  const rate = takeToken(rateState, now, {
    capacity: config.limits.rateLimitPerMinute,
    refillPerMinute: config.limits.rateLimitPerMinute,
  });
  kvSet(sqlExec, "rate", JSON.stringify(rate.state));
  if (!rate.allowed) {
    const lastNotice = Number(kvGet(sqlExec, "rate_notice") ?? 0);
    if (now - lastNotice > 60_000) {
      kvSet(sqlExec, "rate_notice", String(now));
      await out.sendText(chatRef, t(locale, "rate_limited"));
    }
    return;
  }

  // Housekeeping (off the critical path)
  deps.waitUntil(touchLastSeen(db, user.id).catch(() => {}));
  if (identity.chat_ref !== chatRef || (msg.username && identity.username !== msg.username)) {
    deps.waitUntil(
      updateIdentity(db, identity.id, { chat_ref: chatRef, username: msg.username }).catch(() => {})
    );
  }

  // ── Build context + route ──────────────────────────────────────────────────
  const conversation = await ensureActiveConversation(
    db,
    user.id,
    t(locale, "conversation_default_title")
  );
  const ctx: AgentContext = {
    env,
    config,
    db,
    user,
    identity,
    conversation,
    locale,
    out,
    chatRef,
    channel: msg.channel,
    do: sqlExec,
    now: new Date(now),
    waitUntil: deps.waitUntil,
    mcpHost: deps.mcpHost,
  };

  const route = routeMessage(msg);

  try {
    switch (route.type) {
      case "ignore":
        return;
      case "callback_invalid":
        await out.answerCallback(route.callbackId);
        return;
      case "callback":
        await handleCallback(ctx, route.decoded, route.callbackId, route.messageId);
        return;
      case "command":
        await handleCommand(ctx, route.name, route.args);
        return;
      case "voice":
        await handleVoice(ctx, msg);
        return;
      case "url":
        await handleUrl(ctx, msg, route.url);
        return;
      case "media":
        await handleMedia(ctx, msg, route.hasCaption);
        return;
      case "channel_forward":
        await handleChannelForward(ctx, msg, route);
        return;
      case "llm":
        await runConversationTurn(ctx, await withReplyContext(ctx, msg), {
          incoming: msg,
          trigger: "message",
        });
        return;
    }
  } catch (err) {
    log("error", "turn_failed", { error: formatError(err), route: route.type });
    await out.sendText(chatRef, t(locale, "error_generic")).catch(() => {});
  }
}

async function resolveCachedIdentity(
  deps: OrchestratorDeps,
  msg: IncomingMessage
): Promise<ResolvedIdentity | null> {
  // The DO is per-identity, so a single cached pair is enough; fall through to
  // the DB when the cache is cold. Supabase remains the source of truth.
  return findUserByIdentity(deps.db, msg.channel, msg.externalUserId);
}

async function rejectUnknown(
  deps: OrchestratorDeps,
  out: AgentContext["out"],
  msg: IncomingMessage,
  knownUserId?: string
): Promise<void> {
  const noticeKey = `blocked:${msg.channel}:${msg.externalUserId}`;
  const already = kvGet(deps.sqlExec, noticeKey);
  if (!already) {
    kvSet(deps.sqlExec, noticeKey, String(Date.now()));
    const locale = resolveLocale(msg.languageHint);
    await out.sendText(msg.externalChatId, t(locale, "not_allowed")).catch(() => {});
    await insertAudit(deps.db, {
      user_id: knownUserId ?? null,
      actor: "system",
      action: "access_denied",
      details: { channel: msg.channel, external_id: msg.externalUserId },
      status: "denied",
    });
  }
}

/**
 * When the user replies to a message that carried a file, name that file for the
 * model so "summarize this" resolves without guessing.
 */
async function withReplyContext(ctx: AgentContext, msg: IncomingMessage): Promise<string> {
  const text = msg.text ?? "";
  if (!msg.replyToExternalMessageId) return text;
  const file = await findFileByOriginMessage(ctx.db, ctx.user.id, msg.replyToExternalMessageId).catch(
    () => null
  );
  if (file) {
    return `${text}${NEWLINE}${NEWLINE}[The user is replying to a stored file: "${file.file_name}" (id ${file.id}). Use get_file_text with that id when they ask about its contents.]`;
  }
  if (msg.replyToText) {
    return `${text}${NEWLINE}${NEWLINE}[Replying to an earlier message: "${msg.replyToText.slice(0, 300)}"]`;
  }
  return text;
}

async function handleCallback(
  ctx: AgentContext,
  decoded: DecodedCallback,
  callbackId: string,
  messageId?: string
): Promise<void> {
  const pending = consumeCallbackToken(ctx.do, decoded.token, ctx.now.getTime());
  if (!pending && (decoded.kind === "lst" || decoded.kind === "ent")) {
    // A list/detail token is consumed by the first tap; a double-tap or an old
    // page must not wipe the message — just tell the user to refresh.
    await ctx.out.answerCallback(callbackId, t(ctx.locale, "list_stale"));
    return;
  }
  await ctx.out.answerCallback(callbackId);
  if (!pending) {
    if (messageId) {
      await ctx.out
        .editText(ctx.chatRef, messageId, t(ctx.locale, "confirm_expired"), { removeButtons: true })
        .catch(() => {});
    } else {
      await ctx.out.sendText(ctx.chatRef, t(ctx.locale, "confirm_expired"));
    }
    return;
  }
  const handler = getCallbackHandler(pending.kind);
  if (!handler) {
    log("warn", "callback_kind_unhandled", { kind: pending.kind });
    await ctx.out.sendText(ctx.chatRef, t(ctx.locale, "confirm_expired"));
    return;
  }
  await handler(ctx, pending.payload, decoded.verb, messageId);
}

async function handleVoice(ctx: AgentContext, msg: IncomingMessage): Promise<void> {
  const voice = msg.media.find((m) => m.kind === "voice") ?? msg.media[0];
  if (!voice) return;
  await ctx.out.chatAction(ctx.chatRef, "typing");
  const bytes = await fetchMediaBytes(ctx.env, voice);
  if ("error" in bytes) {
    await ctx.out.sendText(ctx.chatRef, t(ctx.locale, "voice_unsupported_yet"));
    return;
  }
  const transcript = await transcribeAudio(bytes.data, {
    mime: bytes.mime,
    cfg: ctx.config.stt,
    env: ctx.env,
  });
  if (!transcript || transcript.trim().length === 0) {
    await ctx.out.sendText(ctx.chatRef, t(ctx.locale, "voice_unsupported_yet"));
    return;
  }
  await runConversationTurn(ctx, transcript.trim(), { incoming: msg, trigger: "message" });
}

/**
 * A bare URL: fetch + summarize + bookmark deterministically, then offer the
 * usual project filing. No main-model turn is spent on the capture itself.
 */
async function handleUrl(ctx: AgentContext, msg: IncomingMessage, url: string): Promise<void> {
  void msg;
  const existing = await findLinkByUrl(ctx.db, ctx.user.id, url).catch(() => null);
  if (existing && !existing.deleted_at) {
    await ctx.out.sendText(
      ctx.chatRef,
      t(ctx.locale, "link_saved", { title: existing.title ?? existing.url })
    );
    return;
  }
  await ctx.out.chatAction(ctx.chatRef, "typing").catch(() => {});
  const saved = await ingestUrl(ctx, url);
  await ctx.out.sendText(
    ctx.chatRef,
    saved
      ? t(ctx.locale, "link_saved", { title: saved.title ?? saved.url })
      : t(ctx.locale, "error_generic")
  );
}

async function handleMedia(ctx: AgentContext, msg: IncomingMessage, hasCaption: boolean): Promise<void> {
  // Every attachment goes to the vault + files index. Files carry their own
  // suggestion buttons, so only the first one prompts; the rest ingest quietly.
  await ctx.out.chatAction(ctx.chatRef, "typing").catch(() => {});
  const ingested: string[] = [];
  for (let i = 0; i < msg.media.length; i++) {
    const media = msg.media[i];
    if (!media) continue;
    const file = await ingestFile(ctx, msg, media, { silent: hasCaption || i > 0 });
    if (file) ingested.push(file.file_name);
  }

  if (hasCaption) {
    // The caption is an instruction about the file(s) just stored.
    const context =
      ingested.length > 0
        ? `${msg.text ?? ""}

[Files just received and stored: ${ingested.join(", ")}. Find them with find_files.]`
        : (msg.text ?? "");
    await runConversationTurn(ctx, context, { incoming: msg, trigger: "message" });
    return;
  }
  if (ingested.length > 1) {
    await ctx.out.sendText(ctx.chatRef, t(ctx.locale, "file_saved", { name: ingested.join(", ") }));
  }
}

interface VaultConnectPayload {
  chatId: string;
  title: string;
}

registerCallbackKind("vault", async (ctx, payload, verb, messageId) => {
  const { chatId, title } = payload as VaultConnectPayload;
  const finish = async (text: string) => {
    if (messageId) await ctx.out.editText(ctx.chatRef, messageId, text, { removeButtons: true }).catch(() => {});
    else await ctx.out.sendText(ctx.chatRef, text);
  };
  if (verb !== "y") {
    await finish(t(ctx.locale, "confirm_cancelled"));
    return;
  }
  const result = await connectVaultChannel(ctx.env, ctx.db, ctx.user.id, chatId, { title });
  if ("error" in result) {
    await finish(t(ctx.locale, "vault_connect_failed", { reason: result.error }));
    return;
  }
  await insertAudit(ctx.db, {
    user_id: ctx.user.id,
    actor: "user",
    action: "vault.connect",
    details: { chat_id: chatId, title },
  });
  await finish(
    t(ctx.locale, "vault_connected", {
      title: result.row.title ?? chatId,
      category: result.row.category ?? "—",
      tags: result.row.tags.map((x) => "#" + x).join(" ") || "—",
    }) +
      NEWLINE +
      t(ctx.locale, "vault_description_hint")
  );
});

/**
 * A message forwarded from a channel: if it is one of the user's vault channels,
 * open the stored file's card (or ingest it if unknown); otherwise offer to
 * connect the channel as a new vault.
 */
async function handleChannelForward(
  ctx: AgentContext,
  msg: IncomingMessage,
  route: { chatId: string; title?: string; messageId?: string }
): Promise<void> {
  const known = await findVaultByChatId(ctx.db, ctx.user.id, route.chatId).catch(() => null);
  if (known) {
    if (route.messageId) {
      const stored = await findFileByVaultMessage(ctx.db, ctx.user.id, route.chatId, route.messageId).catch(() => null);
      if (stored) {
        await showDetail(ctx, "file", stored.id, null);
        return;
      }
    }
    if (msg.media.length > 0) {
      await handleMedia(ctx, msg, !!msg.text?.trim());
      return;
    }
    if (msg.text?.trim()) {
      await runConversationTurn(ctx, msg.text, { incoming: msg, trigger: "message" });
    }
    return;
  }
  const title = route.title ?? route.chatId;
  const token = createCallbackToken<VaultConnectPayload>(ctx.do, "vault", { chatId: route.chatId, title }, ctx.now.getTime());
  await ctx.out.sendButtons(ctx.chatRef, t(ctx.locale, "vault_connect_prompt", { title }), [
    [
      { label: t(ctx.locale, "btn_connect"), data: encodeCallbackData("vault", token, "y") },
      { label: t(ctx.locale, "btn_not_now"), data: encodeCallbackData("vault", token, "n") },
    ],
  ]);
  // Still keep any attachment: the user forwarded it to the assistant on purpose.
  if (msg.media.length > 0) await handleMedia(ctx, msg, !!msg.text?.trim());
}

/**
 * Assemble an AgentContext for a user with no inbound message. Scheduled
 * routines and the MCP server both enter the agent through here.
 */
export async function buildUserContext(
  deps: OrchestratorDeps,
  userId: string,
  overrides: { channel?: string; now?: Date } = {}
): Promise<AgentContext | null> {
  const { env, config, db, sqlExec } = deps;
  const user = await getUserById(db, userId);
  if (!user || !user.is_allowed) return null;

  const { data: identities } = await db
    .from("user_identities")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(1);
  const identity = identities?.[0];
  if (!identity?.chat_ref) return null;

  // Outbound stays the identity's real channel even when the turn started
  // somewhere else (a routine, an MCP client): that is where files and
  // confirmation buttons have to land. Only the recorded provenance changes.
  const adapter = getAdapter(identity.channel);
  if (!adapter) return null;

  const locale = resolveLocale(user.language);
  const conversation = await ensureActiveConversation(
    db,
    user.id,
    t(locale, "conversation_default_title")
  );
  return {
    env,
    config,
    db,
    user,
    identity,
    conversation,
    locale,
    out: adapter.outbound(env),
    chatRef: identity.chat_ref,
    channel: overrides.channel ?? identity.channel,
    do: sqlExec,
    now: overrides.now ?? new Date(),
    waitUntil: deps.waitUntil,
    mcpHost: deps.mcpHost,
  };
}

/**
 * Scheduled routine entry (natural-db pattern: the same agent, re-entered with a
 * system role).
 */
export async function runRoutine(
  deps: OrchestratorDeps,
  userId: string,
  templateId: string
): Promise<boolean> {
  const ctx = await buildUserContext(deps, userId);
  if (!ctx) return false;

  switch (templateId) {
    case "daily_brief":
      return runDailyBrief(ctx);
    case "heartbeat":
      return runHeartbeat(ctx);
    default:
      log("warn", "unknown_routine_template", { templateId });
      return false;
  }
}

/**
 * Surface a saved skill when the user's wording matches its triggers, so the
 * model knows to call run_skill instead of improvising the workflow.
 */
async function matchSkills(ctx: AgentContext, userText: string): Promise<string> {
  const skills = await listSkills(ctx.db, ctx.user.id, true).catch(() => []);
  if (skills.length === 0) return "";
  const haystack = userText.toLowerCase();
  const matched = skills.filter((skill) => {
    const triggers = (skill.triggers ?? {}) as { keywords?: string[]; commands?: string[] };
    const keywords = triggers.keywords ?? [];
    if (keywords.some((k) => k && haystack.includes(k.toLowerCase()))) return true;
    return haystack.includes(skill.name.toLowerCase());
  });
  if (matched.length === 0) return "";
  return [
    "Saved skills that match this request — call run_skill with the name to load full instructions:",
    ...matched.slice(0, 3).map((s) => "- " + s.name + (s.description ? ": " + s.description : "")),
  ].join(NEWLINE);
}

interface RetrievedContext {
  facts: { category: string; key: string; value: string }[];
  pending: { inbox?: number; overdueTasks?: number };
  block: string;
}

/**
 * Per-turn retrieval: KV facts and pending counters always; semantic recall of
 * past messages and long-term memories when the input is substantial enough to
 * embed. Every piece is best-effort — retrieval must never break a reply.
 */
async function retrieveContext(
  ctx: AgentContext,
  userText: string,
  historyRows: { content: string }[]
): Promise<RetrievedContext> {
  const [facts, inbox, overdue] = await Promise.all([
    listUserFacts(ctx.db, ctx.user.id).catch(() => []),
    countPendingInbox(ctx.db, ctx.user.id).catch(() => 0),
    countOverdueTasks(ctx.db, ctx.user.id).catch(() => 0),
  ]);

  const sections: string[] = [];
  if (userText.trim().length >= ctx.config.limits.minEmbedChars) {
    const embedding = await embedText(userText, ctx.config.embeddings, ctx.env).catch(() => null);
    if (embedding) {
      const recentContents = new Set(historyRows.map((m) => m.content));
      const [messages, memories] = await Promise.all([
        matchMessages(ctx.db, ctx.user.id, embedding, {
          conversationId: ctx.conversation.id,
          limit: 5,
        }).catch(() => []),
        matchMemories(ctx.db, ctx.user.id, embedding, { limit: 6 }).catch(() => []),
      ]);

      // High floor for conversation recall, and never echo what the window already holds.
      const relevantMessages = messages
        .filter((m) => m.similarity >= 0.7 && !recentContents.has(m.content))
        .slice(0, 3);
      if (relevantMessages.length > 0) {
        sections.push(
          ["Relevant excerpts from earlier in this conversation (stored context, not new input):"]
            .concat(relevantMessages.map((m) => "- " + m.role + ": " + truncate(m.content, 300)))
            .join(NEWLINE)
        );
      }

      const relevantMemories = memories.filter((m) => m.similarity >= 0.3).slice(0, 5);
      if (relevantMemories.length > 0) {
        ctx.waitUntil(touchMemories(ctx.db, relevantMemories.map((m) => m.id)).catch(() => {}));
        sections.push(
          ["Stored long-term memories that may be relevant:"]
            .concat(
              relevantMemories.map((m) => "- [" + m.memory_type + "] " + truncate(m.content, 300))
            )
            .join(NEWLINE)
        );
      }
    }
  }

  return {
    facts: facts.map((f) => ({ category: f.category, key: f.key, value: f.value })),
    pending: { inbox, overdueTasks: overdue },
    block: sections.join(NEWLINE + NEWLINE),
  };
}

/**
 * One assistant turn. Returns the reply text so callers that are not a chat
 * channel (the MCP server) can hand it back to whoever asked; `deliver: false`
 * keeps that reply out of the user's chat while still recording it in the
 * conversation, so history stays single-threaded across surfaces.
 */
export async function runConversationTurn(
  ctx: AgentContext,
  userText: string,
  opts: {
    incoming?: IncomingMessage;
    trigger: "message" | "schedule" | "daily_brief" | "heartbeat";
    deliver?: boolean;
  }
): Promise<string> {
  const started = Date.now();
  const deliver = opts.deliver !== false;
  if (deliver) await ctx.out.chatAction(ctx.chatRef, "typing").catch(() => {});

  const historyRows = await recentMessages(ctx.db, ctx.conversation.id, ctx.config.limits.historyWindow);
  const history: ModelMessage[] = historyRows
    .filter((r) => r.role === "user" || r.role === "assistant")
    .map((r) => ({ role: r.role as "user" | "assistant", content: r.content }));
  history.push({ role: "user", content: userText });

  const topics = selectTopics(userText);
  const collector = new ToolCallCollector(ctx.config.limits.toolBudgetPerTurn);
  let tools = buildToolSet(topics, ctx, collector);

  // MCP tools (if any servers are registered) go through the same gate.
  if (ctx.mcpHost) {
    const live = await connectUserMcpServers(ctx.mcpHost, ctx.db, ctx.user.id).catch(() => 0);
    if (live > 0) {
      tools = { ...tools, ...gateMcpTools(mcpToolSet(ctx.mcpHost), ctx, collector) };
    }
  }

  const [retrieved, personalization, skillHint, tagsInUse, vaultChannels] = await Promise.all([
    retrieveContext(ctx, userText, historyRows),
    getActiveSystemPrompt(ctx.db, ctx.user.id).catch(() => null),
    matchSkills(ctx, userText),
    topTagNames(ctx.db, ctx.user.id, 30).catch(() => [] as string[]),
    listVaultChannels(ctx.db, ctx.user.id, true).catch(() => []),
  ]);
  const fragments = topicFragments(topics);
  const system = [
    SYSTEM_CORE,
    buildLiveContext({
      user: ctx.user,
      conversation: ctx.conversation,
      autonomyLabel: AUTONOMY_LABELS[ctx.user.autonomy_level] ?? "",
      userFacts: retrieved.facts,
      pendingCounts: retrieved.pending,
      tagsInUse,
      vaultChannels: vaultChannels.map((v) => ({
        title: v.title ?? v.chat_id,
        category: v.category,
        tags: v.tags,
        isDefault: v.is_default,
      })),
    }),
    fragments,
    skillHint,
    retrieved.block,
    personalization
      ? "PERSONALIZATION (the user's own standing instructions; the base rules above still apply):" +
        NEWLINE +
        personalization.prompt_content
      : "",
  ]
    .filter((part) => part && part.length > 0)
    .join(NEWLINE + NEWLINE);

  const userRow = await insertMessage(ctx.db, {
    user_id: ctx.user.id,
    conversation_id: ctx.conversation.id,
    role: opts.trigger === "message" ? "user" : "system_routine_task",
    content: userText,
    channel: opts.incoming?.channel ?? null,
    external_message_id: opts.incoming?.externalMessageId ?? null,
    media:
      opts.incoming && opts.incoming.media.length > 0
        ? JSON.parse(JSON.stringify(opts.incoming.media))
        : null,
  });

  const result = await runLlmTurn({
    model: chatModel(ctx.config.llm.main, ctx.env),
    system,
    messages: history,
    tools,
    maxIterations: ctx.config.limits.maxIterations,
    timeoutMs: ctx.config.limits.llmTimeoutMs,
  });

  // An empty reply is fine when a tool already sent confirmation/suggestion
  // buttons — the buttons are the reply. Otherwise fall back to a generic error.
  const interactionSent = collector.rows.some(
    (r) => r.status === "awaiting_confirmation" || r.tool_name === "organize_inbox"
  );
  const replyText =
    result.text.trim().length > 0 ? result.text : interactionSent ? "" : t(ctx.locale, "error_generic");
  const sentId = replyText && deliver ? await ctx.out.sendText(ctx.chatRef, replyText) : undefined;

  const assistantRow = replyText
    ? await insertMessage(ctx.db, {
        user_id: ctx.user.id,
        conversation_id: ctx.conversation.id,
        role: "assistant",
        content: replyText,
        channel: ctx.channel,
        external_message_id: sentId ?? null,
        tokens_in: result.usage.promptTokens || null,
        tokens_out: result.usage.completionTokens || null,
      })
    : null;

  ctx.waitUntil(
    (async () => {
      const runId = await insertRun(ctx.db, {
        user_id: ctx.user.id,
        conversation_id: ctx.conversation.id,
        trigger: opts.trigger,
        model: ctx.config.llm.main.model,
        iterations: result.iterations,
        tool_call_count: result.toolCallCount,
        prompt_tokens: result.usage.promptTokens || null,
        completion_tokens: result.usage.completionTokens || null,
        status: result.error ? "error" : "ok",
        error: result.error ?? null,
        latency_ms: Date.now() - started,
      });
      if (collector.rows.length > 0) {
        await insertToolCalls(
          ctx.db,
          collector.rows.map((row) => ({ ...row, run_id: runId, user_id: ctx.user.id }))
        );
      }
    })().catch((e) => log("warn", "run_accounting_failed", { error: formatError(e) }))
  );

  // Embeddings are strictly best-effort and never block the turn.
  const minChars = ctx.config.limits.minEmbedChars;
  for (const row of [userRow, assistantRow]) {
    if (row && row.content.length >= minChars) {
      ctx.waitUntil(
        embedText(row.content, ctx.config.embeddings, ctx.env)
          .then((vec) => (vec ? setMessageEmbedding(ctx.db, row.id, vec) : undefined))
          .catch(() => {})
      );
    }
  }

  return replyText;
}
