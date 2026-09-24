/**
 * Web search, provider-agnostic.
 *
 * The assistant needs the open web for the questions its own database cannot
 * answer ("what time does the match start", "current USD rate"), but which
 * search API a deployment can afford differs — so the provider is configuration,
 * not code. Every provider is normalized to the same small result shape, and a
 * provider that is not configured degrades to a clear error rather than to a
 * hallucinated answer.
 *
 * Supported: Brave Search, Tavily, Serper (Google), and any SearXNG instance.
 */
import { log } from "../../utils/logger";
import { truncate } from "../../utils/text";

export type SearchProvider = "brave" | "tavily" | "serper" | "searxng";

export interface WebSearchConfig {
  provider: SearchProvider;
  apiKey?: string;
  /** Instance URL — required for searxng, an override for the others. */
  baseUrl?: string;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Publication date when the provider reports one, as given. */
  published?: string;
}

export interface WebSearchResponse {
  provider: SearchProvider;
  query: string;
  results: WebSearchResult[];
  /** Some providers (Tavily) return a synthesized answer alongside the hits. */
  answer?: string;
}

const TIMEOUT_MS = 15_000;
const SNIPPET_CHARS = 400;
const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 10;

/**
 * Which provider a deployment is using. An explicit name wins; otherwise the
 * shape of what is configured decides, so the common cases need one variable.
 */
export function resolveSearchConfig(vars: {
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
}): WebSearchConfig | undefined {
  const named = (vars.provider ?? "").trim().toLowerCase();
  const apiKey = vars.apiKey?.trim() || undefined;
  const baseUrl = vars.baseUrl?.trim().replace(/\/+$/, "") || undefined;

  if (named) {
    if (named !== "brave" && named !== "tavily" && named !== "serper" && named !== "searxng") {
      throw new Error(
        `unknown SEARCH_PROVIDER "${named}" — expected one of: brave, tavily, serper, searxng`
      );
    }
    if (named === "searxng" && !baseUrl) {
      throw new Error('SEARCH_PROVIDER="searxng" requires SEARCH_BASE_URL');
    }
    if (named !== "searxng" && !apiKey) {
      throw new Error(`SEARCH_PROVIDER="${named}" requires SEARCH_API_KEY`);
    }
    return { provider: named, ...(apiKey ? { apiKey } : {}), ...(baseUrl ? { baseUrl } : {}) };
  }
  // No provider named: a self-hosted instance needs no key, a key implies Brave
  // (the cheapest of the keyed APIs to start with, and the documented default).
  if (baseUrl) return { provider: "searxng", baseUrl, ...(apiKey ? { apiKey } : {}) };
  if (apiKey) return { provider: "brave", apiKey };
  return undefined;
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}

function clean(text: unknown): string {
  return typeof text === "string" ? truncate(text.replace(/\s+/g, " ").trim(), SNIPPET_CHARS) : "";
}

