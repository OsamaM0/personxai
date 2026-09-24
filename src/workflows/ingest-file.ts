/**
 * File ingestion pipeline: dedup → vault forward → metadata row → project
 * suggestion buttons → background extraction/chunking/embeddings.
 */
import { z } from "zod";
import type { AgentContext } from "../agent/context";
import { registerCallbackKind } from "../agent/callback-registry";
import { createCallbackToken, encodeCallbackData } from "../agent/confirmations";
import type { IncomingMessage, MediaRef } from "../channels/types";
import {
  findFileByUniqueId,
  getFileById,
  insertFile,
  insertFileChunks,
  setExtraction,
  tagFile,
  updateFile,
} from "../database/repos/files";
import { findProject, listProjects } from "../database/repos/projects";
import { insertAudit } from "../database/repos/audit";
import type { FileRow } from "../database/types";
import { t } from "../i18n";
import { classifyJson } from "../services/llm/classify";
import { embedText } from "../services/llm/embeddings";
import { chunkForEmbedding } from "../services/media/chunk";
import { extractText, isExtractable } from "../services/media/extract";
import { fetchMediaBytes, MAX_FETCH_BYTES } from "../services/media/fetch";
import {
  chooseVault,
  ensureDefaultVault,
  forwardToVault,
  moveVaultMessage,
  uploadToVault,
  type VaultRef,
} from "../services/storage/vault";
import { topTagNames } from "../database/repos/tags";
import type { VaultChannelRow } from "../database/types";
import { formatFileSize, normalizeTags, sanitizeFileName, truncate } from "../utils/text";
import { log, formatError } from "../utils/logger";

const MAX_EMBEDDED_CHUNKS = 40; // Workers AI neuron budget guard

interface FileCallbackPayload {
  fileId: string;
  projectId: string | null;
  projectName: string | null;
  tags: string[];
  /** Alternative vault channels offered as "move" buttons (index → chat id). */
  channels?: { chatId: string; title: string }[];
}

registerCallbackKind("file", async (ctx, payload, verb, messageId) => {
  const { fileId, projectId, projectName, tags } = payload as FileCallbackPayload;
  const file = await getFileById(ctx.db, ctx.user.id, fileId);
  const finish = async (text: string) => {
    if (messageId) {
      await ctx.out.editText(ctx.chatRef, messageId, text, { removeButtons: true }).catch(() => {});
    } else {
      await ctx.out.sendText(ctx.chatRef, text);
    }
  };
  if (!file) {
    await finish(t(ctx.locale, "confirm_expired"));
    return;
  }
  if (verb === "p" && projectId) {
    await updateFile(ctx.db, ctx.user.id, file.id, { project_id: projectId });
    if (tags.length > 0) await tagFile(ctx.db, ctx.user.id, file.id, tags).catch(() => {});
    await insertAudit(ctx.db, {
      user_id: ctx.user.id,
      actor: "user",
      action: "file.assign_project",
      entity_kind: "file",
      entity_id: file.id,
    });
    await finish(t(ctx.locale, "file_assigned", { name: file.file_name, project: projectName ?? "?" }));
    return;
  }
  if (verb === "x") {
    await updateFile(ctx.db, ctx.user.id, file.id, { deleted_at: new Date().toISOString() });
    await finish(t(ctx.locale, "file_ignored"));
    return;
  }
  if (verb.startsWith("c")) {
    const target = (payload as FileCallbackPayload).channels?.[Number.parseInt(verb.slice(1), 10)];
    if (target) {
      const moved = await moveVaultMessage(ctx.env, file, target.chatId);
      if (moved) {
        await updateFile(ctx.db, ctx.user.id, file.id, { vault_chat_id: moved.vaultChatId, vault_message_id: moved.vaultMessageId });
        if (tags.length > 0) await tagFile(ctx.db, ctx.user.id, file.id, tags).catch(() => {});
        await insertAudit(ctx.db, { user_id: ctx.user.id, actor: "user", action: "file.move_channel", entity_kind: "file", entity_id: file.id, details: { to: target.title } });
        await finish(t(ctx.locale, "detail_moved", { channel: target.title }));
        return;
      }
    }
    await finish(t(ctx.locale, "error_generic"));
    return;
  }
  // verb "i" — keep unassigned
  if (tags.length > 0) await tagFile(ctx.db, ctx.user.id, file.id, tags).catch(() => {});
  await finish(t(ctx.locale, "file_kept", { name: file.file_name }));
});

