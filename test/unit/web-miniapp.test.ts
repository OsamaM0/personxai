import { describe, expect, it } from "vitest";
import { INIT_DATA_MAX_AGE_SECONDS, verifyInitData } from "../../src/web/miniapp";

const BOT_TOKEN = "123456:test-bot-token-value";
const NOW = Date.UTC(2026, 7, 27, 12, 0, 0);
const AUTH_DATE = Math.floor(NOW / 1000) - 30;

const encoder = new TextEncoder();

async function hmac(keyBytes: Uint8Array, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

/**
 * Build an initData string the way Telegram does, so the test exercises the
 * real algorithm rather than a mirror of the implementation's own shortcuts.
 */
async function signInitData(fields: Record<string, string>): Promise<string> {
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");
  const secretKey = await hmac(encoder.encode("WebAppData"), BOT_TOKEN);
  const mac = await hmac(secretKey, dataCheckString);
  const hash = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");

  const params = new URLSearchParams(fields);
  params.set("hash", hash);
  return params.toString();
}

const baseFields = (over: Record<string, string> = {}) => ({
  auth_date: String(AUTH_DATE),
  query_id: "AAHdF6IQAAAAAN0XohDhrOrc",
  user: JSON.stringify({ id: 987654321, first_name: "Osama", username: "osama", language_code: "en" }),
  ...over,
});

describe("Telegram Mini App initData", () => {
  it("accepts a correctly signed launch and returns the Telegram user", async () => {
    const initData = await signInitData(baseFields());
    expect(await verifyInitData(BOT_TOKEN, initData, NOW)).toEqual({
      id: "987654321",
      username: "osama",
      firstName: "Osama",
      languageCode: "en",
    });
  });

  it("keeps `signature` inside the data-check-string", async () => {
    // The third-party Ed25519 check drops this field; the bot-token check must
    // not, or every real launch from a current client fails to verify.
    const initData = await signInitData(baseFields({ signature: "S0meBase64UrlSig" }));
    expect(await verifyInitData(BOT_TOKEN, initData, NOW)).not.toBeNull();
  });

  it("rejects a tampered user id", async () => {
    const initData = await signInitData(baseFields());
    const forged = initData.replace("987654321", "111111111");
    expect(forged).not.toEqual(initData);
    expect(await verifyInitData(BOT_TOKEN, forged, NOW)).toBeNull();
  });

  it("rejects data signed with a different bot token", async () => {
    const initData = await signInitData(baseFields());
    expect(await verifyInitData("999999:other-token", initData, NOW)).toBeNull();
  });

  it("rejects initData with no hash at all", async () => {
    const params = new URLSearchParams(baseFields());
    expect(await verifyInitData(BOT_TOKEN, params.toString(), NOW)).toBeNull();
  });

  it("rejects a replayed launch once it is older than the window", async () => {
    const initData = await signInitData(baseFields());
    const later = NOW + (INIT_DATA_MAX_AGE_SECONDS + 60) * 1000;
    expect(await verifyInitData(BOT_TOKEN, initData, later)).toBeNull();
    // Still valid a minute before the cutoff.
    expect(await verifyInitData(BOT_TOKEN, initData, NOW + 60_000)).not.toBeNull();
  });

  it("rejects an auth_date far in the future", async () => {
    const initData = await signInitData(baseFields({ auth_date: String(Math.floor(NOW / 1000) + 3600) }));
    expect(await verifyInitData(BOT_TOKEN, initData, NOW)).toBeNull();
  });

  it("rejects a valid signature that carries no user", async () => {
    const fields = baseFields();
    delete (fields as Record<string, string>).user;
    const initData = await signInitData(fields);
    expect(await verifyInitData(BOT_TOKEN, initData, NOW)).toBeNull();
  });
});
