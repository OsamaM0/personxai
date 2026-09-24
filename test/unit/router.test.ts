import { describe, expect, it } from "vitest";
import { routeMessage } from "../../src/agent/router";
import type { IncomingMessage } from "../../src/channels/types";

function msg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    channel: "telegram",
    updateId: "1",
    externalUserId: "42",
    externalChatId: "42",
    kind: "text",
    media: [],
    urls: [],
    isForward: false,
    timestamp: 1700000000,
    ...overrides,
  };
}

describe("routeMessage", () => {
  it("routes slash commands without the LLM", () => {
    const route = routeMessage(msg({ kind: "command", command: { name: "today", args: "" } }));
    expect(route).toEqual({ type: "command", name: "today", args: "" });
  });

  it("routes a bare URL to deterministic capture", () => {
    const url = "https://example.com/post";
    const route = routeMessage(msg({ text: url, urls: [url] }));
    expect(route).toEqual({ type: "url", url });
  });

  it("treats a URL with commentary as a conversation", () => {
    const url = "https://example.com/post";
    const route = routeMessage(msg({ text: `save this under research ${url}`, urls: [url] }));
    expect(route.type).toBe("llm");
  });

  it("routes voice notes to transcription", () => {
    expect(routeMessage(msg({ kind: "voice" })).type).toBe("voice");
  });

  it("flags media with and without captions", () => {
    expect(routeMessage(msg({ kind: "media" }))).toEqual({ type: "media", hasCaption: false });
    expect(routeMessage(msg({ kind: "media", text: "file this" }))).toEqual({
      type: "media",
      hasCaption: true,
    });
  });

  it("decodes valid callback data and rejects malformed", () => {
    const ok = routeMessage(
      msg({ kind: "callback", callback: { id: "c1", data: "v1:cfm:abc123:y", messageId: "9" } })
    );
    expect(ok.type).toBe("callback");
    const bad = routeMessage(msg({ kind: "callback", callback: { id: "c2", data: "garbage" } }));
    expect(bad.type).toBe("callback_invalid");
  });

  it("ignores edits, channel posts, and empty text", () => {
    expect(routeMessage(msg({ kind: "edited" })).type).toBe("ignore");
    expect(routeMessage(msg({ kind: "channel_post" })).type).toBe("ignore");
    expect(routeMessage(msg({ text: "   " })).type).toBe("ignore");
  });
});

describe("routeMessage – forwarded channel posts", () => {
  it("routes a message forwarded from a channel to the vault-connect flow", () => {
    const route = routeMessage(
      msg({ text: "vault", isForward: true, forwardFrom: { chatId: "-1001", chatType: "channel", title: "Research", messageId: "9" } })
    );
    expect(route).toEqual({ type: "channel_forward", chatId: "-1001", title: "Research", messageId: "9" });
  });

  it("still treats forwards from users as ordinary conversation", () => {
    const route = routeMessage(msg({ text: "hello", isForward: true, forwardFrom: { chatId: "55", chatType: "private" } }));
    expect(route.type).toBe("llm");
  });

  it("lets commands win over forward metadata", () => {
    const route = routeMessage(
      msg({ kind: "command", command: { name: "files", args: "" }, forwardFrom: { chatId: "-1001", chatType: "channel" } })
    );
    expect(route.type).toBe("command");
  });
});