const suggestionSchema = z.object({
  projectName: z.string().nullable(),
  /** Title of the vault channel this file belongs in (from the provided list), or null. */
  channel: z.string().nullable().optional(),
  tags: z.array(z.string()).max(5),
  confidence: z.number().min(0).max(1),
  /** Confidence that `channel` is right; below 0.6 the user is asked. */
  channelConfidence: z.number().min(0).max(1).optional(),
});

type Suggestion = z.infer<typeof suggestionSchema>;

/**
 * One cheap classifier call decides project + channel + tags. It runs BEFORE
 * the forward when several channels exist so the file lands in the right one.
 */
async function suggestFiling(
  ctx: AgentContext,
  file: { name: string; mime: string | null; caption: string | null },
  channels: VaultChannelRow[]
): Promise<Suggestion | null> {
  const [projects, tagsInUse] = await Promise.all([
    listProjects(ctx.db, ctx.user.id, { limit: 15 }).catch(() => []),
    topTagNames(ctx.db, ctx.user.id, 25).catch(() => [] as string[]),
  ]);
  if (projects.length === 0 && channels.length <= 1 && tagsInUse.length === 0) return null;
  const channelList = channels
    .map((c) => `- ${c.title ?? c.chat_id}${c.category ? ` [${c.category}]` : ""}${c.tags.length ? ` tags: ${c.tags.join(", ")}` : ""}${c.is_default ? " (default)" : ""}`)
    .join("\n");
  return classifyJson({
    schema: suggestionSchema,
    system:
      "Decide where a newly received file belongs in the user's personal system. projectName ONLY from the provided list (or null). channel ONLY from the provided channel titles (or null) — pick by category/tag fit; the default is fine for anything general. Suggest up to 3 short lowercase tags, reusing the user's existing tags when they fit. Report confidence for the project and channelConfidence for the channel.",
    prompt: `File: ${file.name}\nType: ${file.mime ?? "?"}\nCaption: ${file.caption ?? "(none)"}\n\nProjects: ${projects.map((p) => p.name).join(", ") || "(none)"}\n\nChannels:\n${channelList || "(one default channel)"}\n\nTags in use: ${tagsInUse.join(", ") || "(none yet)"}`,
    cfg: ctx.config.llm.classifier,
    env: ctx.env,
  });
}

