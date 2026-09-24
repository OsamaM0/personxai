/**
 * URL metadata + readable-text extraction. Runs entirely on the Worker's fetch:
 * size-capped, timeout-bound, and tolerant of hostile markup.
 */
import { log, formatError } from "../../utils/logger";

const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 15_000;

export interface UrlMetadata {
  url: string;
  finalUrl: string;
  title: string | null;
  description: string | null;
  siteName: string | null;
  text: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function metaContent(html: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const m = html.match(re);
    const value = m?.[1]?.trim();
    if (value) return decodeEntities(value);
  }
  return null;
}

/** Crude but dependency-free readable-text extraction. */
export function htmlToText(html: string, maxChars: number): string {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(stripped)
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim()
    .slice(0, maxChars);
}

export async function fetchUrlMetadata(
  url: string,
  opts: { maxChars?: number } = {}
): Promise<UrlMetadata | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  try {
    const res = await fetch(parsed.toString(), {
      headers: {
        // Some sites serve empty bodies to unknown agents; be honest but ordinary.
        "user-agent": "Mozilla/5.0 (compatible; PersonXAI/1.0; +https://github.com/)",
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      log("warn", "url_fetch_status", { url: parsed.hostname, status: res.status });
      return null;
    }
    const contentType = res.headers.get("content-type") ?? "";
    const buf = await res.arrayBuffer();
    const body = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(
      buf.byteLength > MAX_BYTES ? buf.slice(0, MAX_BYTES) : buf
    );

    if (!/html/i.test(contentType)) {
      return {
        url,
        finalUrl: res.url || parsed.toString(),
        title: null,
        description: null,
        siteName: parsed.hostname,
        text: body.slice(0, opts.maxChars ?? 12_000),
      };
    }

    const title =
      metaContent(body, [
        /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i,
        /<title[^>]*>([\s\S]*?)<\/title>/i,
      ]) ?? null;
    const description = metaContent(body, [
      /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
    ]);
    const siteName =
      metaContent(body, [/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i]) ??
      parsed.hostname;

    return {
      url,
      finalUrl: res.url || parsed.toString(),
      title: title ? title.replace(/\s+/g, " ").trim().slice(0, 300) : null,
      description: description ? description.slice(0, 500) : null,
      siteName,
      text: htmlToText(body, opts.maxChars ?? 12_000),
    };
  } catch (err) {
    log("warn", "url_fetch_failed", { url: parsed.hostname, error: formatError(err) });
    return null;
  }
}
