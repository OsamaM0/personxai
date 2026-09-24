import { describe, expect, it } from "vitest";
import { parseTelegramUpdate } from "../../src/channels/telegram/normalize";

const FROM = {
  id: 111222333,
  is_bot: false,
  first_name: "Ada",
  last_name: "Lovelace",
  username: "ada",
  language_code: "en",
};

const CHAT = { id: 111222333, type: "private", first_name: "Ada", username: "ada" };

function msgUpdate(message: Record<string, unknown>, updateId = 9001): Record<string, unknown> {
  return { update_id: updateId, message: { message_id: 42, from: FROM, chat: CHAT, date: 1_724_700_000, ...message } };
}

describe("parseTelegramUpdate", () => {
  it("parses a plain text message", () => {
    const out = parseTelegramUpdate(msgUpdate({ text: "hello there https://example.com/x" }));
    expect(out).not.toBeNull();
    expect(out?.channel).toBe("telegram");
    expect(out?.kind).toBe("text");
    expect(out?.updateId).toBe("9001");
    expect(out?.externalUserId).toBe("111222333");
    expect(out?.externalChatId).toBe("111222333");
    expect(out?.externalMessageId).toBe("42");
    expect(out?.text).toBe("hello there https://example.com/x");
    expect(out?.urls).toEqual(["https://example.com/x"]);
    expect(out?.username).toBe("ada");
    expect(out?.displayName).toBe("Ada Lovelace");
    expect(out?.languageHint).toBe("en");
    expect(out?.timestamp).toBe(1_724_700_000);
    expect(out?.isForward).toBe(false);
    expect(out?.media).toEqual([]);
  });

  it("parses a command and strips the @botname suffix", () => {
    const out = parseTelegramUpdate(msgUpdate({ text: "/Start@MyPersonalBot  hello world " }));
    expect(out?.kind).toBe("command");
    expect(out?.command).toEqual({ name: "start", args: "hello world" });
  });

  it("parses a bare command with no args", () => {
    const out = parseTelegramUpdate(msgUpdate({ text: "/help" }));
    expect(out?.kind).toBe("command");
    expect(out?.command).toEqual({ name: "help", args: "" });
  });

  it("picks the largest photo and keeps caption + mediaGroupId", () => {
    const out = parseTelegramUpdate(
      msgUpdate({
        caption: "vacation pics https://pics.example/album",
        media_group_id: "13913797626172832",
        photo: [
          { file_id: "small", file_unique_id: "u-small", width: 90, height: 90, file_size: 1000 },
          { file_id: "mid", file_unique_id: "u-mid", width: 320, height: 320, file_size: 20000 },
          { file_id: "large", file_unique_id: "u-large", width: 1280, height: 1280, file_size: 90000 },
        ],
      })
    );
    expect(out?.kind).toBe("media");
    expect(out?.media).toHaveLength(1);
    const media = out?.media[0];
    expect(media?.kind).toBe("photo");
    expect(media?.ref).toEqual({ file_id: "large", file_unique_id: "u-large" });
    expect(media?.fileSize).toBe(90000);
    expect(media?.mimeType).toBe("image/jpeg");
    expect(media?.fileName).toMatch(/^photo_\d+\.jpg$/);
    expect(media?.caption).toBe("vacation pics https://pics.example/album");
    expect(media?.mediaGroupId).toBe("13913797626172832");
    // media with caption keeps text = caption, urls extracted from it
    expect(out?.text).toBe("vacation pics https://pics.example/album");
    expect(out?.urls).toEqual(["https://pics.example/album"]);
  });

  it("parses a voice message as kind voice", () => {
    const out = parseTelegramUpdate(
      msgUpdate({
        voice: { file_id: "v1", file_unique_id: "u-v1", duration: 3, mime_type: "audio/ogg", file_size: 4321 },
      })
    );
    expect(out?.kind).toBe("voice");
    expect(out?.media).toHaveLength(1);
    expect(out?.media[0]?.kind).toBe("voice");
    expect(out?.media[0]?.mimeType).toBe("audio/ogg");
    expect(out?.media[0]?.fileName).toMatch(/^voice_\d+\.ogg$/);
    expect(out?.media[0]?.ref).toEqual({ file_id: "v1", file_unique_id: "u-v1" });
  });

  it("parses a document and captures its thumbnail ref", () => {
    const out = parseTelegramUpdate(
      msgUpdate({
        document: {
          file_id: "d1",
          file_unique_id: "u-d1",
          file_name: "report.pdf",
          mime_type: "application/pdf",
          file_size: 123456,
          thumbnail: { file_id: "t1", file_unique_id: "u-t1", width: 90, height: 90 },
        },
      })
    );
    expect(out?.kind).toBe("media");
    const media = out?.media[0];
    expect(media?.kind).toBe("document");
    expect(media?.fileName).toBe("report.pdf");
    expect(media?.mimeType).toBe("application/pdf");
    expect(media?.fileSize).toBe(123456);
    expect(media?.thumbnailRef).toEqual({ file_id: "t1", file_unique_id: "u-t1" });
  });

  it("parses a callback_query", () => {
    const out = parseTelegramUpdate({
      update_id: 77,
      callback_query: {
        id: "4382bfdwdsb323b2d9",
        from: FROM,
        message: { message_id: 887, chat: { id: -100123, type: "supergroup" }, date: 1_724_600_000 },
        data: "task:done:abc",
      },
    });
    expect(out?.kind).toBe("callback");
    expect(out?.updateId).toBe("77");
    expect(out?.callback).toEqual({ id: "4382bfdwdsb323b2d9", data: "task:done:abc", messageId: "887" });
    expect(out?.externalUserId).toBe("111222333");
    expect(out?.externalChatId).toBe("-100123");
  });

  it("flags forwarded messages (forward_origin and legacy forward_from)", () => {
    const modern = parseTelegramUpdate(
      msgUpdate({ text: "fwd", forward_origin: { type: "user", sender_user: FROM, date: 1 } })
    );
    expect(modern?.isForward).toBe(true);

    const legacy = parseTelegramUpdate(msgUpdate({ text: "fwd", forward_from: FROM }));
    expect(legacy?.isForward).toBe(true);
  });

  it("captures reply_to_message id and text", () => {
    const out = parseTelegramUpdate(
      msgUpdate({
        text: "replying",
        reply_to_message: { message_id: 41, chat: CHAT, date: 1, text: "original text" },
      })
    );
    expect(out?.replyToExternalMessageId).toBe("41");
    expect(out?.replyToText).toBe("original text");
  });

  it("marks edited messages as kind edited", () => {
    const out = parseTelegramUpdate({
      update_id: 5,
      edited_message: { message_id: 42, from: FROM, chat: CHAT, date: 1_724_700_100, text: "fixed typo" },
    });
    expect(out?.kind).toBe("edited");
    expect(out?.text).toBe("fixed typo");
  });

  it("parses a channel_post and exposes the channel chat id", () => {
    const out = parseTelegramUpdate({
      update_id: 6,
      channel_post: {
        message_id: 3,
        chat: { id: -1001234567890, type: "channel", title: "PersonXAI Vault" },
        date: 1_724_700_200,
        text: "vault setup ping",
      },
    });
    expect(out?.kind).toBe("channel_post");
    expect(out?.externalChatId).toBe("-1001234567890");
    // no `from` on channel posts — falls back to the chat id
    expect(out?.externalUserId).toBe("-1001234567890");
    expect(out?.displayName).toBe("PersonXAI Vault");
  });

  it("returns null for malformed junk", () => {
    expect(parseTelegramUpdate(null)).toBeNull();
    expect(parseTelegramUpdate(undefined)).toBeNull();
    expect(parseTelegramUpdate("garbage")).toBeNull();
    expect(parseTelegramUpdate(12345)).toBeNull();
    expect(parseTelegramUpdate([])).toBeNull();
    expect(parseTelegramUpdate({})).toBeNull();
    expect(parseTelegramUpdate({ update_id: 1 })).toBeNull(); // no payload
    expect(parseTelegramUpdate({ message: { text: "no update_id" } })).toBeNull();
    expect(parseTelegramUpdate({ update_id: 2, message: { text: "no chat" } })).toBeNull();
    expect(parseTelegramUpdate({ update_id: 3, callback_query: { data: "x" } })).toBeNull();
  });

  it("skips animated stickers but keeps static ones", () => {
    const animated = parseTelegramUpdate(
      msgUpdate({ sticker: { file_id: "s1", file_unique_id: "u-s1", is_animated: true, is_video: false } })
    );
    expect(animated?.media).toEqual([]);
    expect(animated?.kind).toBe("other");

    const stat = parseTelegramUpdate(
      msgUpdate({ sticker: { file_id: "s2", file_unique_id: "u-s2", is_animated: false, is_video: false } })
    );
    expect(stat?.kind).toBe("media");
    expect(stat?.media[0]?.kind).toBe("sticker");
    expect(stat?.media[0]?.mimeType).toBe("image/webp");
  });
});

describe("forwarded channel posts", () => {
  it("exposes the origin channel from forward_origin (Bot API 7+)", () => {
    const out = parseTelegramUpdate(
      msgUpdate({
        text: "vault",
        forward_origin: { type: "channel", chat: { id: -1001234567890, type: "channel", title: "Research" }, message_id: 77, date: 1 },
      })
    );
    expect(out?.isForward).toBe(true);
    expect(out?.forwardFrom).toEqual({ chatId: "-1001234567890", chatType: "channel", title: "Research", messageId: "77" });
  });

  it("falls back to the legacy forward_from_chat shape", () => {
    const out = parseTelegramUpdate(
      msgUpdate({ text: "x", forward_from_chat: { id: -1009, type: "channel", title: "Old" }, forward_from_message_id: 5, forward_date: 1 })
    );
    expect(out?.forwardFrom).toEqual({ chatId: "-1009", chatType: "channel", title: "Old", messageId: "5" });
  });

  it("leaves forwardFrom unset for ordinary messages", () => {
    expect(parseTelegramUpdate(msgUpdate({ text: "hi" }))?.forwardFrom).toBeUndefined();
  });
});
