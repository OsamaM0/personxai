import { describe, expect, it } from "vitest";
import { chunkForEmbedding } from "../../src/services/media/chunk";

describe("chunkForEmbedding", () => {
  it("returns a single chunk for short text", () => {
    expect(chunkForEmbedding("hello world")).toEqual(["hello world"]);
  });

  it("returns nothing for empty input", () => {
    expect(chunkForEmbedding("   ")).toEqual([]);
  });

  it("splits long text into overlapping chunks", () => {
    const text = "word ".repeat(2000);
    const chunks = chunkForEmbedding(text, { size: 500, overlap: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(500);
  });

  it("prefers paragraph boundaries", () => {
    const para1 = "a".repeat(600);
    const para2 = "b".repeat(600);
    const chunks = chunkForEmbedding(`${para1}\n\n${para2}`, { size: 800, overlap: 20 });
    expect(chunks[0]).toContain("a");
    expect(chunks[0]?.endsWith("a")).toBe(true);
  });

  it("respects maxChunks", () => {
    const chunks = chunkForEmbedding("x ".repeat(50000), { size: 200, overlap: 10, maxChunks: 5 });
    expect(chunks).toHaveLength(5);
  });

  it("makes progress even when no good break point exists", () => {
    const chunks = chunkForEmbedding("x".repeat(3000), { size: 400, overlap: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("").length).toBeGreaterThan(0);
  });

  it("handles Arabic sentence punctuation", () => {
    const text = `${"ا".repeat(300)}؟ ${"ب".repeat(300)}`;
    const chunks = chunkForEmbedding(text, { size: 400, overlap: 20 });
    expect(chunks.length).toBeGreaterThan(1);
  });
});
