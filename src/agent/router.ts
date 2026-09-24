/**
 * Pure routing: decide how to handle a normalized IncomingMessage WITHOUT
 * calling the LLM. Deterministic-first is the cost backbone — commands,
 * button presses, and bare media never touch the model.
 */
import type { IncomingMessage } from "../channels/types";
import { decodeCallbackData, type DecodedCallback } from "./confirmations";

export type Route =
  | { type: "command"; name: string; args: string }
  | { type: "callback"; decoded: DecodedCallback; callbackId: string; messageId?: string }
  | { type: "callback_invalid"; callbackId: string }
  | { type: "voice" }
  | { type: "url"; url: string }
  | { type: "media"; hasCaption: boolean }
  | { type: "channel_forward"; chatId: string; title?: string; messageId?: string }
  | { type: "llm" }
  | { type: "ignore"; reason: "edited" | "empty" | "channel_post" };

export function routeMessage(msg: IncomingMessage): Route {
  if (msg.kind === "callback") {
    const decoded = msg.callback ? decodeCallbackData(msg.callback.data) : null;
    if (!decoded || !msg.callback) {
      return { type: "callback_invalid", callbackId: msg.callback?.id ?? "" };
    }
    return {
      type: "callback",
      decoded,
      callbackId: msg.callback.id,
      messageId: msg.callback.messageId,
    };
  }
  if (msg.kind === "channel_post") return { type: "ignore", reason: "channel_post" };
  if (msg.kind === "edited") return { type: "ignore", reason: "edited" };
  if (msg.kind === "command" && msg.command) {
    return { type: "command", name: msg.command.name, args: msg.command.args };
  }
  if (msg.kind === "voice") return { type: "voice" };
  // A message forwarded from a channel is how a user connects a new vault
  // channel (or points at a stored post). Media inside it is handled downstream.
  if (msg.forwardFrom?.chatType === "channel" && msg.kind !== "command") {
    const out: Extract<Route, { type: "channel_forward" }> = { type: "channel_forward", chatId: msg.forwardFrom.chatId };
    if (msg.forwardFrom.title !== undefined) out.title = msg.forwardFrom.title;
    if (msg.forwardFrom.messageId !== undefined) out.messageId = msg.forwardFrom.messageId;
    return out;
  }
  if (msg.kind === "media") {
    return { type: "media", hasCaption: !!msg.text && msg.text.trim().length > 0 };
  }
  if (!msg.text || msg.text.trim().length === 0) return { type: "ignore", reason: "empty" };
  // A message that is nothing but a link is a capture, not a conversation.
  const trimmed = msg.text.trim();
  if (msg.urls.length === 1 && trimmed === msg.urls[0]) {
    return { type: "url", url: trimmed };
  }
  return { type: "llm" };
}
