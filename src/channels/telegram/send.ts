/**
 * Telegram outbound port.
 *
 * Markdown → plain-text fallback ported from
 * ref/openmemo/supabase/functions/_shared/telegram.ts (sendMessageWithButtons):
 * a 400 on a Markdown send is retried once with stripped text and no parse_mode.
 */
import type { OutboundButton, OutboundPort, SendOptions } from "../types";
import { chunkText, stripMarkdown } from "../../utils/text";
import { TelegramApiError, tgCall } from "./api";

const CHUNK_SIZE = 4000; // Telegram hard limit is 4096; leave headroom.
const INTER_CHUNK_DELAY_MS = 60;
const CALLBACK_DATA_MAX_BYTES = 64; // Telegram limit is bytes, not chars.

interface SentMessage {
  message_id?: number | string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageIdOf(result: SentMessage | undefined): string | undefined {
  const id = result?.message_id;
  return id === undefined ? undefined : String(id);
}

/** Build a Telegram inline keyboard; callback buttons are size-checked, link buttons pass through. */
export function inlineKeyboard(buttons: OutboundButton[][]): { inline_keyboard: { text: string; url?: string; callback_data?: string }[][] } {
  const encoder = new TextEncoder();
  return {
    inline_keyboard: buttons.map((row) =>
      row.map((b) => {
        if (b.url) return { text: b.label, url: b.url };
        if (b.data === undefined) throw new Error("button needs data or url");
        if (encoder.encode(b.data).byteLength > CALLBACK_DATA_MAX_BYTES) {
          throw new Error("callback_data too long");
        }
        return { text: b.label, callback_data: b.data };
      })
    ),
  };
}

export class TelegramOutbound implements OutboundPort {
  constructor(private readonly botToken: string) {}

  /** sendMessage with the Markdown→plain fallback on 400. */
  private async sendOne(
    chatRef: string,
    text: string,
    markdown: boolean,
    extra?: Record<string, unknown>
  ): Promise<SentMessage> {
    const payload: Record<string, unknown> = { chat_id: chatRef, text, ...(extra ?? {}) };
    if (markdown) payload.parse_mode = "Markdown";
    try {
      return await tgCall<SentMessage>(this.botToken, "sendMessage", payload);
    } catch (err) {
      if (markdown && err instanceof TelegramApiError && err.status === 400) {
        const plain: Record<string, unknown> = {
          ...payload,
          text: stripMarkdown(text),
        };
        delete plain.parse_mode;
        return await tgCall<SentMessage>(this.botToken, "sendMessage", plain);
      }
      throw err;
    }
  }

  /** Bot API 7.0+ shape; the legacy flag is sent too for older API surfaces. */
  private previewExtra(opts?: SendOptions): Record<string, unknown> {
    if (opts?.disablePreview !== true) return {};
    return { link_preview_options: { is_disabled: true }, disable_web_page_preview: true };
  }

  private replyExtra(opts?: SendOptions): Record<string, unknown> {
    const raw = opts?.replyToExternalMessageId;
    if (!raw) return {};
    const id = Number(raw);
    if (!Number.isFinite(id)) return {};
    // Don't fail the send when the replied-to message was deleted.
    return { reply_to_message_id: id, allow_sending_without_reply: true };
  }

  async sendText(chatRef: string, text: string, opts?: SendOptions): Promise<string | undefined> {
    const markdown = opts?.markdown !== false;
    const chunks = chunkText(text, CHUNK_SIZE);
    let last: SentMessage | undefined;
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) await sleep(INTER_CHUNK_DELAY_MS);
      const chunk = chunks[i];
      if (chunk === undefined) continue;
      // Only the first chunk replies to the original message, but a link can
      // land in any chunk, so preview suppression applies to all of them.
      last = await this.sendOne(chatRef, chunk, markdown, {
        ...this.previewExtra(opts),
        ...(i === 0 ? this.replyExtra(opts) : {}),
      });
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
    const result = await this.sendOne(chatRef, text, markdown, {
      ...this.previewExtra(opts),
      ...this.replyExtra(opts),
      reply_markup: inlineKeyboard(buttons),
    });
    return messageIdOf(result);
  }

  async editText(
    chatRef: string,
    externalMessageId: string,
    text: string,
    opts?: { removeButtons?: boolean; markdown?: boolean; buttons?: OutboundButton[][]; disablePreview?: boolean }
  ): Promise<void> {
    const markdown = opts?.markdown !== false;
    const payload: Record<string, unknown> = {
      chat_id: chatRef,
      message_id: Number(externalMessageId),
      text,
      ...this.previewExtra({ disablePreview: opts?.disablePreview }),
    };
    if (markdown) payload.parse_mode = "Markdown";
    if (opts?.buttons) payload.reply_markup = inlineKeyboard(opts.buttons);
    else if (opts?.removeButtons) payload.reply_markup = { inline_keyboard: [] };

    const isNotModified = (err: unknown): boolean =>
      err instanceof TelegramApiError &&
      err.status === 400 &&
      /message is not modified/i.test(err.description ?? "");

    try {
      await tgCall(this.botToken, "editMessageText", payload);
    } catch (err) {
      if (isNotModified(err)) return;
      if (markdown && err instanceof TelegramApiError && err.status === 400) {
        const plain: Record<string, unknown> = { ...payload, text: stripMarkdown(text) };
        delete plain.parse_mode;
        try {
          await tgCall(this.botToken, "editMessageText", plain);
        } catch (err2) {
          if (isNotModified(err2)) return;
          throw err2;
        }
        return;
      }
      throw err;
    }
  }

  async chatAction(chatRef: string, action: "typing" | "upload_document"): Promise<void> {
    await tgCall(this.botToken, "sendChatAction", { chat_id: chatRef, action });
  }

  async answerCallback(callbackId: string, text?: string): Promise<void> {
    try {
      await tgCall(this.botToken, "answerCallbackQuery", {
        callback_query_id: callbackId,
        ...(text !== undefined ? { text } : {}),
      });
    } catch {
      // Stale callback ids throw ("query is too old") — never propagate.
    }
  }

  async sendMediaByRef(
    chatRef: string,
    ref: Record<string, string | number | boolean>,
    opts?: { caption?: string }
  ): Promise<void> {
    const caption = opts?.caption !== undefined ? { caption: opts.caption } : {};
    if (ref.vault_chat_id && ref.vault_message_id) {
      await tgCall(this.botToken, "copyMessage", {
        chat_id: chatRef,
        from_chat_id: ref.vault_chat_id,
        message_id: Number(ref.vault_message_id),
        ...caption,
      });
      return;
    }
    if (ref.file_id) {
      await tgCall(this.botToken, "sendDocument", {
        chat_id: chatRef,
        document: ref.file_id,
        ...caption,
      });
      return;
    }
    throw new Error("sendMediaByRef: ref has neither vault_chat_id/vault_message_id nor file_id");
  }
}