/** Keep only hits with a usable http(s) URL and a title, deduplicated by URL. */
function tidy(rows: WebSearchResult[], limit: number): WebSearchResult[] {
  const seen = new Set<string>();
  const out: WebSearchResult[] = [];
  for (const row of rows) {
    if (!row.url || !/^https?:\/\//i.test(row.url)) continue;
    const key = row.url.replace(/#.*$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...row, title: row.title || key });
    if (out.length >= limit) break;
  }
  return out;
}

interface ProviderRequest {
  url: string;
  init: RequestInit;
  parse: (body: unknown) => { results: WebSearchResult[]; answer?: string };
}

function braveRequest(cfg: WebSearchConfig, query: string, limit: number): ProviderRequest {
  const base = cfg.baseUrl ?? "https://api.search.brave.com";
  const url = `${base}/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`;
  return {
    url,
    init: {
      headers: {
        accept: "application/json",
        "x-subscription-token": cfg.apiKey ?? "",
      },
    },
    parse: (body) => {
      const web = (body as { web?: { results?: unknown[] } }).web;
      const rows = (web?.results ?? []) as Record<string, unknown>[];
      return {
        results: rows.map((r) => ({
          title: clean(r.title),
          url: String(r.url ?? ""),
          snippet: clean(r.description),
          ...(typeof r.age === "string" ? { published: r.age } : {}),
        })),
      };
    },
  };
}

function tavilyRequest(cfg: WebSearchConfig, query: string, limit: number): ProviderRequest {
  const base = cfg.baseUrl ?? "https://api.tavily.com";
  return {
    url: `${base}/search`,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.apiKey ?? ""}`,
      },
      body: JSON.stringify({
        query,
        max_results: limit,
        include_answer: true,
        search_depth: "basic",
      }),
    },
    parse: (body) => {
      const data = body as { results?: unknown[]; answer?: unknown };
      const rows = (data.results ?? []) as Record<string, unknown>[];
      return {
        results: rows.map((r) => ({
          title: clean(r.title),
          url: String(r.url ?? ""),
          snippet: clean(r.content),
          ...(typeof r.published_date === "string" ? { published: r.published_date } : {}),
        })),
        ...(typeof data.answer === "string" && data.answer.trim()
          ? { answer: clean(data.answer) }
          : {}),
      };
    },
  };
}

function serperRequest(cfg: WebSearchConfig, query: string, limit: number): ProviderRequest {
  const base = cfg.baseUrl ?? "https://google.serper.dev";
  return {
    url: `${base}/search`,
    init: {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": cfg.apiKey ?? "" },
      body: JSON.stringify({ q: query, num: limit }),
    },
    parse: (body) => {
      const data = body as { organic?: unknown[]; answerBox?: { snippet?: unknown } };
      const rows = (data.organic ?? []) as Record<string, unknown>[];
      const answer = clean(data.answerBox?.snippet);
      return {
        results: rows.map((r) => ({
          title: clean(r.title),
          url: String(r.link ?? ""),
          snippet: clean(r.snippet),
          ...(typeof r.date === "string" ? { published: r.date } : {}),
        })),
        ...(answer ? { answer } : {}),
      };
    },
  };
}

function searxngRequest(cfg: WebSearchConfig, query: string, limit: number): ProviderRequest {
  const url = `${cfg.baseUrl}/search?q=${encodeURIComponent(query)}&format=json&safesearch=1`;
  return {
    url,
    init: {
      headers: {
        accept: "application/json",
        // A private instance may still be behind a key/proxy.
        ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
    },
    parse: (body) => {
      const rows = ((body as { results?: unknown[] }).results ?? []) as Record<string, unknown>[];
      return {
        results: rows.slice(0, limit).map((r) => ({
          title: clean(r.title),
          url: String(r.url ?? ""),
          snippet: clean(r.content),
          ...(typeof r.publishedDate === "string" ? { published: r.publishedDate } : {}),
        })),
      };
    },
  };
}

const BUILDERS: Record<SearchProvider, (c: WebSearchConfig, q: string, n: number) => ProviderRequest> = {
  brave: braveRequest,
  tavily: tavilyRequest,
  serper: serperRequest,
  searxng: searxngRequest,
};

/**
 * Run one search. Never throws: a provider outage returns `{ error }` so the
 * caller can tell the user the web is unavailable instead of inventing hits.
 */
export async function webSearch(
  cfg: WebSearchConfig,
  query: string,
  options: { limit?: number } = {}
): Promise<WebSearchResponse | { error: string }> {
  const trimmed = query.trim();
  if (!trimmed) return { error: "empty search query" };
  const limit = clampLimit(options.limit);
  const request = BUILDERS[cfg.provider](cfg, trimmed, limit);

  let body: unknown;
  try {
    const response = await fetch(request.url, {
      ...request.init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      log("warn", "web_search_http_error", { provider: cfg.provider, status: response.status });
      return {
        error:
          response.status === 401 || response.status === 403
            ? `the ${cfg.provider} search key was rejected`
            : `${cfg.provider} search failed (HTTP ${response.status})`,
      };
    }
    body = await response.json();
  } catch (err) {
    log("warn", "web_search_failed", {
      provider: cfg.provider,
      error: err instanceof Error ? err.message : String(err),
    });
    return { error: `could not reach the ${cfg.provider} search service` };
  }

  let parsed: { results: WebSearchResult[]; answer?: string };
  try {
    parsed = request.parse(body);
  } catch {
    return { error: `${cfg.provider} returned a response this version cannot read` };
  }
  return {
    provider: cfg.provider,
    query: trimmed,
    results: tidy(parsed.results, limit),
    ...(parsed.answer ? { answer: parsed.answer } : {}),
  };
}