export async function ingestFile(
  ctx: AgentContext,
  msg: IncomingMessage,
  media: MediaRef,
  opts: { silent?: boolean } = {}
): Promise<FileRow | null> {
  const uniqueId = typeof media.ref["file_unique_id"] === "string" ? media.ref["file_unique_id"] : null;
  if (uniqueId) {
    const existing = await findFileByUniqueId(ctx.db, ctx.user.id, uniqueId);
    if (existing && !existing.deleted_at) {
      if (!opts.silent) {
        await ctx.out.sendText(ctx.chatRef, t(ctx.locale, "file_duplicate", { name: existing.file_name }));
      }
      return existing;
    }
  }

  const originMessageId =
    typeof media.ref["origin_message_id"] === "string"
      ? media.ref["origin_message_id"]
      : msg.externalMessageId;

  // Routing: with several vault channels, ask the classifier where this file
  // belongs before forwarding, so most files land in the right channel at once.
  const channels = await ensureDefaultVault(ctx.env, ctx.db, ctx.user.id).catch(() => [] as VaultChannelRow[]);
  const enabled = channels.filter((c) => c.enabled);
  let suggestion: Suggestion | null = null;
  if (!opts.silent || enabled.length > 1) {
    suggestion = await suggestFiling(ctx, { name: media.fileName, mime: media.mimeType || null, caption: media.caption ?? null }, enabled).catch(() => null);
  }
  const wanted = suggestion?.channel && (suggestion.channelConfidence ?? 0) >= 0.6
    ? enabled.find((c) => (c.title ?? "").toLowerCase() === suggestion!.channel!.toLowerCase() || (c.category ?? "").toLowerCase() === suggestion!.channel!.toLowerCase())
    : undefined;
  const target = wanted ?? chooseVault(enabled, { tags: suggestion?.tags });
  const vaultTarget = target?.chat_id ?? ctx.env.VAULT_CHANNEL_ID;
  let vault: VaultRef | null = null;
  let relayedFileId: string | null = null;
  if (media.channel === "telegram") {
    vault = originMessageId
      ? await forwardToVault(ctx.env, msg.externalChatId, originMessageId, vaultTarget)
      : null;
  } else {
    // A message from another channel cannot be forwarded into a Telegram
    // channel, so the bytes are relayed instead (bounded by what the source
    // API lets us download). The vault stays Telegram-backed either way.
    const bytes = await fetchMediaBytes(ctx.env, media);
    if ("error" in bytes) {
      log("warn", "vault_relay_skipped", { channel: media.channel, reason: bytes.error });
    } else {
      const uploaded = await uploadToVault(
        ctx.env,
        sanitizeFileName(media.fileName),
        bytes.data,
        bytes.mime || media.mimeType || "application/octet-stream",
        vaultTarget
      );
      if (uploaded) {
        vault = uploaded;
        relayedFileId = uploaded.fileId ?? null;
      }
    }
  }

  const file = await insertFile(ctx.db, {
    user_id: ctx.user.id,
    file_name: sanitizeFileName(media.fileName),
    caption: media.caption ?? null,
    mime_type: media.mimeType || null,
    file_size: media.fileSize ?? null,
    media_kind: media.kind,
    tg_file_id: relayedFileId ?? (typeof media.ref["file_id"] === "string" ? media.ref["file_id"] : null),
    tg_file_unique_id: uniqueId,
    vault_chat_id: vault?.vaultChatId ?? null,
    vault_message_id: vault?.vaultMessageId ?? null,
    origin_chat_id: msg.externalChatId,
    origin_message_id: originMessageId ?? null,
    source: "telegram",
    tags: normalizeTags(suggestion?.tags ?? []),
  });
  if (suggestion?.tags?.length) {
    ctx.waitUntil(tagFile(ctx.db, ctx.user.id, file.id, normalizeTags(suggestion.tags)).catch(() => {}));
  }
  await insertAudit(ctx.db, {
    user_id: ctx.user.id,
    actor: "system",
    action: "file.ingest",
    entity_kind: "file",
    entity_id: file.id,
    details: { vault: !!vault },
  });

  ctx.waitUntil(runExtraction(ctx, file, media));
  if (!opts.silent) {
    await suggestOrganization(ctx, file, suggestion, enabled, target ?? null);
  }
  return file;
}

