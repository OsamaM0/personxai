import { describe, expect, it } from "vitest";
import { parseWhatsAppUpdate } from "../../src/channels/whatsapp/normalize";

const PHONE = "201001234567";

function update(message: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "1234567890",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550001111", phone_number_id: "111222333" },
              contacts: [{ profile: { name: "Ada Lovelace" }, wa_id: PHONE }],
              messages: [{ from: PHONE, id: "wamid.HBgL", timestamp: "1724700000", ...message }],
              ...extra,
            },
          },
        ],
      },
    ],
  };
}

describe("parseWhatsAppUpdate", () => {
  it("parses a plain text message", () => {
    const out = parseWhatsAppUpdate(update({ type: "text", text: { body: "hello there https://example.com/x" } }));
    expect(out).not.toBeNull();
    expect(out?.channel).toBe("whatsapp");
    expect(out?.kind).toBe("text");
    expect(out?.updateId).toBe("wamid.HBgL");
    expect(out?.externalUserId).toBe(PHONE);
    expect(out?.externalChatId).toBe(PHONE);
    expect(out?.externalMessageId).toBe("wamid.HBgL");
    expect(out?.displayName).toBe("Ada Lovelace");
    expect(out?.text).toBe("hello there https://example.com/x");
    expect(out?.urls).toEqual(["https://example.com/x"]);
    expect(out?.timestamp).toBe(1724700000);
    expect(out?.isForward).toBe(false);
    expect(out?.media).toEqual([]);
  });

  it("parses slash commands like Telegram does", () => {
    const out = parseWhatsAppUpdate(update({ type: "text", text: { body: "/Tasks  open ones " } }));
    expect(out?.kind).toBe("command");
    expect(out?.command).toEqual({ name: "tasks", args: "open ones" });
  });

  it("turns a button reply into a callback carrying the button id", () => {
    const out = parseWhatsAppUpdate(
      update({
        type: "interactive",
        context: { from: "15550001111", id: "wamid.PROMPT" },
        interactive: { type: "button_reply", button_reply: { id: "cf:abc:y", title: "Confirm" } },
      })
    );
    expect(out?.kind).toBe("callback");
    expect(out?.callback).toEqual({ id: "wamid.HBgL", data: "cf:abc:y", messageId: "wamid.PROMPT" });
  });

  it("turns a list reply into a callback too", () => {
    const out = parseWhatsAppUpdate(
      update({
        type: "interactive",
        interactive: { type: "list_reply", list_reply: { id: "lst:1:3", title: "Page 3" } },
      })
    );
    expect(out?.kind).toBe("callback");
    expect(out?.callback?.data).toBe("lst:1:3");
  });

  it("maps a voice note to kind voice with a media_id ref and a content id", () => {
    const out = parseWhatsAppUpdate(
      update({ type: "audio", audio: { id: "MEDIA1", mime_type: "audio/ogg; codecs=opus", sha256: "abc123", voice: true } })
    );
    expect(out?.kind).toBe("voice");
    expect(out?.media).toHaveLength(1);
    expect(out?.media[0]).toMatchObject({
      kind: "voice",
      channel: "whatsapp",
      mimeType: "audio/ogg; codecs=opus",
      ref: { media_id: "MEDIA1", sha256: "abc123", file_unique_id: "wa:abc123" },
    });
    expect(out?.media[0]?.fileName).toMatch(/^voice_\d+\.ogg$/);
  });

  it("maps a document with caption to kind media and keeps text = caption", () => {
    const out = parseWhatsAppUpdate(
      update({
        type: "document",
        document: { id: "DOC1", mime_type: "application/pdf", filename: "thesis.pdf", caption: "read this https://a.b/c" },
      })
    );
    expect(out?.kind).toBe("media");
    expect(out?.media[0]).toMatchObject({ kind: "document", fileName: "thesis.pdf", mimeType: "application/pdf", caption: "read this https://a.b/c" });
    expect(out?.text).toBe("read this https://a.b/c");
    expect(out?.urls).toEqual(["https://a.b/c"]);
  });

  it("maps an image to a photo and a non-voice audio to audio", () => {
    const photo = parseWhatsAppUpdate(update({ type: "image", image: { id: "IMG", mime_type: "image/jpeg", sha256: "s" } }));
    expect(photo?.media[0]?.kind).toBe("photo");
    expect(photo?.media[0]?.fileName).toMatch(/\.jpg$/);
    const audio = parseWhatsAppUpdate(update({ type: "audio", audio: { id: "AUD", mime_type: "audio/mpeg" } }));
    expect(audio?.kind).toBe("media");
    expect(audio?.media[0]?.kind).toBe("audio");
  });

  it("skips animated stickers", () => {
    const out = parseWhatsAppUpdate(update({ type: "sticker", sticker: { id: "ST", mime_type: "image/webp", animated: true } }));
    expect(out?.kind).toBe("other");
    expect(out?.media).toEqual([]);
  });

  it("renders a shared location as text", () => {
    const out = parseWhatsAppUpdate(
      update({ type: "location", location: { latitude: 30.0444, longitude: 31.2357, name: "Tahrir", address: "Cairo" } })
    );
    expect(out?.kind).toBe("text");
    expect(out?.text).toContain("Tahrir, Cairo");
    expect(out?.text).toContain("30.0444,31.2357");
  });

  it("records reply context and forwarded flag", () => {
    const reply = parseWhatsAppUpdate(update({ type: "text", text: { body: "yes" }, context: { from: "x", id: "wamid.Q" } }));
    expect(reply?.replyToExternalMessageId).toBe("wamid.Q");
    const fwd = parseWhatsAppUpdate(update({ type: "text", text: { body: "fwd" }, context: { forwarded: true } }));
    expect(fwd?.isForward).toBe(true);
    expect(fwd?.replyToExternalMessageId).toBeUndefined();
  });

  it("ignores status receipts and foreign payloads", () => {
    const statuses = {
      object: "whatsapp_business_account",
      entry: [{ changes: [{ field: "messages", value: { statuses: [{ id: "wamid.X", status: "delivered" }] } }] }],
    };
    expect(parseWhatsAppUpdate(statuses)).toBeNull();
    expect(parseWhatsAppUpdate({ object: "page", entry: [] })).toBeNull();
    expect(parseWhatsAppUpdate(null)).toBeNull();
    expect(parseWhatsAppUpdate("nope")).toBeNull();
    expect(parseWhatsAppUpdate({ update_id: 1, message: { text: "telegram shape" } })).toBeNull();
  });

  it("never throws on malformed messages", () => {
    expect(parseWhatsAppUpdate(update({ type: "text" }))).toMatchObject({ kind: "other" });
    expect(parseWhatsAppUpdate(update({ type: "interactive", interactive: {} }))).toBeNull();
    const noFrom = update({ type: "text", text: { body: "x" } });
    (noFrom.entry as Record<string, unknown>[])[0]!.changes = [
      { field: "messages", value: { messages: [{ id: "wamid.1", type: "text", text: { body: "x" } }] } },
    ];
    expect(parseWhatsAppUpdate(noFrom)).toBeNull();
  });
});
