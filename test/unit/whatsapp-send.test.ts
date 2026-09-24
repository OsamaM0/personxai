import { afterEach, describe, expect, it, vi } from "vitest";
import { planButtons, WhatsAppOutbound } from "../../src/channels/whatsapp/send";
import { clampLabel, toWhatsAppMarkdown } from "../../src/channels/whatsapp/format";

const CREDS = { accessToken: "EAAB-token", phoneNumberId: "111222333" };

describe("toWhatsAppMarkdown", () => {
  it("keeps WhatsApp-native *bold* _italic_ `code` untouched", () => {
    expect(toWhatsAppMarkdown("*Tasks* _today_ `x`")).toBe("*Tasks* _today_ `x`");
  });

  it("rewrites CommonMark bold, strike, links and headings", () => {
    expect(toWhatsAppMarkdown("**Bold** and ~~gone~~")).toBe("*Bold* and ~gone~");
    expect(toWhatsAppMarkdown("See [the docs](https://x.y/z) now")).toBe("See the docs (https://x.y/z) now");
    expect(toWhatsAppMarkdown("[https://x.y](https://x.y)")).toBe("https://x.y");
    expect(toWhatsAppMarkdown("# Heading\ntext")).toBe("*Heading*\ntext");
  });

  it("turns leading * bullets into • so they do not open bold", () => {
    expect(toWhatsAppMarkdown("* one\n* two")).toBe("• one\n• two");
  });

  it("leaves fenced code blocks alone", () => {
    const block = "```\n**not bold** [a](https://b)\n```";
    expect(toWhatsAppMarkdown(`before **x**\n${block}`)).toBe(`before *x*\n${block}`);
  });
});

describe("clampLabel", () => {
  it("returns short labels unchanged and cuts long ones on a word", () => {
    expect(clampLabel("Confirm", 20)).toBe("Confirm");
    const cut = clampLabel("Move to the research channel please", 20);
    expect(cut).toBe("Move to the…");
    expect(cut.length).toBeLessThanOrEqual(20);
    expect(clampLabel("Supercalifragilisticexpialidocious", 20)).toHaveLength(20);
  });
});

describe("planButtons", () => {
  it("uses reply buttons for up to three actions", () => {
    const plan = planButtons([[{ label: "Confirm", data: "c:1:y" }, { label: "Cancel", data: "c:1:n" }]]);
    expect(plan.kind).toBe("reply");
    if (plan.kind === "reply") {
      expect(plan.buttons).toEqual([
        { id: "c:1:y", title: "Confirm" },
        { id: "c:1:n", title: "Cancel" },
      ]);
    }
  });

  it("uses a list for four to ten actions and keeps link buttons aside", () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({ label: `Option ${i + 1}`, data: `o:${i}` }));
    const plan = planButtons([rows, [{ label: "Open", url: "https://x.y" }]]);
    expect(plan.kind).toBe("list");
    if (plan.kind === "list") {
      expect(plan.rows).toHaveLength(6);
      expect(plan.links).toEqual([{ label: "Open", url: "https://x.y" }]);
    }
  });

  it("uses a CTA for a lone link and text for anything else", () => {
    expect(planButtons([[{ label: "Sign in", url: "https://x.y/auth" }]])).toEqual({
      kind: "cta",
      url: "https://x.y/auth",
      label: "Sign in",
    });
    const many = Array.from({ length: 12 }, (_, i) => ({ label: `Item ${i + 1}`, data: `i:${i}` }));
    const plan = planButtons([many]);
    expect(plan.kind).toBe("text");
    if (plan.kind === "text") expect(plan.lines[11]).toBe("12. Item 12");
  });

  it("rejects callback data beyond WhatsApp's 256-byte id limit", () => {
    expect(() => planButtons([[{ label: "x", data: "y".repeat(257) }]])).toThrow(/too long/);
  });
});

