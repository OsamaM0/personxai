import { describe, expect, it } from "vitest";
import {
  MAGIC_TTL_SECONDS,
  SESSION_COOKIE,
  clearedSessionCookie,
  mintToken,
  randomNonce,
  readCookie,
  sessionCookie,
  verifyToken,
  type MagicPayload,
  type SessionPayload,
} from "../../src/web/session";

const SECRET = "a-test-secret-of-sufficient-length";
const NOW = Date.UTC(2026, 7, 27, 12, 0, 0);
const seconds = (ms: number) => Math.floor(ms / 1000);

const magic = (over: Partial<MagicPayload> = {}): MagicPayload => ({
  u: "11111111-2222-3333-4444-555555555555",
  n: "nonce-value",
  e: seconds(NOW) + MAGIC_TTL_SECONDS,
  ...over,
});

const session = (over: Partial<SessionPayload> = {}): SessionPayload => ({
  u: "11111111-2222-3333-4444-555555555555",
  e: seconds(NOW) + 3600,
  i: seconds(NOW),
  ...over,
});

describe("web tokens", () => {
  it("round-trips a payload it signed", async () => {
    const token = await mintToken(SECRET, "magic", magic());
    const payload = await verifyToken<MagicPayload>(SECRET, "magic", token, NOW);
    expect(payload).toEqual(magic());
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await mintToken("some-other-secret-value-here", "magic", magic());
    expect(await verifyToken(SECRET, "magic", token, NOW)).toBeNull();
  });

  it("rejects a magic token replayed as a session cookie", async () => {
    // Domain separation: same secret, same body, different purpose prefix.
    const token = await mintToken(SECRET, "magic", magic());
    expect(await verifyToken(SECRET, "session", token, NOW)).toBeNull();
  });

  it("rejects a session token replayed as a magic link", async () => {
    const token = await mintToken(SECRET, "session", session());
    expect(await verifyToken(SECRET, "magic", token, NOW)).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const token = await mintToken(SECRET, "session", session());
    const forged = await mintToken(SECRET, "session", session({ u: "99999999-2222-3333-4444-555555555555" }));
    const spliced = `${forged.split(".")[0]}.${token.split(".")[1]}`;
    expect(await verifyToken(SECRET, "session", spliced, NOW)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = await mintToken(SECRET, "magic", magic({ e: seconds(NOW) - 1 }));
    expect(await verifyToken(SECRET, "magic", token, NOW)).toBeNull();
  });

  it("expires exactly at the boundary", async () => {
    const exp = seconds(NOW) + 60;
    const token = await mintToken(SECRET, "magic", magic({ e: exp }));
    expect(await verifyToken(SECRET, "magic", token, exp * 1000 - 1)).not.toBeNull();
    expect(await verifyToken(SECRET, "magic", token, exp * 1000)).toBeNull();
  });

  it("rejects malformed input without throwing", async () => {
    for (const bad of ["", "no-dot", ".", "a.", ".b", "!!!.???", "e30.x"]) {
      expect(await verifyToken(SECRET, "session", bad, NOW)).toBeNull();
    }
    expect(await verifyToken(SECRET, "session", null, NOW)).toBeNull();
    expect(await verifyToken(SECRET, "session", undefined, NOW)).toBeNull();
  });

  it("mints distinct nonces", () => {
    const seen = new Set(Array.from({ length: 50 }, () => randomNonce()));
    expect(seen.size).toBe(50);
  });
});

describe("cookies", () => {
  const req = (cookie: string) => new Request("https://example.com/", { headers: { cookie } });

  it("reads the named cookie among others", () => {
    expect(readCookie(req(`a=1; ${SESSION_COOKIE}=abc.def; z=9`), SESSION_COOKIE)).toBe("abc.def");
  });

  it("returns null when absent or unset", () => {
    expect(readCookie(req("a=1"), SESSION_COOKIE)).toBeNull();
    expect(readCookie(new Request("https://example.com/"), SESSION_COOKIE)).toBeNull();
  });

  it("does not match a cookie whose name merely ends with the target", () => {
    expect(readCookie(req(`x_${SESSION_COOKIE}=nope`), SESSION_COOKIE)).toBeNull();
  });

  it("marks the cookie Secure on https and omits it on http", () => {
    expect(sessionCookie("v", new URL("https://example.com/"), 60)).toContain("; Secure");
    // wrangler dev serves plain http on localhost; a Secure cookie would never come back.
    expect(sessionCookie("v", new URL("http://localhost:8787/"), 60)).not.toContain("; Secure");
  });

  it("always sets HttpOnly and SameSite=Lax", () => {
    const cookie = sessionCookie("v", new URL("https://example.com/"), 60);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("clears with Max-Age=0", () => {
    expect(clearedSessionCookie(new URL("https://example.com/"))).toContain("Max-Age=0");
  });
});
