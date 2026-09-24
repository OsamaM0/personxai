/**
 * Media downloads (YouTube and everything else a cobalt instance supports).
 *
 * A Worker cannot run yt-dlp, and shipping a scraper would rot within weeks, so
 * the actual extraction is delegated to a cobalt-compatible API
 * (github.com/imputnet/cobalt) named by MEDIA_API_URL — a public instance, or,
 * better, one the user self-hosts. This module speaks that API, normalizes the
 * v7 and v10 response shapes, and hands back a direct URL the channel can send.
 *
 * Nothing is proxied through the Worker: the bytes go from the instance to
 * Telegram/WhatsApp (or to the user's browser), which keeps a 100 MB video off
 * a 128 MB isolate.
 */
import { log } from "../../utils/logger";

export interface MediaApiConfig {
  baseUrl: string;
  apiKey?: string;
}

export type MediaKindHint = "video" | "audio" | "photo" | "document";

export interface ResolvedMedia {
  /** Direct URL to the media (a cobalt tunnel or the origin's own CDN link). */
  url: string;
  fileName: string;
  kind: MediaKindHint;
  /** Present when the source offered several files and the first was taken. */
  alternatives?: number;
}

const RESOLVE_TIMEOUT_MS = 25_000;
const PROBE_TIMEOUT_MS = 8_000;

/** Telegram accepts at most 20 MB when it is the one fetching the URL. */
export const SEND_BY_URL_MAX_BYTES = 20 * 1024 * 1024;

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
]);

/**
 * The video id in any of the shapes people paste: watch?v=, youtu.be/,
 * /shorts/, /live/, /embed/. Returns null for anything that is not YouTube.
 */
export function youTubeId(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) return null;
  const isId = (s: string | undefined | null): s is string => !!s && /^[\w-]{6,20}$/.test(s);

  if (url.hostname.toLowerCase().endsWith("youtu.be")) {
    const id = url.pathname.slice(1).split("/")[0];
    return isId(id) ? id : null;
  }
  const v = url.searchParams.get("v");
  if (isId(v)) return v;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length >= 2 && ["shorts", "live", "embed", "v"].includes(segments[0] as string)) {
    const id = segments[1];
    return isId(id) ? id : null;
  }
  return null;
}

/** A canonical watch URL, so the same video is always requested the same way. */
export function canonicalMediaUrl(raw: string): string {
  const id = youTubeId(raw);
  return id ? `https://www.youtube.com/watch?v=${id}` : raw.trim();
}

/** Only http(s) reaches the download API — no file:, no data:, no SSRF-ish schemes. */
export function isDownloadableUrl(raw: string): boolean {
  try {
    const url = new URL(raw.trim());
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** Filenames come back from a third party; keep them boring before sending on. */
export function safeFileName(raw: unknown, fallback: string): string {
  const text = typeof raw === "string" ? raw : "";
  const cleaned = text
    .replace(/[\r\n\t]/g, " ")
    .replace(/[\\/:*?"<>|]/g, "")
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

interface CobaltPickerItem {
  type?: string;
  url?: string;
}

interface CobaltResponse {
  status?: string;
  url?: string;
  filename?: string;
  picker?: CobaltPickerItem[];
  audio?: string;
  error?: { code?: string } | string;
  text?: string;
}

/** cobalt error codes are dotted keys; the tail is the only human-useful part. */
function errorMessage(body: CobaltResponse): string {
  const raw =
    typeof body.error === "string"
      ? body.error
      : (body.error?.code ?? body.text ?? "unknown error");
  const tail = raw.split(".").pop() ?? raw;
  return tail.replace(/_/g, " ");
}

/**
 * Ask the download API for a direct media URL.
 *
 * Never throws — a dead instance, a rejected key, a private video and an
 * unsupported site all come back as `{ error }` so the caller can say what
 * happened instead of retrying blindly.
 */
export async function resolveMediaDownload(
  cfg: MediaApiConfig,
  rawUrl: string,
  options: { audioOnly?: boolean; quality?: string } = {}
): Promise<ResolvedMedia | { error: string }> {
  const url = canonicalMediaUrl(rawUrl);
  if (!isDownloadableUrl(url)) return { error: "that is not an http(s) link" };

  const endpoint = cfg.baseUrl.replace(/\/+$/, "") + "/";
  const payload = {
    url,
    downloadMode: options.audioOnly ? "audio" : "auto",
    videoQuality: options.quality ?? "720",
    audioFormat: "mp3",
    filenameStyle: "basic",
  };

  let body: CobaltResponse;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...(cfg.apiKey ? { authorization: `Api-Key ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
    });
    body = (await response.json().catch(() => ({}))) as CobaltResponse;
    if (!response.ok && !body.status) {
      log("warn", "media_download_http_error", { status: response.status });
      return { error: `the download service answered HTTP ${response.status}` };
    }
  } catch (err) {
    log("warn", "media_download_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { error: "could not reach the download service" };
  }

  const status = (body.status ?? "").toLowerCase();
  const kind: MediaKindHint = options.audioOnly ? "audio" : "video";

  // v10: tunnel | redirect · v7: stream | success | redirect
  if (["tunnel", "redirect", "stream", "success"].includes(status) && body.url) {
    return {
      url: body.url,
      fileName: safeFileName(body.filename, options.audioOnly ? "audio.mp3" : "video.mp4"),
      kind,
    };
  }
  if (status === "picker") {
    const items = (body.picker ?? []).filter((item) => typeof item.url === "string");
    const first = items[0];
    if (options.audioOnly && body.audio) {
      return { url: body.audio, fileName: safeFileName(body.filename, "audio.mp3"), kind: "audio" };
    }
    if (first?.url) {
      return {
        url: first.url,
        fileName: safeFileName(body.filename, first.type === "photo" ? "photo.jpg" : "video.mp4"),
        kind: first.type === "photo" ? "photo" : kind,
        ...(items.length > 1 ? { alternatives: items.length - 1 } : {}),
      };
    }
    return { error: "the source offers several files and none could be picked" };
  }
  if (status === "local-processing") {
    // v10 asks the *client* to remux; a Worker cannot, so say so plainly.
    return { error: "this download needs processing the assistant cannot do — try audio only" };
  }
  return { error: errorMessage(body) };
}

/**
 * Content-Length of a resolved URL, when the server declares one. Used to
 * decide between sending the file into the chat and handing over the link;
 * `null` means "unknown", which is treated as "probably too big".
 */
export async function probeContentLength(url: string): Promise<number | null> {
  try {
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const header = response.headers.get("content-length");
    if (!header) return null;
    const size = Number.parseInt(header, 10);
    return Number.isFinite(size) && size > 0 ? size : null;
  } catch {
    return null;
  }
}
