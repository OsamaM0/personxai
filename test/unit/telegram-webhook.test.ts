import { describe, expect, it } from "vitest";
import { constantTimeEquals, verifyTelegramWebhook } from "../../src/channels/telegram/webhook";

describe("constantTimeEquals", () => {
  it("returns true for equal strings", () => {
    expect(constantTimeEquals("s3cret-token", "s3cret-token")).toBe(true);
  });

  it("returns false for unequal strings", () => {
    expect(constantTimeEquals("s3cret-token", "s3cret-tokem")).toBe(false);
    expect(constantTimeEquals("short", "shorter")).toBe(false);
    expect(constantTimeEquals("a", "b")).toBe(false);
  });

  it("returns false when either side is empty", () => {
    expect(constantTimeEquals("", "")).toBe(false);
    expect(constantTimeEquals("x", "")).toBe(false);
    expect(constantTimeEquals("", "x")).toBe(false);
  });

  it("returns false when either side is undefined or null", () => {
    expect(constantTimeEquals(undefined, "x")).toBe(false);
    expect(constantTimeEquals("x", undefined)).toBe(false);
    expect(constantTimeEquals(undefined, undefined)).toBe(false);
    expect(constantTimeEquals(null, "x")).toBe(false);
    expect(constantTimeEquals("x", null)).toBe(false);
    expect(constantTimeEquals(null, null)).toBe(false);
  });
});

describe("verifyTelegramWebhook", () => {
  it("accepts a request carrying the matching secret header", () => {
    const req = new Request("https://worker.example/webhook/telegram", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "hunter2" },
    });
    expect(verifyTelegramWebhook(req, "hunter2")).toBe(true);
  });

  it("rejects a wrong or missing secret header", () => {
    const wrong = new Request("https://worker.example/webhook/telegram", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "hunter3" },
    });
    expect(verifyTelegramWebhook(wrong, "hunter2")).toBe(false);

    const missing = new Request("https://worker.example/webhook/telegram", { method: "POST" });
    expect(verifyTelegramWebhook(missing, "hunter2")).toBe(false);
  });
});
