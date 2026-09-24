import { describe, expect, it } from "vitest";
import { channelStatus, getAdapter, listAdapters } from "../../src/channels/registry";
import { isOwnerIdentity, loadConfig, normalizeWhatsAppId, parseAllowedOrigins } from "../../src/config";
import { assertSameOrigin } from "../../src/web/http";
import type { Env } from "../../src/env";

const base = {
  TELEGRAM_BOT_TOKEN: "123456:ABCDEFGHIJKLMNOP",
  TELEGRAM_WEBHOOK_SECRET: "x".repeat(32),
  OWNER_TELEGRAM_ID: "42",
  VAULT_CHANNEL_ID: "-1001234567890",
  SUPABASE_URL: "https://abc.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "y".repeat(40),
  DISPATCH_SECRET: "z".repeat(32),
  DEFAULT_TIMEZONE: "Africa/Cairo",
  DEFAULT_LANGUAGE: "en",
  EMBEDDINGS_DIMS: "1024",
} as unknown as Env;

const WA = {
  WHATSAPP_ACCESS_TOKEN: "EAAB",
  WHATSAPP_PHONE_NUMBER_ID: "111",
  WHATSAPP_APP_SECRET: "s".repeat(32),
  WHATSAPP_VERIFY_TOKEN: "verify-me",
};

const env = (extra: Record<string, string>): Env => ({ ...base, ...extra }) as Env;

describe("channel registry", () => {
  it("registers telegram and whatsapp", () => {
    expect(listAdapters().map((a) => a.name).sort()).toEqual(["telegram", "whatsapp"]);
    expect(getAdapter("whatsapp")?.name).toBe("whatsapp");
    expect(getAdapter("discord")).toBeNull();
  });

  it("reports whatsapp as configured only with the full secret set", () => {
    expect(channelStatus(base)).toEqual({ telegram: true, whatsapp: false });
    expect(channelStatus(env(WA))).toEqual({ telegram: true, whatsapp: true });
    expect(channelStatus(env({ WHATSAPP_ACCESS_TOKEN: "x", WHATSAPP_PHONE_NUMBER_ID: "1" })).whatsapp).toBe(false);
  });

  it("whatsapp adapter answers the handshake and rejects unsigned posts when unconfigured", async () => {
    const wa = getAdapter("whatsapp")!;
    const url = new URL("https://w.example/channels/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42");
    expect(wa.handshake?.(new Request(url), env(WA), url)?.status).toBe(200);
    expect(wa.handshake?.(new Request(url), base, url)).toBeNull();
    const post = new Request("https://w.example/channels/whatsapp/webhook", { method: "POST" });
    expect(await wa.verifyWebhook(post, base, "{}")).toBe(false);
    expect(await wa.verifyWebhook(post, env(WA), "{}")).toBe(false);
    expect(() => wa.outbound(base)).toThrow(/not configured/);
  });
});

describe("whatsapp config", () => {
  it("is absent when no WHATSAPP_* var is set", () => {
    expect(loadConfig(base).whatsapp).toBeUndefined();
    expect(loadConfig(base).ownerWhatsAppId).toBeUndefined();
  });

  it("loads the full set and normalises the owner id", () => {
    const cfg = loadConfig(env({ ...WA, OWNER_WHATSAPP_ID: "+20 100 123 4567", WHATSAPP_API_VERSION: "v23.0" }));
    expect(cfg.whatsapp).toMatchObject({ accessToken: "EAAB", phoneNumberId: "111", verifyToken: "verify-me", apiVersion: "v23.0" });
    expect(cfg.ownerWhatsAppId).toBe("201001234567");
  });

  it("fails fast on a partial set", () => {
    expect(() => loadConfig(env({ WHATSAPP_ACCESS_TOKEN: "EAAB" }))).toThrow(/partially configured.*WHATSAPP_PHONE_NUMBER_ID/);
  });

  it("recognises the owner per channel", () => {
    const cfg = loadConfig(env({ ...WA, OWNER_WHATSAPP_ID: "201001234567" }));
    expect(isOwnerIdentity(cfg, "telegram", "42")).toBe(true);
    expect(isOwnerIdentity(cfg, "telegram", "43")).toBe(false);
    expect(isOwnerIdentity(cfg, "whatsapp", "201001234567")).toBe(true);
    expect(isOwnerIdentity(cfg, "whatsapp", "+201001234567")).toBe(true);
    expect(isOwnerIdentity(cfg, "whatsapp", "42")).toBe(false);
    expect(isOwnerIdentity(loadConfig(base), "whatsapp", "201001234567")).toBe(false);
    expect(isOwnerIdentity(cfg, "discord", "42")).toBe(false);
  });

  it("normalizeWhatsAppId strips everything but digits", () => {
    expect(normalizeWhatsAppId("+1 (555) 000-1111")).toBe("15550001111");
    expect(normalizeWhatsAppId("")).toBeUndefined();
    expect(normalizeWhatsAppId(undefined)).toBeUndefined();
  });
});

describe("ALLOWED_ORIGINS", () => {
  it("parses and normalises a comma-separated list", () => {
    expect(parseAllowedOrigins(" https://app.vercel.app/ , https://assistant.example.com/path ")).toEqual([
      "https://app.vercel.app",
      "https://assistant.example.com",
    ]);
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(() => parseAllowedOrigins("not a url")).toThrow(/ALLOWED_ORIGINS/);
  });

  it("lets an allowed foreign origin through the CSRF guard", () => {
    const url = new URL("https://worker.example/api/tasks");
    const req = (origin: string) => new Request(url, { method: "POST", headers: { origin } });
    expect(() => assertSameOrigin(req("https://app.vercel.app"), url)).toThrow(/cross-origin/);
    expect(() => assertSameOrigin(req("https://app.vercel.app"), url, ["https://app.vercel.app"])).not.toThrow();
    expect(() => assertSameOrigin(req("https://evil.example"), url, ["https://app.vercel.app"])).toThrow(/cross-origin/);
    expect(() => assertSameOrigin(req("https://worker.example"), url, [])).not.toThrow();
  });
});
