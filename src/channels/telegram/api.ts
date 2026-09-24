/**
 * Low-level Telegram Bot API client.
 *
 * Ported from ref/openmemo/supabase/functions/_shared/telegram.ts (callApi
 * retry/backoff pattern), adapted for Cloudflare Workers: the bot token is
 * passed per call instead of read from env, and every attempt carries an
 * AbortSignal timeout. Error messages must never contain the bot token —
 * anything derived from a fetch failure (which may embed the URL) is redacted.
 */
import { log } from "../../utils/logger";

const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = [250, 500] as const;
const CALL_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;

export class TelegramApiError extends Error {
  method: string;
  status: number;
  description?: string;

  constructor(method: string, status: number, description?: string) {
    super(`Telegram ${method} failed (${status})${description ? `: ${description}` : ""}`);
    this.name = "TelegramApiError";
    this.method = method;
    this.status = status;
    this.description = description;
  }
}

interface TelegramApiResponse {
  ok: boolean;
  result?: unknown;
  description?: string;
  error_code?: number;
}

interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransient(status: number): boolean {
  return status >= 500 && status < 600;
}

/** Strip the bot token from any string that could end up in an error message. */
function redactToken(s: string, botToken: string): string {
  return botToken && s.includes(botToken) ? s.split(botToken).join("[redacted]") : s;
}

/**
 * POST https://api.telegram.org/bot<token>/<method> with a JSON body.
 * Retries ONLY on network failure (status 0) or HTTP 5xx: 2 retries with
 * 250ms/500ms backoff. `ok:false` / 4xx responses throw immediately.
 */
export async function tgCall<T = unknown>(
  botToken: string,
  method: string,
  payload?: Record<string, unknown>
): Promise<T> {
  const url = `https://api.telegram.org/bot${botToken}/${method}`;
  let lastError: { status: number; description: string } = {
    status: 0,
    description: "unknown error",
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let status = 0;
    let description = "";

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload ?? {}),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      status = response.status;

      let body: TelegramApiResponse | null = null;
      try {
        body = (await response.json()) as TelegramApiResponse;
      } catch {
        body = null;
      }

      if (response.ok && body?.ok) {
        return body.result as T;
      }

      status = body?.error_code ?? response.status;
      description = body?.description ?? (response.statusText || "unknown error");
    } catch (err) {
      // Network failure or per-attempt timeout — retryable.
      status = 0;
      description = err instanceof Error ? err.message : String(err);
    }

    lastError = { status, description: redactToken(description, botToken) };

    if ((status === 0 || isTransient(status)) && attempt < MAX_RETRIES) {
      const delay = RETRY_BACKOFF_MS[attempt] ?? 500;
      log("warn", "telegram_retry", {
        method,
        status,
        attempt: attempt + 1,
        next_delay_ms: delay,
      });
      await sleep(delay);
      continue;
    }
    break;
  }

  log("error", "telegram_failure", { method, status: lastError.status });
  throw new TelegramApiError(method, lastError.status, lastError.description);
}

/** Resolve a file_id to a direct download URL via getFile. */
export async function getFileUrl(
  botToken: string,
  fileId: string
): Promise<{ url: string; fileSize?: number; filePath: string }> {
  const file = await tgCall<TelegramFile>(botToken, "getFile", { file_id: fileId });
  const filePath = file?.file_path;
  if (!filePath) {
    throw new TelegramApiError("getFile", 0, "getFile result has no file_path");
  }
  return {
    url: `https://api.telegram.org/file/bot${botToken}/${filePath}`,
    fileSize: file.file_size,
    filePath,
  };
}

/**
 * Download a file by file_id. The size reported by getFile is checked against
 * `maxBytes` BEFORE downloading (Bot API getFile itself caps at 20MB — larger
 * files fail getFile with a 400 "file is too big", mapped to "too_large").
 */
export async function downloadTelegramFile(
  botToken: string,
  fileId: string,
  maxBytes: number
): Promise<{ data: ArrayBuffer; mime?: string } | { error: "too_large" | "failed" }> {
  let url: string;
  let fileSize: number | undefined;
  try {
    ({ url, fileSize } = await getFileUrl(botToken, fileId));
  } catch (err) {
    if (
      err instanceof TelegramApiError &&
      err.status === 400 &&
      /too big/i.test(err.description ?? "")
    ) {
      return { error: "too_large" };
    }
    log("warn", "telegram_getfile_failed", { file_id: fileId });
    return { error: "failed" };
  }

  if (fileSize !== undefined && fileSize > maxBytes) {
    return { error: "too_large" };
  }

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) return { error: "failed" };
    const data = await res.arrayBuffer();
    // getFile occasionally omits file_size; re-check the actual bytes.
    if (data.byteLength > maxBytes) return { error: "too_large" };
    const mime = res.headers.get("content-type") ?? undefined;
    return { data, mime };
  } catch {
    return { error: "failed" };
  }
}
