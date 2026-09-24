/**
 * WhatsApp Cloud API webhook → IncomingMessage normalization.
 *
 * Same contract as the Telegram normalizer: defensive, hand-rolled, and it
 * NEVER throws — anything malformed or uninteresting yields null. Status
 * updates (sent/delivered/read receipts) are the bulk of what Meta posts and
 * are dropped here so they never reach a Durable Object.
 *
 * Payload shape (entry[].changes[].value):
 *   metadata.phone_number_id, contacts[].profile.name / wa_id,
 *   messages[]: { from, id (wamid), timestamp, type, text|image|document|audio|
 *                 video|sticker|interactive|button|location|reaction|…, context? }
 */
import type { IncomingKind, IncomingMessage, MediaRef } from "../types";
import { extractUrls } from "../../utils/text";

type Rec = Record<string, unknown>;

const COMMAND_RE = /^[/](\w+)(@\w+)?([\s\S]*)/;

function isRecord(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return undefined;
}

/** Extension guessed from a mime type for the fallback file names. */
function extFor(mime: string | undefined, fallback: string): string {
  if (!mime) return fallback;
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/3gpp": "3gp",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/aac": "aac",
    "audio/amr": "amr",
    "application/pdf": "pdf",
  };
  const base = mime.split(";")[0]?.trim() ?? "";
  return map[base] ?? base.split("/")[1]?.replace(/[^a-z0-9]/gi, "") ?? fallback;
}

/**
 * Build the MediaRef for a media message. `sha256` doubles as the stable
 * content id the ingest pipeline uses for duplicate detection (`file_unique_id`),
 * prefixed so it can never collide with a Telegram unique id.
 */
function extractMedia(msg: Rec, type: string): MediaRef | null {
  const obj = isRecord(msg[type]) ? msg[type] : undefined;
  if (!obj) return null;
  const mediaId = asString(obj.id);
  if (!mediaId) return null;
  const mime = asString(obj.mime_type);
  const ts = Date.now();
  const ref: MediaRef["ref"] = { media_id: mediaId };
  const sha = asString(obj.sha256);
  if (sha) {
    ref.sha256 = sha;
    ref.file_unique_id = `wa:${sha}`;
  }

  let kind: MediaRef["kind"];
  let fileName: string;
  let mimeType: string;
  switch (type) {
    case "image":
      kind = "photo";
      mimeType = mime ?? "image/jpeg";
      fileName = `photo_${ts}.${extFor(mime, "jpg")}`;
      break;
    case "video":
      kind = "video";
      mimeType = mime ?? "video/mp4";
      fileName = `video_${ts}.${extFor(mime, "mp4")}`;
      break;
    case "audio":
      // WhatsApp flags recorded voice notes with `voice: true`; other audio is a file.
      kind = obj.voice === true ? "voice" : "audio";
      mimeType = mime ?? "audio/ogg";
      fileName = `${kind}_${ts}.${extFor(mime, "ogg")}`;
      break;
    case "document":
      kind = "document";
      mimeType = mime ?? "";
      fileName = asString(obj.filename) ?? `document_${ts}${mime ? `.${extFor(mime, "bin")}` : ""}`;
      break;
    case "sticker":
      if (obj.animated === true) return null;
      kind = "sticker";
      mimeType = mime ?? "image/webp";
      fileName = `sticker_${ts}.webp`;
      break;
    default:
      return null;
  }

  const media: MediaRef = { kind, fileName, mimeType, channel: "whatsapp", ref };
  const caption = asString(obj.caption);
  if (caption !== undefined) media.caption = caption;
  const size = asNumber(obj.file_size);
  if (size !== undefined) media.fileSize = size;
  return media;
}

/** A shared-location message becomes text the model can act on. */
function locationText(loc: Rec): string | undefined {
  const lat = asNumber(loc.latitude);
  const lng = asNumber(loc.longitude);
  if (lat === undefined || lng === undefined) return undefined;
  const label = [asString(loc.name), asString(loc.address)].filter(Boolean).join(", ");
  return `📍 ${label ? `${label} — ` : ""}${lat},${lng}`;
}

