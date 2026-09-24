/**
 * Telegram update → IncomingMessage normalization.
 *
 * Defensive hand-rolled parsing (openmemo style): malformed input NEVER
 * throws — it yields null. Media extraction is ported from
 * ref/TeleFileBot-CloudFlare-main/.../src/index.js extractFileInfo()
 * (fallback file names / mime types, largest photo, animated stickers skipped).
 */
import type { IncomingKind, IncomingMessage, MediaKind, MediaRef } from "../types";
import { extractUrls } from "../../utils/text";

type Rec = Record<string, unknown>;

const COMMAND_RE = /^[/](\w+)(@\w+)?([\s\S]*)/;

function isRecord(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Telegram ids arrive as numbers (sometimes > 2^31); normalize to string. */
function idString(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string" && v.length > 0) return v;
  return undefined;
}

/** {file_id, file_unique_id} pair, or null when either is missing. */
function fileRef(obj: Rec): { file_id: string; file_unique_id: string } | null {
  const fileId = asString(obj.file_id);
  const fileUniqueId = asString(obj.file_unique_id);
  if (!fileId || !fileUniqueId) return null;
  return { file_id: fileId, file_unique_id: fileUniqueId };
}

/** Bot API ≥6.6 uses `thumbnail`; older payloads used `thumb`. */
function thumbRef(obj: Rec): { file_id: string; file_unique_id: string } | undefined {
  const t = isRecord(obj.thumbnail) ? obj.thumbnail : isRecord(obj.thumb) ? obj.thumb : undefined;
  if (!t) return undefined;
  return fileRef(t) ?? undefined;
}

/**
 * Extract the (single) media attachment of a message as a MediaRef.
 * Ported from TeleFileBot extractFileInfo(); photo takes the LAST array
 * element (Telegram sorts sizes ascending), animated stickers are skipped.
 */
function extractMedia(msg: Rec): MediaRef | null {
  const ts = Date.now();
  const caption = asString(msg.caption);
  const mediaGroupId = idString(msg.media_group_id);

  const build = (kind: MediaKind, obj: Rec, fileName: string, mimeType: string): MediaRef | null => {
    const ref = fileRef(obj);
    if (!ref) return null;
    const media: MediaRef = { kind, fileName, mimeType, channel: "telegram", ref };
    const fileSize = asNumber(obj.file_size);
    if (fileSize !== undefined) media.fileSize = fileSize;
    if (caption !== undefined) media.caption = caption;
    if (mediaGroupId !== undefined) media.mediaGroupId = mediaGroupId;
    const thumb = thumbRef(obj);
    if (thumb) media.thumbnailRef = thumb;
    return media;
  };

  if (isRecord(msg.document)) {
    const d = msg.document;
    return build("document", d, asString(d.file_name) ?? `document_${ts}`, asString(d.mime_type) ?? "");
  }
  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1]; // largest size last
    return isRecord(largest) ? build("photo", largest, `photo_${ts}.jpg`, "image/jpeg") : null;
  }
  if (isRecord(msg.video)) {
    const v = msg.video;
    return build("video", v, asString(v.file_name) ?? `video_${ts}.mp4`, asString(v.mime_type) ?? "video/mp4");
  }
  if (isRecord(msg.animation)) {
    const a = msg.animation;
    return build("animation", a, asString(a.file_name) ?? `animation_${ts}.mp4`, asString(a.mime_type) ?? "video/mp4");
  }
  if (isRecord(msg.audio)) {
    const a = msg.audio;
    return build(
      "audio",
      a,
      asString(a.file_name) ?? asString(a.title) ?? `audio_${ts}.mp3`,
      asString(a.mime_type) ?? "audio/mpeg"
    );
  }
  if (isRecord(msg.voice)) {
    const v = msg.voice;
    return build("voice", v, `voice_${ts}.ogg`, asString(v.mime_type) ?? "audio/ogg");
  }
  if (isRecord(msg.video_note)) {
    return build("video_note", msg.video_note, `videonote_${ts}.mp4`, "video/mp4");
  }
  if (isRecord(msg.sticker) && !msg.sticker.is_animated) {
    return build("sticker", msg.sticker, `sticker_${ts}.webp`, "image/webp");
  }
  return null;
}

/**
 * Origin of a forwarded message. Bot API 7+ sends `forward_origin`
 * ({type:"channel", chat, message_id}); older payloads used forward_from_chat.
 * Only chat-level origins matter (users forwarding from a channel they own is
 * how vault channels get connected).
 */
function extractForwardOrigin(msg: Rec): IncomingMessage["forwardFrom"] | undefined {
  const origin = isRecord(msg.forward_origin) ? msg.forward_origin : undefined;
  const chat = origin && isRecord(origin.chat)
    ? origin.chat
    : origin && isRecord(origin.sender_chat)
      ? origin.sender_chat
      : isRecord(msg.forward_from_chat)
        ? msg.forward_from_chat
        : undefined;
  if (!chat) return undefined;
  const chatId = idString(chat.id);
  if (!chatId) return undefined;
  const out: NonNullable<IncomingMessage["forwardFrom"]> = {
    chatId,
    chatType: asString(chat.type) ?? "unknown",
  };
  const title = asString(chat.title);
  if (title) out.title = title;
  const messageId = idString(origin?.message_id) ?? idString(msg.forward_from_message_id);
  if (messageId) out.messageId = messageId;
  return out;
}

