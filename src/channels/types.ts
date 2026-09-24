/**
 * Channel-agnostic interface layer.
 *
 * The core (agent/, tools/, workflows/) depends ONLY on these types — never on
 * Telegram (or any other channel) specifics. A new channel (WhatsApp, Discord, …)
 * is added by implementing ChannelAdapter and registering it in channels/registry.ts.
 */
import type { Env } from "../env";

export type MediaKind =
  | "document"
  | "photo"
  | "video"
  | "animation"
  | "audio"
  | "voice"
  | "video_note"
  | "sticker";

/** Channel-neutral reference to an attachment. `ref` holds channel-native ids. */
export interface MediaRef {
  kind: MediaKind;
  fileName: string;
  mimeType: string;
  fileSize?: number;
  caption?: string;
  channel: string;
  /**
   * Channel-native identifiers, opaque to the core except for two conventional
   * keys every adapter may fill: `file_unique_id` (stable content id used for
   * duplicate detection) and `file_id` (a Telegram file id, when the bytes
   * already live on Telegram). telegram: file_id, file_unique_id; whatsapp:
   * media_id, sha256.
   */
  ref: Record<string, string | number | boolean>;
  mediaGroupId?: string;
  thumbnailRef?: Record<string, string | number | boolean>;
}

export type IncomingKind =
  | "text"
  | "command"
  | "callback"
  | "media"
  | "voice"
  | "edited"
  | "channel_post"
  | "other";

/** A normalized inbound message from any channel. */
export interface IncomingMessage {
  channel: string;
  /** Channel-native update id — used for dedup. */
  updateId: string;
  externalUserId: string;
  externalChatId: string;
  externalMessageId?: string;
  username?: string;
  displayName?: string;
  kind: IncomingKind;
  text?: string;
  command?: { name: string; args: string };
  callback?: { id: string; data: string; messageId?: string };
  media: MediaRef[];
  urls: string[];
  replyToExternalMessageId?: string;
  /** Text of the message this one replies to, when the channel provides it. */
  replyToText?: string;
  isForward: boolean;
  /** Where a forwarded message came from, when the channel exposes it (telegram: forward_origin). */
  forwardFrom?: { chatId: string; chatType: string; title?: string; messageId?: string };
  /** BCP-47-ish hint from the channel (telegram: from.language_code). */
  languageHint?: string;
  /** Epoch seconds as reported by the channel. */
  timestamp: number;
}

export interface OutboundButton {
  label: string;
  /** Opaque callback payload; adapters must enforce their own size limits (telegram: 64 bytes). */
  data?: string;
  /** Alternatively a plain link button (opens the URL; no callback). */
  url?: string;
}

export interface SendOptions {
  replyToExternalMessageId?: string;
  /** Prefer markdown formatting; adapters must fall back to plain text on failure. */
  markdown?: boolean;
  /**
   * Suppress the channel's link unfurling. Required for any message carrying a
   * single-use URL: preview crawlers fetch the link server-side, which would
   * consume the token before the human ever taps it.
   */
  disablePreview?: boolean;
}

/** Outbound operations the core may perform on a channel. */
export interface OutboundPort {
  /** Returns the external message id of the sent message when available. */
  sendText(chatRef: string, text: string, opts?: SendOptions): Promise<string | undefined>;
  sendButtons(
    chatRef: string,
    text: string,
    buttons: OutboundButton[][],
    opts?: SendOptions
  ): Promise<string | undefined>;
  /**
   * Replace an earlier message in place. Channels without message editing
   * (WhatsApp) must degrade to sending a fresh message rather than failing —
   * the core uses this for "confirmed ✓" rewrites and paginated lists.
   */
  editText(
    chatRef: string,
    externalMessageId: string,
    text: string,
    opts?: {
      removeButtons?: boolean;
      markdown?: boolean;
      /** Replace the inline keyboard (paginated lists re-render in place). */
      buttons?: OutboundButton[][];
      disablePreview?: boolean;
    }
  ): Promise<void>;
  chatAction(chatRef: string, action: "typing" | "upload_document"): Promise<void>;
  /** Acknowledge a button press. No-op on channels that have no callback handshake. */
  answerCallback(callbackId: string, text?: string): Promise<void>;
  /** Send a stored media item back to the user using channel-native refs (Phase 3+). */
  sendMediaByRef?(
    chatRef: string,
    ref: Record<string, string | number | boolean>,
    opts?: { caption?: string }
  ): Promise<void>;
}

export interface ChannelAdapter {
  name: string;
  /**
   * Whether this channel has the secrets it needs. Unconfigured channels stay
   * registered (so the route exists and reports itself in /health) but reject
   * every webhook.
   */
  isConfigured?(env: Env): boolean;
  /**
   * Answer the provider's GET verification handshake, when it has one
   * (WhatsApp: hub.challenge). Return null when the request is not a handshake.
   */
  handshake?(req: Request, env: Env, url: URL): Response | null;
  /**
   * Verify the webhook request's authenticity. Receives the raw body so
   * HMAC-over-body schemes (WhatsApp X-Hub-Signature-256) can be checked;
   * header-secret schemes (Telegram) ignore it. Must compare in constant time.
   */
  verifyWebhook(req: Request, env: Env, rawBody: string): boolean | Promise<boolean>;
  /** Normalize a raw webhook body into zero or one IncomingMessage. */
  parseUpdate(body: unknown): IncomingMessage | null;
  /**
   * Outbound port for this channel. `incoming` is the message being answered,
   * when there is one — adapters whose API needs it (WhatsApp read receipts and
   * typing indicators are addressed to the inbound message id) keep it; others
   * ignore it.
   */
  outbound(env: Env, incoming?: IncomingMessage): OutboundPort;
}