async function suggestOrganization(
  ctx: AgentContext,
  file: FileRow,
  suggestion: Suggestion | null,
  channels: VaultChannelRow[],
  storedIn: VaultChannelRow | null
): Promise<void> {
  const sizeNote = file.file_size ? ` (${formatFileSize(file.file_size)})` : "";
  const matched = suggestion?.projectName
    ? await findProject(ctx.db, ctx.user.id, suggestion.projectName).catch(() => null)
    : null;
  const tags = normalizeTags(suggestion?.tags ?? []);
  const tagNote = tags.length > 0 ? ` · ${tags.map((x) => "#" + x).join(" ")}` : "";
  const name = file.file_name + sizeNote + tagNote;
  const multi = channels.length > 1;
  const channelUnsure = multi && (suggestion?.channelConfidence ?? 0) < 0.6;
  const projectOk = !!matched && (suggestion?.confidence ?? 0) >= 0.3;

  // Nothing to ask: say where it went and stop.
  if (!projectOk && !channelUnsure) {
    await ctx.out.sendText(
      ctx.chatRef,
      storedIn && multi
        ? t(ctx.locale, "file_saved_to", { channel: storedIn.title ?? storedIn.chat_id, name })
        : t(ctx.locale, "file_saved", { name })
    );
    return;
  }

  // Otherwise one message with the plausible destinations as buttons.
  const others = multi ? channels.filter((c) => c.chat_id !== storedIn?.chat_id).slice(0, 3) : [];
  const token = createCallbackToken<FileCallbackPayload>(
    ctx.do,
    "file",
    {
      fileId: file.id,
      projectId: matched?.id ?? null,
      projectName: matched?.name ?? null,
      tags,
      channels: others.map((c) => ({ chatId: c.chat_id, title: c.title ?? c.category ?? c.chat_id })),
    },
    ctx.now.getTime()
  );
  const rows: { label: string; data: string }[][] = [];
  if (projectOk && matched) {
    rows.push([{ label: t(ctx.locale, "btn_save_project", { project: truncate(matched.name, 20) }), data: encodeCallbackData("file", token, "p") }]);
  }
  if (channelUnsure && others.length > 0) {
    rows.push(others.map((c, i) => ({ label: t(ctx.locale, "btn_move", { channel: truncate(c.title ?? c.category ?? "?", 14) }), data: encodeCallbackData("file", token, `c${i}`) })));
  }
  rows.push([
    { label: t(ctx.locale, "btn_keep_inbox"), data: encodeCallbackData("file", token, "i") },
    { label: t(ctx.locale, "btn_ignore"), data: encodeCallbackData("file", token, "x") },
  ]);
  const text = projectOk && matched && !channelUnsure
    ? t(ctx.locale, "file_suggestion", { name, project: matched.name })
    : (storedIn && multi ? t(ctx.locale, "file_saved_to", { channel: storedIn.title ?? storedIn.chat_id, name }) + "\n" : "") +
      t(ctx.locale, "file_where", { name: matched ? `${file.file_name} → ${matched.name}?` : file.file_name });
  await ctx.out.sendButtons(ctx.chatRef, text, rows);
}

async function runExtraction(ctx: AgentContext, file: FileRow, media: MediaRef): Promise<void> {
  try {
    if (!isExtractable(file.mime_type ?? undefined, file.file_name)) {
      await setExtraction(ctx.db, ctx.user.id, file.id, "skipped");
      return;
    }
    if ((file.file_size ?? 0) > MAX_FETCH_BYTES) {
      // Bot API cannot download >20MB — vault storage still works, extraction can't.
      await setExtraction(ctx.db, ctx.user.id, file.id, "skipped");
      return;
    }
    const bytes = await fetchMediaBytes(ctx.env, media);
    if ("error" in bytes) {
      await setExtraction(ctx.db, ctx.user.id, file.id, bytes.error === "too_large" ? "skipped" : "failed");
      return;
    }
    const result = await extractText(ctx.env, bytes.data, {
      mime: file.mime_type ?? bytes.mime,
      fileName: file.file_name,
      maxChars: ctx.config.limits.maxExtractChars,
    });
    if (!result) {
      await setExtraction(ctx.db, ctx.user.id, file.id, "failed");
      return;
    }
    await setExtraction(ctx.db, ctx.user.id, file.id, "done", result.text);

    const chunks = chunkForEmbedding(result.text).slice(0, MAX_EMBEDDED_CHUNKS);
    const rows: { file_id: string; user_id: string; chunk_index: number; content: string; embedding: string | null }[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (!chunk) continue;
      const vec = await embedText(chunk, ctx.config.embeddings, ctx.env);
      rows.push({
        file_id: file.id,
        user_id: ctx.user.id,
        chunk_index: i,
        content: chunk,
        embedding: vec ? JSON.stringify(vec) : null,
      });
    }
    await insertFileChunks(ctx.db, rows);

    const headline = `${file.file_name}\n${file.caption ?? ""}\n${chunks[0] ?? ""}`.trim();
    const vec = await embedText(headline, ctx.config.embeddings, ctx.env);
    if (vec) {
      await updateFile(ctx.db, ctx.user.id, file.id, { embedding: JSON.stringify(vec) }).catch(() => {});
    }
    log("info", "file_extracted", { file: file.id, method: result.method, chunks: rows.length });
  } catch (err) {
    log("warn", "file_extraction_failed", { file: file.id, error: formatError(err) });
    await setExtraction(ctx.db, ctx.user.id, file.id, "failed").catch(() => {});
  }
}
