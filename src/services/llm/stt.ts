/**
 * Speech-to-text for both provider kinds. Returns null on any failure so a
 * broken transcription degrades to "voice note saved without text".
 */
import type { LLMRoleConfig } from "../../config";
import type { Env } from "../../env";
import { formatError, log } from "../../utils/logger";

const HTTP_TIMEOUT_MS = 60_000;

export async function transcribeAudio(
  audio: ArrayBuffer,
  opts: { mime: string; cfg: LLMRoleConfig; env: Env }
): Promise<string | null> {
  if (audio.byteLength === 0) return null;
  try {
    const text =
      opts.cfg.kind === "workers-ai"
        ? await transcribeWorkersAI(audio, opts.cfg.model, opts.env)
        : await transcribeOpenAICompatible(audio, opts.mime, opts.cfg);
    if (typeof text !== "string") return null;
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch (err) {
    log("warn", "llm.stt_failed", {
      kind: opts.cfg.kind,
      model: opts.cfg.model,
      error: formatError(err),
    });
    return null;
  }
}

async function transcribeWorkersAI(
  audio: ArrayBuffer,
  model: string,
  env: Env
): Promise<unknown> {
  // Input shapes differ per workers-types: @cf/openai/whisper takes
  // { audio: number[] } (uint8 values), whisper-large-v3(-turbo) takes
  // base64-encoded { audio: string }.
  const input = model.includes("whisper-large-v3")
    ? { audio: toBase64(audio) }
    : { audio: [...new Uint8Array(audio)] };
  // Ai.run() is strictly typed on literal @cf/ model ids; a runtime-configured
  // string id resolves to the untyped fallback overload (Record in/out).
  const result: unknown = await env.AI.run(model, input);
  if (typeof result !== "object" || result === null) return null;
  return (result as { text?: unknown }).text;
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  // Chunked so String.fromCharCode never exceeds argument-count limits.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function transcribeOpenAICompatible(
  audio: ArrayBuffer,
  mime: string,
  cfg: { baseURL: string; apiKey: string; model: string }
): Promise<unknown> {
  const form = new FormData();
  form.append("file", new Blob([audio], { type: mime }), "voice.ogg");
  form.append("model", cfg.model);
  const res = await fetch(`${cfg.baseURL.replace(/\/+$/, "")}/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) {
    // Status only — error bodies can echo request details.
    throw new Error(`transcription endpoint returned HTTP ${res.status}`);
  }
  const json = (await res.json()) as { text?: unknown };
  return json.text;
}
