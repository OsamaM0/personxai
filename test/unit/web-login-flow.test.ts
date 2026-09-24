import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramOutbound } from "../../src/channels/telegram/send";
import {
  handleLoginCallback,
  handleLoginRedeem,
  inspectLoginToken,
} from "../../src/web/auth";
import { MAGIC_TTL_SECONDS, mintToken, type MagicPayload } from "../../src/web/session";
import type { Env } from "../../src/env";
import type { Db } from "../../src/database/client";

const SECRET = "a-test-secret-of-sufficient-length";
const NOW = Date.UTC(2026, 7, 27, 12, 0, 0);
const USER = "11111111-2222-3333-4444-555555555555";

const env = { DISPATCH_SECRET: SECRET, TELEGRAM_BOT_TOKEN: "123:abc" } as unknown as Env;

/** Any DB access from these paths is a bug, so make it explode loudly. */
const forbiddenDb = new Proxy(
  {},
  {
    get() {
      throw new Error("the database must not be touched on this path");
    },
  }
) as Db;

const magicToken = (over: Partial<MagicPayload> = {}) =>
  mintToken(SECRET, "magic", {
    u: USER,
    n: "nonce-value",
    e: Math.floor(NOW / 1000) + MAGIC_TTL_SECONDS,
    ...over,
  });

const callbackUrl = (token: string) => new URL(`https://app.dev/auth/callback?t=${encodeURIComponent(token)}`);

afterEach(() => vi.unstubAllGlobals());

describe("login link delivery", () => {
  /** Capture the JSON body of the last sendMessage call. */
  function captureSend(): { payloads: Record<string, unknown>[] } {
    const payloads: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      payloads.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        headers: { "content-type": "application/json" },
      });
    });
    return { payloads };
  }

  it("suppresses the link preview when asked", async () => {
    // Regression guard: Telegram fetches previewed URLs from its own servers
    // within a second of the send, which would burn a single-use login nonce.
    const { payloads } = captureSend();
    await new TelegramOutbound("123:abc").sendText("42", "https://app.dev/auth/callback?t=x", {
      markdown: false,
      disablePreview: true,
    });
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      link_preview_options: { is_disabled: true },
      disable_web_page_preview: true,
    });
  });

  it("leaves previews alone by default", async () => {
    const { payloads } = captureSend();
    await new TelegramOutbound("123:abc").sendText("42", "hello");
    expect(payloads[0]).not.toHaveProperty("link_preview_options");
    expect(payloads[0]).not.toHaveProperty("disable_web_page_preview");
  });
});

describe("GET /auth/callback", () => {
  it("renders a POST form and never consumes the nonce", async () => {
    const token = await magicToken();
    const res = await handleLoginCallback(env, callbackUrl(token), NOW);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toContain("no-store");

    const body = await res.text();
    expect(body).toContain('method="POST"');
    expect(body).toContain('action="/api/auth/redeem"');
    expect(body).toContain(token);
    // A crawler that only follows links must find nothing to follow.
    expect(body).not.toMatch(/<a\s+href=/i);
    // Must NOT be no-referrer: that makes the browser send `Origin: null` on the
    // form POST, which the same-origin guard rejects.
    expect(body).toContain('name="referrer" content="same-origin"');
    // Match the directive, not the word — the comment above it names no-referrer
    // precisely to record why it must not be used.
    expect(body).not.toMatch(/content=["']no-referrer["']/);
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    // The token is scrubbed from the URL before the POST, so no Referer carries it.
    expect(body).toContain("history.replaceState");

    // The nonce is still redeemable afterwards — the GET changed nothing.
    expect(await inspectLoginToken(env, token, NOW)).not.toBeNull();
  });

  it("redirects an expired link to the error page", async () => {
    const token = await magicToken({ e: Math.floor(NOW / 1000) - 1 });
    const res = await handleLoginCallback(env, callbackUrl(token), NOW);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^\/\?error=/);
  });

  it("rejects a malformed token before doing any work", async () => {
    for (const bad of ["", "not-a-token", "a.b.c", "<script>", "abc.def!"]) {
      const res = await handleLoginCallback(env, callbackUrl(bad), NOW);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toMatch(/^\/\?error=/);
    }
  });
});

describe("POST /api/auth/redeem", () => {
  const post = (body: BodyInit | null) =>
    new Request("https://app.dev/api/auth/redeem", { method: "POST", body });

  const form = (token: string) => {
    const data = new FormData();
    data.set("t", token);
    return data;
  };

  it("rejects a malformed token without touching the database", async () => {
    const res = await handleLoginRedeem(post(form("nope")), env, forbiddenDb, new URL("https://app.dev/"), NOW);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("malformed");
  });

  it("rejects a missing token field", async () => {
    const res = await handleLoginRedeem(post(new FormData()), env, forbiddenDb, new URL("https://app.dev/"), NOW);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^\/\?error=/);
  });

  it("rejects an expired token before touching the database", async () => {
    const token = await magicToken({ e: Math.floor(NOW / 1000) - 1 });
    const res = await handleLoginRedeem(post(form(token)), env, forbiddenDb, new URL("https://app.dev/"), NOW);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^\/\?error=/);
  });
});
