/**
 * WhatsApp outbound port.
 *
 * Where WhatsApp lacks a Telegram primitive the port degrades rather than
 * fails, so the channel-agnostic core keeps working unchanged:
 *   - inline keyboards → reply buttons (≤3), a list message (≤10), a single
 *     CTA-URL button, or a numbered plain-text fallback;
 *   - editText → a fresh message (WhatsApp cannot edit sent messages);
 *   - answerCallback → no-op (button replies need no acknowledgement);
 *   - chatAction("typing") → read receipt + typing indicator on the inbound message.
 */
import type { OutboundButton, OutboundPort, SendOptions } from "../types";
import { chunkText, stripMarkdown } from "../../utils/text";
import { downloadTelegramFile } from "../telegram/api";
import {
  markWhatsAppRead,
  sendWhatsAppMessage,
  uploadWhatsAppMedia,
  WhatsAppApiError,
  type SentWhatsAppMessage,
  type WhatsAppCredentials,
} from "./api";
import { clampLabel, toWhatsAppMarkdown } from "./format";

const CHUNK_SIZE = 4000; // WhatsApp text body hard limit is 4096.
const INTER_CHUNK_DELAY_MS = 60;
const MAX_REPLY_BUTTONS = 3;
const REPLY_TITLE_MAX = 20;
const MAX_LIST_ROWS = 10;
const LIST_TITLE_MAX = 24;
const LIST_BUTTON_MAX = 20;
const BUTTON_ID_MAX_BYTES = 256;
const TELEGRAM_RELAY_MAX_BYTES = 20 * 1024 * 1024;

export type ButtonPlan =
  | { kind: "reply"; buttons: { id: string; title: string }[]; links: OutboundButton[] }
  | { kind: "list"; rows: { id: string; title: string }[]; links: OutboundButton[] }
  | { kind: "cta"; url: string; label: string }
  | { kind: "text"; lines: string[] };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageIdOf(result: SentWhatsAppMessage | undefined): string | undefined {
  return result?.messages?.[0]?.id;
}

/**
 * Decide how a Telegram-style keyboard renders on WhatsApp. Pure, so the
 * degradation rules are unit-testable without the network.
 */
export function planButtons(buttons: OutboundButton[][]): ButtonPlan {
  const encoder = new TextEncoder();
  const flat = buttons.flat();
  const links = flat.filter((b) => b.url);
  const actions = flat.filter((b) => !b.url && b.data !== undefined);
  for (const b of actions) {
    if (encoder.encode(b.data ?? "").byteLength > BUTTON_ID_MAX_BYTES) {
      throw new Error("button data too long for WhatsApp");
    }
  }

  if (actions.length === 0) {
    const only = links[0];
    if (links.length === 1 && only?.url) return { kind: "cta", url: only.url, label: clampLabel(only.label, REPLY_TITLE_MAX) };
    return { kind: "text", lines: links.map((b) => `${b.label}: ${b.url}`) };
  }
  if (actions.length <= MAX_REPLY_BUTTONS) {
    return {
      kind: "reply",
      buttons: actions.map((b) => ({ id: b.data ?? "", title: clampLabel(b.label, REPLY_TITLE_MAX) })),
      links,
    };
  }
  if (actions.length <= MAX_LIST_ROWS) {
    return {
      kind: "list",
      rows: actions.map((b) => ({ id: b.data ?? "", title: clampLabel(b.label, LIST_TITLE_MAX) })),
      links,
    };
  }
  // Too many choices for any interactive type: show them, and let the user
  // answer in words (the model resolves the choice on the next turn).
  return {
    kind: "text",
    lines: [
      ...actions.map((b, i) => `${i + 1}. ${b.label}`),
      ...links.map((b) => `${b.label}: ${b.url}`),
    ],
  };
}

export class WhatsAppOutbound implements OutboundPort {
  constructor(
    private readonly creds: WhatsAppCredentials,
    /**
     * Lets stored files that live on Telegram (the vault) be relayed to a
     * WhatsApp chat: download via the Bot API, upload to WhatsApp, send.
     */
    private readonly telegramBotToken?: string,
    /** The inbound message being answered — read receipts and typing are addressed to it. */
    private readonly inbound?: { chatRef: string; messageId?: string }
  ) {}

  private body(text: string, markdown: boolean): string {
    return markdown ? toWhatsAppMarkdown(text) : text;
  }

  private contextExtra(opts?: SendOptions): Record<string, unknown> {
    const id = opts?.replyToExternalMessageId;
    return id ? { context: { message_id: id } } : {};
  }

  /** One text send; a formatting rejection (400) is retried once as plain text. */
  private async sendOne(
    chatRef: string,
    text: string,
    markdown: boolean,
    opts?: SendOptions
  ): Promise<SentWhatsAppMessage> {
    const payload = (body: string): Record<string, unknown> => ({
      to: chatRef,
      type: "text",
      text: { body, preview_url: opts?.disablePreview !== true },
      ...this.contextExtra(opts),
    });
    try {
      return await sendWhatsAppMessage(this.creds, payload(this.body(text, markdown)));
    } catch (err) {
      if (markdown && err instanceof WhatsAppApiError && err.status === 400) {
        return await sendWhatsAppMessage(this.creds, payload(stripMarkdown(text)));
      }
      throw err;
    }
  }