function parseCallback(updateId: string, cq: Rec): IncomingMessage | null {
  const from = isRecord(cq.from) ? cq.from : undefined;
  const userId = from ? idString(from.id) : undefined;
  const cqId = idString(cq.id);
  if (!userId || !cqId) return null;

  const msg = isRecord(cq.message) ? cq.message : undefined;
  const chat = msg && isRecord(msg.chat) ? msg.chat : undefined;
  const chatId = chat ? idString(chat.id) : undefined;
  const messageId = msg ? idString(msg.message_id) : undefined;

  const out: IncomingMessage = {
    channel: "telegram",
    updateId,
    externalUserId: userId,
    // Inaccessible original message (very old callback): fall back to the
    // private chat with the user, which shares the user's id.
    externalChatId: chatId ?? userId,
    kind: "callback",
    callback: { id: cqId, data: asString(cq.data) ?? "", messageId: messageId ?? "" },
    media: [],
    urls: [],
    isForward: false,
    timestamp: Math.floor(Date.now() / 1000),
  };
  if (messageId !== undefined) out.externalMessageId = messageId;
  const username = from ? asString(from.username) : undefined;
  if (username) out.username = username;
  const displayName = from
    ? [asString(from.first_name), asString(from.last_name)].filter(Boolean).join(" ")
    : "";
  if (displayName) out.displayName = displayName;
  const lang = from ? asString(from.language_code) : undefined;
  if (lang) out.languageHint = lang;
  return out;
}

function parseMessage(
  updateId: string,
  msg: Rec,
  kindOverride?: Extract<IncomingKind, "edited" | "channel_post">
): IncomingMessage | null {
  const chat = isRecord(msg.chat) ? msg.chat : undefined;
  const chatId = chat ? idString(chat.id) : undefined;
  if (!chatId) return null;

  const from = isRecord(msg.from) ? msg.from : undefined;
  const senderChat = isRecord(msg.sender_chat) ? msg.sender_chat : undefined;
  // channel_post has no `from` — fall back to sender_chat, then the chat itself.
  const userId =
    (from ? idString(from.id) : undefined) ??
    (senderChat ? idString(senderChat.id) : undefined) ??
    chatId;

  const media: MediaRef[] = [];
  const m = extractMedia(msg);
  if (m) media.push(m);

  // Media with caption keeps text = caption.
  const text = asString(msg.text) ?? asString(msg.caption);

  let command: { name: string; args: string } | undefined;
  if (text) {
    const match = COMMAND_RE.exec(text);
    const name = match?.[1];
    if (name) command = { name: name.toLowerCase(), args: (match?.[3] ?? "").trim() };
  }

  // Precedence: voice > media > command > text (callback handled elsewhere;
  // edited/channel_post override everything).
  let kind: IncomingKind;
  if (kindOverride) kind = kindOverride;
  else if (isRecord(msg.voice)) kind = "voice";
  else if (media.length > 0) kind = "media";
  else if (command) kind = "command";
  else if (text !== undefined) kind = "text";
  else kind = "other";

  const out: IncomingMessage = {
    channel: "telegram",
    updateId,
    externalUserId: userId,
    externalChatId: chatId,
    kind,
    media,
    urls: extractUrls(text ?? ""),
    isForward: Boolean(msg.forward_origin) || Boolean(msg.forward_from),
    timestamp: asNumber(msg.date) ?? Math.floor(Date.now() / 1000),
  };

  const messageId = idString(msg.message_id);
  if (messageId !== undefined) out.externalMessageId = messageId;
  if (text !== undefined) out.text = text;
  if (command) out.command = command;
  const forwardFrom = extractForwardOrigin(msg);
  if (forwardFrom) out.forwardFrom = forwardFrom;

  const username = (from ? asString(from.username) : undefined) ?? (chat ? asString(chat.username) : undefined);
  if (username) out.username = username;
  const displayName = from
    ? [asString(from.first_name), asString(from.last_name)].filter(Boolean).join(" ")
    : (chat ? asString(chat.title) : undefined) ?? "";
  if (displayName) out.displayName = displayName;

  const reply = isRecord(msg.reply_to_message) ? msg.reply_to_message : undefined;
  if (reply) {
    const replyId = idString(reply.message_id);
    if (replyId !== undefined) out.replyToExternalMessageId = replyId;
    const replyText = asString(reply.text) ?? asString(reply.caption);
    if (replyText !== undefined) out.replyToText = replyText;
  }

  const lang = from ? asString(from.language_code) : undefined;
  if (lang) out.languageHint = lang;

  return out;
}

/**
 * Normalize a raw webhook body. Handles message, edited_message (kind
 * "edited"), callback_query, and channel_post (kind "channel_post" — used
 * during vault-channel setup to discover the chat id). Returns null for
 * anything malformed or unhandled.
 */
export function parseTelegramUpdate(body: unknown): IncomingMessage | null {
  if (!isRecord(body)) return null;
  const updateId = idString(body.update_id);
  if (updateId === undefined) return null;

  if (isRecord(body.callback_query)) return parseCallback(updateId, body.callback_query);
  if (isRecord(body.message)) return parseMessage(updateId, body.message);
  if (isRecord(body.edited_message)) return parseMessage(updateId, body.edited_message, "edited");
  if (isRecord(body.channel_post)) return parseMessage(updateId, body.channel_post, "channel_post");
  return null;
}
