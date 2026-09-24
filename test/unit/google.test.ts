import { describe, expect, it } from "vitest";
import { freeSlots } from "../../src/services/google/calendar";
import { decodeBase64Url, encodeBase64Url } from "../../src/services/google/api";
import { GOOGLE_SCOPES, googleAuthUrl, googleConfig, isGoogleConfigured } from "../../src/services/google/oauth";
import type { Env } from "../../src/env";

const env = (patch: Partial<Env> = {}): Env => ({ ...(patch as Env) });

describe("google base64url", () => {
  it("round-trips text, including non-ASCII", () => {
    for (const value of ["hello", "مرحبا يا صديقي", "a+b/c=d", ""]) {
      expect(decodeBase64Url(encodeBase64Url(value))).toBe(value);
    }
  });

  it("uses the url-safe alphabet with no padding", () => {
    const encoded = encodeBase64Url("subjects??>>");
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it("returns empty string on garbage rather than throwing", () => {
    expect(decodeBase64Url("!!!not base64!!!")).toBe("");
  });
});

describe("googleConfig", () => {
  it("is absent until both halves of the OAuth client are set", () => {
    expect(isGoogleConfigured(env({ GOOGLE_CLIENT_ID: "id" }))).toBe(false);
    expect(googleConfig(env({ GOOGLE_CLIENT_ID: "id" }), "https://x.dev")).toBeNull();
    expect(isGoogleConfigured(env({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s" }))).toBe(true);
  });

  it("builds the redirect URI from PUBLIC_BASE_URL, falling back to the request origin", () => {
    const withBase = googleConfig(
      env({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s", PUBLIC_BASE_URL: "https://pxa.dev/" }),
      "https://ignored.dev"
    );
    expect(withBase?.redirectUri).toBe("https://pxa.dev/auth/google/callback");

    const withoutBase = googleConfig(
      env({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s" }),
      "https://worker.dev"
    );
    expect(withoutBase?.redirectUri).toBe("https://worker.dev/auth/google/callback");
  });

  it("lets GOOGLE_REDIRECT_URI win, since it must match the console exactly", () => {
    const cfg = googleConfig(
      env({
        GOOGLE_CLIENT_ID: "id",
        GOOGLE_CLIENT_SECRET: "s",
        PUBLIC_BASE_URL: "https://pxa.dev",
        GOOGLE_REDIRECT_URI: "https://custom.dev/cb",
      }),
      "https://worker.dev"
    );
    expect(cfg?.redirectUri).toBe("https://custom.dev/cb");
  });
});

describe("googleAuthUrl", () => {
  const cfg = { clientId: "cid", clientSecret: "sec", redirectUri: "https://pxa.dev/auth/google/callback" };

  it("asks for offline access and forces the consent screen", () => {
    // Without both, Google stops issuing refresh tokens on a re-connect and the
    // integration silently dies an hour later.
    const url = new URL(googleAuthUrl(cfg, "state123"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("state123");
    expect(url.searchParams.get("redirect_uri")).toBe(cfg.redirectUri);
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([...GOOGLE_SCOPES]);
  });

  it("never carries the client secret", () => {
    expect(googleAuthUrl(cfg, "s")).not.toContain("sec");
  });
});

describe("freeSlots", () => {
  const window = { start: "2026-09-07T09:00:00.000Z", end: "2026-09-07T17:00:00.000Z" };

  it("returns the whole window when nothing is booked", () => {
    expect(freeSlots([], window.start, window.end)).toEqual([
      { start: window.start, end: window.end },
    ]);
  });

  it("returns the gaps around meetings", () => {
    const busy = [
      { start: "2026-09-07T10:00:00.000Z", end: "2026-09-07T11:00:00.000Z" },
      { start: "2026-09-07T13:00:00.000Z", end: "2026-09-07T14:00:00.000Z" },
    ];
    expect(freeSlots(busy, window.start, window.end)).toEqual([
      { start: "2026-09-07T09:00:00.000Z", end: "2026-09-07T10:00:00.000Z" },
      { start: "2026-09-07T11:00:00.000Z", end: "2026-09-07T13:00:00.000Z" },
      { start: "2026-09-07T14:00:00.000Z", end: "2026-09-07T17:00:00.000Z" },
    ]);
  });

  it("drops gaps shorter than the minimum", () => {
    const busy = [
      { start: "2026-09-07T09:00:00.000Z", end: "2026-09-07T10:00:00.000Z" },
      { start: "2026-09-07T10:15:00.000Z", end: "2026-09-07T17:00:00.000Z" },
    ];
    expect(freeSlots(busy, window.start, window.end, 30)).toEqual([]);
    expect(freeSlots(busy, window.start, window.end, 15)).toEqual([
      { start: "2026-09-07T10:00:00.000Z", end: "2026-09-07T10:15:00.000Z" },
    ]);
  });

  it("merges overlapping and nested meetings instead of reopening a gap", () => {
    const busy = [
      { start: "2026-09-07T10:00:00.000Z", end: "2026-09-07T15:00:00.000Z" },
      { start: "2026-09-07T11:00:00.000Z", end: "2026-09-07T12:00:00.000Z" },
      { start: "2026-09-07T14:00:00.000Z", end: "2026-09-07T16:00:00.000Z" },
    ];
    expect(freeSlots(busy, window.start, window.end)).toEqual([
      { start: "2026-09-07T09:00:00.000Z", end: "2026-09-07T10:00:00.000Z" },
      { start: "2026-09-07T16:00:00.000Z", end: "2026-09-07T17:00:00.000Z" },
    ]);
  });

  it("ignores blocks outside the window and refuses an inverted one", () => {
    const busy = [{ start: "2026-09-06T10:00:00.000Z", end: "2026-09-06T11:00:00.000Z" }];
    expect(freeSlots(busy, window.start, window.end)).toEqual([
      { start: window.start, end: window.end },
    ]);
    expect(freeSlots([], window.end, window.start)).toEqual([]);
    expect(freeSlots([], "not a date", window.end)).toEqual([]);
  });
});