  async sendText(chatRef: string, text: string, opts?: SendOptions): Promise<string | undefined> {
    const markdown = opts?.markdown !== false;
    const chunks = chunkText(text, CHUNK_SIZE);
    let last: SentWhatsAppMessage | undefined;
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) await sleep(INTER_CHUNK_DELAY_MS);
      const chunk = chunks[i];
      if (chunk === undefined) continue;
      // Only the first chunk quotes the original message.
      last = await this.sendOne(chatRef, chunk, markdown, i === 0 ? opts : { ...opts, replyToExternalMessageId: undefined });
    }
    return messageIdOf(last);
  }

  async sendButtons(
    chatRef: string,
    text: string,
    buttons: OutboundButton[][],
    opts?: SendOptions
  ): Promise<string | undefined> {
    const markdown = opts?.markdown !== false;
    const plan = planButtons(buttons);
    const withLinks = (links: OutboundButton[]): string =>
      links.length === 0
        ? this.body(text, markdown)
        : `${this.body(text, markdown)}\n\n${links.map((b) => `${b.label}: ${b.url}`).join("\n")}`;

    let interactive: Record<string, unknown> | null = null;
    switch (plan.kind) {
      case "reply":
        interactive = {
          type: "button",
          body: { text: withLinks(plan.links).slice(0, 1024) },
          action: { buttons: plan.buttons.map((b) => ({ type: "reply", reply: b })) },
        };
        break;
      case "list":
        interactive = {
          type: "list",
          body: { text: withLinks(plan.links).slice(0, 1024) },
          action: {
            button: clampLabel("Choose", LIST_BUTTON_MAX),
            sections: [{ rows: plan.rows }],
          },
        };
        break;
      case "cta":
        interactive = {
          type: "cta_url",
          body: { text: this.body(text, markdown).slice(0, 1024) },
          action: { name: "cta_url", parameters: { display_text: plan.label, url: plan.url } },
        };
        break;
      case "text":
        return this.sendText(chatRef, plan.lines.length ? `${text}\n\n${plan.lines.join("\n")}` : text, opts);
    }

    const result = await sendWhatsAppMessage(this.creds, {
      to: chatRef,
      type: "interactive",
      interactive,
      ...this.contextExtra(opts),
    });
    return messageIdOf(result);
  }

  /** WhatsApp cannot edit a sent message: the replacement goes out as a new one. */
  async editText(
    chatRef: string,
    _externalMessageId: string,
    text: string,
    opts?: { removeButtons?: boolean; markdown?: boolean; buttons?: OutboundButton[][]; disablePreview?: boolean }
  ): Promise<void> {
    const send: SendOptions = { markdown: opts?.markdown, disablePreview: opts?.disablePreview };
    if (opts?.buttons && opts.buttons.length > 0) {
      await this.sendButtons(chatRef, text, opts.buttons, send);
      return;
    }
    await this.sendText(chatRef, text, send);
  }

  async chatAction(chatRef: string, _action: "typing" | "upload_document"): Promise<void> {
    const id = this.inbound?.messageId;
    if (!id || this.inbound?.chatRef !== chatRef) return;
    // Best effort: a stale wamid (message already read) must never fail the turn.
    await markWhatsAppRead(this.creds, id, true).catch(() => {});
  }

  async answerCallback(_callbackId: string, _text?: string): Promise<void> {
    // WhatsApp button replies are ordinary messages; nothing to acknowledge.
  }

  async sendMediaByRef(
    chatRef: string,
    ref: Record<string, string | number | boolean>,
    opts?: { caption?: string }
  ): Promise<void> {
    const caption = opts?.caption !== undefined ? { caption: opts.caption } : {};
    let mediaId = typeof ref.media_id === "string" ? ref.media_id : undefined;
    let fileName = typeof ref.file_name === "string" ? ref.file_name : undefined;

    // The vault is Telegram-backed: relay by re-uploading, size permitting.
    if (!mediaId && typeof ref.file_id === "string" && this.telegramBotToken) {
      const bytes = await downloadTelegramFile(this.telegramBotToken, ref.file_id, TELEGRAM_RELAY_MAX_BYTES);
      if ("error" in bytes) {
        throw new Error(
          bytes.error === "too_large"
            ? "file is larger than 20 MB — WhatsApp relay from the vault is limited to what the Telegram Bot API can download"
            : "could not fetch the file from the vault"
        );
      }
      fileName ??= opts?.caption ?? "file";
      mediaId = await uploadWhatsAppMedia(this.creds, bytes.data, bytes.mime ?? "application/octet-stream", fileName);
    }
    if (!mediaId) {
      throw new Error("sendMediaByRef: ref has neither media_id nor a relayable file_id");
    }
    await sendWhatsAppMessage(this.creds, {
      to: chatRef,
      type: "document",
      document: { id: mediaId, ...(fileName ? { filename: fileName } : {}), ...caption },
    });
  }
}
