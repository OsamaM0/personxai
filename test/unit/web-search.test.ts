import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSearchConfig, webSearch } from "../../src/services/search/web";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Reply to the one fetch the provider makes, and capture what it sent. */
function stubFetch(body: unknown, init: { status?: number } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, requestInit: RequestInit) => {
    calls.push({ url: String(url), init: requestInit ?? {} });
    return new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  return calls;
}

describe("resolveSearchConfig", () => {
  it("infers Brave from a bare key and SearXNG from a bare instance URL", () => {
    expect(resolveSearchConfig({ apiKey: "brave-key" })).toEqual({
      provider: "brave",
      apiKey: "brave-key",
    });
    expect(resolveSearchConfig({ baseUrl: "https://searx.example.com/" })).toEqual({
      provider: "searxng",
      baseUrl: "https://searx.example.com",
    });
  });

  it("is undefined when nothing is configured, so the tool can say so", () => {
    expect(resolveSearchConfig({})).toBeUndefined();
    expect(resolveSearchConfig({ apiKey: "  " })).toBeUndefined();
  });

  it("honours an explicit provider and rejects an incomplete one at boot", () => {
    expect(resolveSearchConfig({ provider: "Tavily", apiKey: "tvly" })).toEqual({
      provider: "tavily",
      apiKey: "tvly",
    });
    expect(() => resolveSearchConfig({ provider: "searxng" })).toThrow(/SEARCH_BASE_URL/);
    expect(() => resolveSearchConfig({ provider: "serper" })).toThrow(/SEARCH_API_KEY/);
    expect(() => resolveSearchConfig({ provider: "bing", apiKey: "k" })).toThrow(/unknown/i);
  });
});

describe("webSearch", () => {
  it("normalizes Brave results and sends the key as a header", async () => {
    const calls = stubFetch({
      web: {
        results: [
          { title: "One", url: "https://a.example/1", description: "first  hit", age: "2 days ago" },
          { title: "Two", url: "https://b.example/2", description: "second hit" },
        ],
      },
    });
    const outcome = await webSearch({ provider: "brave", apiKey: "k" }, "egp usd rate", { limit: 5 });

    expect(calls[0]?.url).toContain("q=egp%20usd%20rate");
    expect((calls[0]?.init.headers as Record<string, string>)["x-subscription-token"]).toBe("k");
    expect(outcome).toEqual({
      provider: "brave",
      query: "egp usd rate",
      results: [
        { title: "One", url: "https://a.example/1", snippet: "first hit", published: "2 days ago" },
        { title: "Two", url: "https://b.example/2", snippet: "second hit" },
      ],
    });
  });

  it("keeps Tavily's answer alongside its results", async () => {
    stubFetch({
      answer: "About 48 EGP.",
      results: [{ title: "Rate", url: "https://c.example", content: "text" }],
    });
    const outcome = await webSearch({ provider: "tavily", apiKey: "tvly" }, "rate");
    expect(outcome).toMatchObject({ answer: "About 48 EGP.", provider: "tavily" });
  });

  it("drops junk rows, deduplicates by URL, and respects the limit", async () => {
    stubFetch({
      organic: [
        { title: "A", link: "https://x.example/p", snippet: "1" },
        { title: "A again", link: "https://x.example/p#section", snippet: "2" },
        { title: "Relative", link: "/not-a-url", snippet: "3" },
        { title: "B", link: "https://y.example", snippet: "4" },
        { title: "C", link: "https://z.example", snippet: "5" },
      ],
    });
    const outcome = await webSearch({ provider: "serper", apiKey: "k" }, "q", { limit: 2 });
    if ("error" in outcome) throw new Error(outcome.error);
    expect(outcome.results.map((r) => r.url)).toEqual(["https://x.example/p", "https://y.example"]);
  });

  it("reports a rejected key and an unreachable service instead of throwing", async () => {
    stubFetch({}, { status: 401 });
    expect(await webSearch({ provider: "brave", apiKey: "bad" }, "q")).toEqual({
      error: "the brave search key was rejected",
    });

    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    expect(await webSearch({ provider: "brave", apiKey: "k" }, "q")).toEqual({
      error: "could not reach the brave search service",
    });
  });
});
