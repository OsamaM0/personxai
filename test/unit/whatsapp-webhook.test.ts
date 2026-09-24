import { describe, expect, it } from "vitest";
import { handleWhatsAppHandshake, verifyWhatsAppSignature } from "../../src/channels/whatsapp/webhook";
import { hmacSha256Hex } from "../../src/utils/crypto";

const SECRET = "app-secret-0123456789";

describe("handleWhatsAppHandshake", () => {
  it("echoes hub.challenge when the verify token matches", async () => {
    const url = new URL(
      "https://worker.example/channels/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=tok-123&hub.challenge=987654"
    );
    const res = handleWhatsAppHandshake(url, "tok-123");
    expect(res?.status).toBe(200);
    expect(await res?.text()).toBe("987654");
  });

  it("refuses a wrong token", () => {
    const url = new URL(
      "https://worker.example/channels/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1"
    );
    expect(handleWhatsAppHandshake(url, "tok-123")?.status).toBe(403);
  });

  it("returns null when the request is not a handshake", () => {
    expect(handleWhatsAppHandshake(new URL("https://worker.example/channels/whatsapp/webhook"), "tok")).toBeNull();
    expect(
      handleWhatsAppHandshake(new URL("https://worker.example/x?hub.mode=unsubscribe&hub.challenge=1"), "tok")
    ).toBeNull();
  });
});

describe("verifyWhatsAppSignature", () => {
  const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });

  it("accepts the HMAC-SHA256 of the raw body under the app secret", async () => {
    const sig = `sha256=${await hmacSha256Hex(SECRET, body)}`;
    expect(await verifyWhatsAppSignature(body, sig, SECRET)).toBe(true);
    expect(await verifyWhatsAppSignature(body, sig.toUpperCase().replace("SHA256=", "sha256="), SECRET)).toBe(true);
  });

  it("rejects a signature of different bytes, a different secret, or no header", async () => {
    const sig = `sha256=${await hmacSha256Hex(SECRET, body)}`;
    expect(await verifyWhatsAppSignature(body + " ", sig, SECRET)).toBe(false);
    expect(await verifyWhatsAppSignature(body, sig, "other-secret")).toBe(false);
    expect(await verifyWhatsAppSignature(body, null, SECRET)).toBe(false);
    expect(await verifyWhatsAppSignature(body, "sha1=abc", SECRET)).toBe(false);
    expect(await verifyWhatsAppSignature(body, "sha256=notahexstring", SECRET)).toBe(false);
    expect(await verifyWhatsAppSignature(body, sig, "")).toBe(false);
  });
});
