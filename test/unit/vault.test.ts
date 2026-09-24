import { describe, expect, it } from "vitest";
import { channelLink, chooseVault, parseChannelDescription, vaultLink } from "../../src/services/storage/vault";
import type { VaultChannelRow } from "../../src/database/types";

const row = (over: Partial<VaultChannelRow>): VaultChannelRow => ({
  id: over.id ?? "id",
  user_id: "u",
  chat_id: over.chat_id ?? "-1001",
  title: over.title ?? null,
  category: over.category ?? null,
  description: null,
  tags: over.tags ?? [],
  is_default: over.is_default ?? false,
  enabled: over.enabled ?? true,
  last_synced_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
});

describe("vaultLink", () => {
  it("builds a t.me/c deep link from a -100 chat id", () => {
    expect(vaultLink("-1001234567890", 42)).toBe("https://t.me/c/1234567890/42");
    expect(channelLink("-1001234567890")).toBe("https://t.me/c/1234567890");
  });

  it("returns null for missing or non-channel ids", () => {
    expect(vaultLink(null, 1)).toBeNull();
    expect(vaultLink("-1001", null)).toBeNull();
    expect(vaultLink("@public", 1)).toBeNull();
  });
});

describe("parseChannelDescription", () => {
  it("reads explicit Category: and Tags: lines", () => {
    expect(parseChannelDescription("Category: Research\nTags: papers, pdf, Thesis")).toEqual({
      category: "research",
      tags: ["papers", "pdf", "thesis"],
    });
  });

  it("collects hashtags and falls back to the first line as category", () => {
    expect(parseChannelDescription("Receipts and invoices #finance #receipts\nkept for taxes")).toEqual({
      category: "receipts and invoices",
      tags: ["finance", "receipts"],
    });
  });

  it("understands Arabic labels", () => {
    expect(parseChannelDescription("تصنيف: أبحاث\nوسوم: أوراق، pdf")).toEqual({
      category: "أبحاث",
      tags: ["أوراق", "pdf"],
    });
  });

  it("handles empty descriptions", () => {
    expect(parseChannelDescription(null)).toEqual({ category: null, tags: [] });
  });
});

describe("chooseVault", () => {
  const general = row({ id: "g", chat_id: "-1001", title: "Vault", category: "general", is_default: true });
  const research = row({ id: "r", chat_id: "-1002", title: "Research", category: "research", tags: ["papers", "pdf"] });
  const money = row({ id: "m", chat_id: "-1003", title: "Money", category: "receipts", tags: ["finance", "invoice"], enabled: false });

  it("prefers an exact category or title match", () => {
    expect(chooseVault([general, research], { category: "Research" })?.id).toBe("r");
  });

  it("falls back to tag overlap, then the default", () => {
    expect(chooseVault([general, research], { tags: ["pdf", "thesis"] })?.id).toBe("r");
    expect(chooseVault([general, research], { tags: ["gym"] })?.id).toBe("g");
  });

  it("never routes to a disabled channel", () => {
    expect(chooseVault([general, research, money], { category: "receipts", tags: ["finance"] })?.id).toBe("g");
    expect(chooseVault([money])).toBeNull();
  });
});