function parseMessage(value: Rec, msg: Rec): IncomingMessage | null {
  const id = asString(msg.id);
  const from = asString(msg.from);
  if (!id || !from) return null;
  const type = asString(msg.type) ?? "unsupported";

  const contacts = Array.isArray(value.contacts) ? value.contacts : [];
  const contact = contacts.find((c) => isRecord(c) && asString(c.wa_id) === from);
  const profile = isRecord(contact) && isRecord(contact.profile) ? contact.profile : undefined;
  const displayName = profile ? asString(profile.name) : undefined;

  const context = isRecord(msg.context) ? msg.context : undefined;
  const contextId = context ? asString(context.id) : undefined;
  const isForward = context?.forwarded === true || context?.frequently_forwarded === true;

  const base: IncomingMessage = {
    channel: "whatsapp",
    updateId: id,
    externalUserId: from,
    // 1:1 only: the chat is addressed by the sender's wa_id.
    externalChatId: from,
    externalMessageId: id,
    kind: "other",
    media: [],
    urls: [],
    isForward,
    timestamp: asNumber(msg.timestamp) ?? Math.floor(Date.now() / 1000),
  };
  if (displayName) base.displayName = displayName;
  if (contextId && !isForward) base.replyToExternalMessageId = contextId;

  // Button / list replies are the WhatsApp equivalent of a callback query.
  if (type === "interactive" && isRecord(msg.interactive)) {
    const inter = msg.interactive;
    const reply = isRecord(inter.button_reply)
      ? inter.button_reply
      : isRecord(inter.list_reply)
        ? inter.list_reply
        : undefined;
    const data = reply ? asString(reply.id) : undefined;
    if (data === undefined) return null;
    base.kind = "callback";
    base.callback = { id, data, messageId: contextId ?? "" };
    return base;
  }
  if (type === "button" && isRecord(msg.button)) {
    const data = asString(msg.button.payload) ?? asString(msg.button.text);
    if (data === undefined) return null;
    base.kind = "callback";
    base.callback = { id, data, messageId: contextId ?? "" };
    return base;
  }

  let text: string | undefined;
  if (type === "text" && isRecord(msg.text)) {
    text = asString(msg.text.body);
  } else if (type === "location" && isRecord(msg.location)) {
    text = locationText(msg.location);
  } else if (["image", "video", "audio", "document", "sticker"].includes(type)) {
    const media = extractMedia(msg, type);
    if (media) {
      base.media.push(media);
      text = media.caption;
    }
  }

  let command: { name: string; args: string } | undefined;
  if (text) {
    const match = COMMAND_RE.exec(text);
    const name = match?.[1];
    if (name) command = { name: name.toLowerCase(), args: (match?.[3] ?? "").trim() };
  }

  let kind: IncomingKind;
  if (base.media[0]?.kind === "voice") kind = "voice";
  else if (base.media.length > 0) kind = "media";
  else if (command) kind = "command";
  else if (text !== undefined) kind = "text";
  else kind = "other";

  base.kind = kind;
  if (text !== undefined) {
    base.text = text;
    base.urls = extractUrls(text);
  }
  if (command) base.command = command;
  return base;
}

/**
 * Normalize a raw webhook body. Only `messages` changes produce a message;
 * `statuses` (delivery receipts) and unknown objects yield null. A single POST
 * can in theory batch several messages — the first is returned, which is what
 * Meta sends in practice for a 1:1 chat.
 */
export function parseWhatsAppUpdate(body: unknown): IncomingMessage | null {
  if (!isRecord(body) || body.object !== "whatsapp_business_account") return null;
  const entries = Array.isArray(body.entry) ? body.entry : [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const change of changes) {
      if (!isRecord(change) || change.field !== "messages" || !isRecord(change.value)) continue;
      const value = change.value;
      const messages = Array.isArray(value.messages) ? value.messages : [];
      for (const msg of messages) {
        if (!isRecord(msg)) continue;
        const parsed = parseMessage(value, msg);
        if (parsed) return parsed;
      }
    }
  }
  return null;
}
