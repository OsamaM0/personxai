/**
 * Low-level WhatsApp Cloud API (Meta Graph API) client.
 *
 * Mirrors channels/telegram/api.ts: per-call credentials, AbortSignal timeouts,
 * 2 retries on network failure / 5xx only, and error strings that never carry
 * the access token. Graph API errors arrive as { error: { message, code, … } }.
 */
import { log } from "../../utils/logger";

export const DEFAULT_GRAPH_API_VERSION = "v22.0";

const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = [250, 500] as const;
const CALL_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 60_000;

export interface WhatsAppCredentials {
  accessToken: string;
  phoneNumberId: string;
  apiVersion?: string;
}

export class WhatsAppApiError extends Error {
  path: string;
  status: number;
  code?: number;
  description?: string;

  constructor(path: string, status: number, description?: string, code?: number) {
    super(`WhatsApp ${path} failed (${status})${description ? `: ${description}` : ""}`);
    this.name = "WhatsAppApiError";
    this.path = path;
    this.status = status;
    this.code = code;
    this.description = description;
  }
}

interface GraphErrorBody {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransient(status: number): boolean {
  return status >= 500 && status < 600;
}

function redactToken(s: string, token: string): string {
  return token && s.includes(token) ? s.split(token).join("[redacted]") : s;
}

export function graphBaseUrl(creds: WhatsAppCredentials): string {
  return `https://graph.facebook.com/${creds.apiVersion || DEFAULT_GRAPH_API_VERSION}`;
}

/**
 * Call the Graph API. JSON payloads are sent as application/json; a FormData
 * body (media upload) is passed through untouched. Retries ONLY on network
 * failure or 5xx; 4xx and Graph error bodies throw immediately.
 */
export async function waCall<T = unknown>(
  creds: WhatsAppCredentials,
  path: string,
  init: { method?: "GET" | "POST"; json?: Record<string, unknown>; form?: FormData } = {}
): Promise<T> {
  const url = `${graphBaseUrl(creds)}${path}`;
  const method = init.method ?? (init.json || init.form ? "POST" : "GET");
  let lastError: { status: number; description: string; code?: number } = {
    status: 0,
    description: "unknown error",
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let status = 0;
    let description = "";
    let code: number | undefined;

    try {
      const headers: Record<string, string> = { authorization: `Bearer ${creds.accessToken}` };
      let body: BodyInit | undefined;
      if (init.json) {
        headers["content-type"] = "application/json";
        body = JSON.stringify(init.json);
      } else if (init.form) {
        body = init.form;
      }
      const response = await fetch(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(init.form ? UPLOAD_TIMEOUT_MS : CALL_TIMEOUT_MS),
      });
      status = response.status;

      let parsed: (GraphErrorBody & Record<string, unknown>) | null = null;
      try {
        parsed = (await response.json()) as GraphErrorBody & Record<string, unknown>;
      } catch {
        parsed = null;
      }

      if (response.ok && parsed && !parsed.error) {
        return parsed as T;
      }
      description = parsed?.error?.message ?? (response.statusText || "unknown error");
      code = parsed?.error?.code;
    } catch (err) {
      status = 0;
      description = err instanceof Error ? err.message : String(err);
    }

    lastError = { status, description: redactToken(description, creds.accessToken), code };

    if ((status === 0 || isTransient(status)) && attempt < MAX_RETRIES) {
      const delay = RETRY_BACKOFF_MS[attempt] ?? 500;
      log("warn", "whatsapp_retry", { path, status, attempt: attempt + 1, next_delay_ms: delay });
      await sleep(delay);
      continue;
    }
    break;
  }

  log("error", "whatsapp_failure", { path, status: lastError.status, code: lastError.code });
  throw new WhatsAppApiError(path, lastError.status, lastError.description, lastError.code);
}

export interface SentWhatsAppMessage {
  messages?: { id: string }[];
}

/** POST /{phone_number_id}/messages with the mandatory envelope fields filled in. */
export async function sendWhatsAppMessage(
  creds: WhatsAppCredentials,
  payload: Record<string, unknown>
): Promise<SentWhatsAppMessage> {
  return waCall<SentWhatsAppMessage>(creds, `/${creds.phoneNumberId}/messages`, {
    json: { messaging_product: "whatsapp", recipient_type: "individual", ...payload },
  });
}

/**
 * Mark an inbound message as read and, optionally, show the typing indicator
 * (it clears on the next outbound message or after ~25 s). Both are addressed
 * to the inbound message id — WhatsApp has no per-chat "typing" call.
 */
export async function markWhatsAppRead(
  creds: WhatsAppCredentials,
  messageId: string,
  typing: boolean
): Promise<void> {
  await waCall(creds, `/${creds.phoneNumberId}/messages`, {
    json: {
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
      ...(typing ? { typing_indicator: { type: "text" } } : {}),
    },
  });
}

interface MediaInfo {
  url?: string;
  mime_type?: string;
  file_size?: number;
  sha256?: string;
}

/**
 * Download a media item by id: GET /{media_id} resolves a short-lived URL that
 * must be fetched with the same bearer token. Size is checked from the
 * metadata BEFORE downloading and again from the bytes (file_size is optional).
 */
export async function downloadWhatsAppMedia(
  creds: WhatsAppCredentials,
  mediaId: string,
  maxBytes: number
): Promise<{ data: ArrayBuffer; mime?: string } | { error: "too_large" | "failed" }> {
  let info: MediaInfo;
  try {
    info = await waCall<MediaInfo>(creds, `/${encodeURIComponent(mediaId)}`);
  } catch {
    log("warn", "whatsapp_media_lookup_failed", { media_id: mediaId });
    return { error: "failed" };
  }
  if (!info.url) return { error: "failed" };
  if (info.file_size !== undefined && info.file_size > maxBytes) return { error: "too_large" };

  try {
    const res = await fetch(info.url, {
      headers: { authorization: `Bearer ${creds.accessToken}` },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) return { error: "failed" };
    const data = await res.arrayBuffer();
    if (data.byteLength > maxBytes) return { error: "too_large" };
    const mime = res.headers.get("content-type") ?? info.mime_type ?? undefined;
    return { data, mime };
  } catch {
    return { error: "failed" };
  }
}

/** Upload bytes to /{phone_number_id}/media; returns the media id to send with. */
export async function uploadWhatsAppMedia(
  creds: WhatsAppCredentials,
  data: ArrayBuffer,
  mime: string,
  fileName: string
): Promise<string> {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mime);
  form.append("file", new Blob([data], { type: mime }), fileName);
  const result = await waCall<{ id?: string }>(creds, `/${creds.phoneNumberId}/media`, { form });
  if (!result.id) throw new WhatsAppApiError("media", 0, "upload returned no media id");
  return result.id;
}