describe("WhatsAppOutbound", () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];

  function mockFetch(responder?: (body: Record<string, unknown>) => Response) {
    calls.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        calls.push({ url, body });
        return responder?.(body) ?? new Response(JSON.stringify({ messages: [{ id: `wamid.${calls.length}` }] }), { status: 200 });
      })
    );
  }

  afterEach(() => vi.unstubAllGlobals());

  it("sends text with converted markdown, preview control and reply context", async () => {
    mockFetch();
    const out = new WhatsAppOutbound(CREDS);
    const id = await out.sendText("2010", "**hi** [d](https://x.y)", { replyToExternalMessageId: "wamid.Q", disablePreview: true });
    expect(id).toBe("wamid.1");
    expect(calls[0]?.url).toBe("https://graph.facebook.com/v22.0/111222333/messages");
    expect(calls[0]?.body).toMatchObject({
      messaging_product: "whatsapp",
      to: "2010",
      type: "text",
      text: { body: "*hi* d (https://x.y)", preview_url: false },
      context: { message_id: "wamid.Q" },
    });
  });

  it("chunks long text and only quotes on the first chunk", async () => {
    mockFetch();
    const out = new WhatsAppOutbound(CREDS);
    const text = Array.from({ length: 120 }, (_, i) => `line ${i} ${"x".repeat(60)}`).join("\n");
    await out.sendText("2010", text, { replyToExternalMessageId: "wamid.Q" });
    expect(calls.length).toBeGreaterThan(1);
    expect(calls[0]?.body.context).toEqual({ message_id: "wamid.Q" });
    expect(calls[1]?.body.context).toBeUndefined();
    for (const c of calls) expect(String((c.body.text as { body: string }).body).length).toBeLessThanOrEqual(4096);
  });

  it("falls back to plain text when the formatted send is rejected with 400", async () => {
    let first = true;
    mockFetch(() => {
      if (first) {
        first = false;
        return new Response(JSON.stringify({ error: { message: "bad format", code: 100 } }), { status: 400 });
      }
      return new Response(JSON.stringify({ messages: [{ id: "wamid.ok" }] }), { status: 200 });
    });
    const out = new WhatsAppOutbound(CREDS);
    const id = await out.sendText("2010", "*broken");
    expect(id).toBe("wamid.ok");
    expect(calls).toHaveLength(2);
    expect((calls[1]?.body.text as { body: string }).body).toBe("broken");
  });

  it("renders confirm/cancel as interactive reply buttons", async () => {
    mockFetch();
    const out = new WhatsAppOutbound(CREDS);
    await out.sendButtons("2010", "Delete note 5?", [[{ label: "Confirm", data: "c:1:y" }, { label: "Cancel", data: "c:1:n" }]]);
    expect(calls[0]?.body).toMatchObject({
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: "Delete note 5?" },
        action: { buttons: [{ type: "reply", reply: { id: "c:1:y", title: "Confirm" } }, { type: "reply", reply: { id: "c:1:n", title: "Cancel" } }] },
      },
    });
  });

  it("degrades editText to a fresh message (WhatsApp cannot edit)", async () => {
    mockFetch();
    const out = new WhatsAppOutbound(CREDS);
    await out.editText("2010", "wamid.old", "Done ✓", { removeButtons: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.type).toBe("text");
    await out.editText("2010", "wamid.old", "Page 2", { buttons: [[{ label: "Next", data: "l:2" }]] });
    expect(calls[1]?.body.type).toBe("interactive");
  });

  it("sends a read receipt + typing indicator for the inbound message only", async () => {
    mockFetch();
    const out = new WhatsAppOutbound(CREDS, undefined, { chatRef: "2010", messageId: "wamid.in" });
    await out.chatAction("2010", "typing");
    expect(calls[0]?.body).toEqual({
      messaging_product: "whatsapp",
      status: "read",
      message_id: "wamid.in",
      typing_indicator: { type: "text" },
    });
    await out.chatAction("other-chat", "typing");
    expect(calls).toHaveLength(1);
    await new WhatsAppOutbound(CREDS).chatAction("2010", "typing");
    expect(calls).toHaveLength(1);
  });

  it("sends stored WhatsApp media by id and refuses refs it cannot relay", async () => {
    mockFetch();
    const out = new WhatsAppOutbound(CREDS);
    await out.sendMediaByRef("2010", { media_id: "M1", file_name: "a.pdf" }, { caption: "a.pdf" });
    expect(calls[0]?.body).toMatchObject({ type: "document", document: { id: "M1", filename: "a.pdf", caption: "a.pdf" } });
    await expect(out.sendMediaByRef("2010", { vault_chat_id: "-100", vault_message_id: 5 })).rejects.toThrow(/relayable/);
  });
});
