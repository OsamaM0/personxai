import { describe, expect, it } from "vitest";
import { botIdentity, isAddressedToBot, isGroupChat } from "../../src/channels/groups";
import type { IncomingMessage } from "../../src/channels/types";
import type { BotRow } from "../../src/database/types";

const msg = (patch: Partial<IncomingMessage> = {}): IncomingMessage => ({
  channel: "telegram",
  updateId: "1",
  externalUserId: "555",
  externalChatId: "-1001",
  chatType: "supergroup",
  kind: "text",
  text: "hello",
  media: [],
  urls: [],
  isForward: false,
  timestamp: 0,
  ...patch,
});

const bot = (patch: Partial<BotRow> = {}): BotRow =>
  ({
    id: "b1",
    user_id: "u1",
    channel: "telegram",
    token: "777:secret",
    bot_external_id: "777",
    username: "personxai_bot",
    title: "PersonXAI",
    webhook_secret: "s",
    webhook_url: null,
    is_active: true,
    is_default: true,
    last_error: null,
    registered_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...patch,
  }) as BotRow;

describe("isGroupChat", () => {
  it("counts groups and supergroups, not private chats or channels", () => {
    expect(isGroupChat("group")).toBe(true);
    expect(isGroupChat("supergroup")).toBe(true);
    expect(isGroupChat("private")).toBe(false);
    expect(isGroupChat("channel")).toBe(false);
    expect(isGroupChat(undefined)).toBe(false);
  });
});

describe("botIdentity", () => {
  it("prefers the stored row", () => {
    expect(botIdentity(bot(), "777:secret")).toEqual({
      externalId: "777",
      username: "personxai_bot",
    });
  });

  it("falls back to the numeric prefix of the token when there is no row", () => {
    // A Telegram token is "<bot id>:<secret>", so the id costs nothing.
    expect(botIdentity(null, "424242:abcdef")).toEqual({
      externalId: "424242",
      username: undefined,
    });
  });

  it("takes a looked-up username when the row has none", () => {
    expect(botIdentity(null, "424242:abcdef", "fetched_bot")).toEqual({
      externalId: "424242",
      username: "fetched_bot",
    });
    // A stored username always wins over the looked-up one.
    expect(botIdentity(bot(), "777:secret", "stale_bot").username).toBe("personxai_bot");
    expect(botIdentity(bot({ username: null }), "777:secret", "fetched_bot").username).toBe(
      "fetched_bot"
    );
  });

  it("yields nothing usable for a malformed token", () => {
    expect(botIdentity(null, "not-a-token")).toEqual({
      externalId: undefined,
      username: undefined,
    });
    expect(botIdentity(null, undefined)).toEqual({ externalId: undefined, username: undefined });
  });
});

describe("isAddressedToBot", () => {
  const identity = { externalId: "777", username: "personxai_bot" };

  it("is always true outside a group", () => {
    expect(isAddressedToBot(msg({ chatType: "private" }), identity)).toBe(true);
  });

  it("is false for ordinary group chatter", () => {
    expect(isAddressedToBot(msg(), identity)).toBe(false);
  });

  it("is true when the bot is @mentioned", () => {
    expect(isAddressedToBot(msg({ mentions: ["personxai_bot"] }), identity)).toBe(true);
  });

  it("ignores a mention of somebody else", () => {
    expect(isAddressedToBot(msg({ mentions: ["someone_else"] }), identity)).toBe(false);
  });

  it("is true for a reply to one of the bot's own messages", () => {
    expect(isAddressedToBot(msg({ replyToFromId: "777" }), identity)).toBe(true);
    expect(isAddressedToBot(msg({ replyToFromId: "999" }), identity)).toBe(false);
  });

  it("takes an unaddressed slash command", () => {
    const command = msg({ kind: "command", command: { name: "tasks", args: "" } });
    expect(isAddressedToBot(command, identity)).toBe(true);
  });

  it("takes a command addressed to it and leaves one addressed elsewhere", () => {
    const mine = msg({
      kind: "command",
      command: { name: "tasks", args: "", target: "personxai_bot" },
    });
    const theirs = msg({
      kind: "command",
      command: { name: "tasks", args: "", target: "other_bot" },
    });
    expect(isAddressedToBot(mine, identity)).toBe(true);
    expect(isAddressedToBot(theirs, identity)).toBe(false);
  });

  it("honours addressedToBot when the ingress already decided (button presses)", () => {
    expect(isAddressedToBot(msg({ kind: "callback", addressedToBot: true }), identity)).toBe(true);
  });

  it("cannot match a mention without a known username, but still matches replies", () => {
    // Only reachable when getMe itself failed; the ingress normally supplies
    // the username even on the env-bootstrap path.
    const idOnly = { externalId: "777", username: undefined };
    expect(isAddressedToBot(msg({ mentions: ["personxai_bot"] }), idOnly)).toBe(false);
    expect(isAddressedToBot(msg({ replyToFromId: "777" }), idOnly)).toBe(true);
  });
});
