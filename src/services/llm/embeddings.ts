/**
 * Text embeddings for both provider kinds. Never throws: a missing embedding
 * only degrades semantic search, so failures log a warning and yield null
 * rather than breaking the caller's write path.
 *
 * Defensive response validation adapted from openmemo's `extractEmbedding`
 * (ref/openmemo/supabase/functions/_shared/deepseek.ts).
 */
import type { EmbeddingsConfig } from "../../config";
import type { Env } from "../../env";
import { formatError, log } from "../../utils/logger";

const MAX_INPUT_CHARS = 6000;
const HTTP_TIMEOUT_MS = 20_000;

export async function embedText(
  text: string,
  cfg: EmbeddingsConfig,
  env: Env
): Promise<number[] | null> {
  if (text.trim().length === 0) return null;
  const input = text.slice(0, MAX_INPUT_CHARS);
  try {
    const raw =
      cfg.kind === "workers-ai"
        ? await embedWorkersAI(input, cfg.model, env)
        : await embedOpenAICompatible(input, cfg.baseURL, cfg.apiKey, cfg.model);
    return validateVector(raw, cfg);
  } catch (err) {
    log("warn", "llm.embed_failed", {
      kind: cfg.kind,
      model: cfg.model,
      error: formatError(err),
    });
    return null;
  }
}

/** Sequential on purpose: keeps Workers AI / provider rate limits happy. */
export async function embedBatch(
  texts: string[],
  cfg: EmbeddingsConfig,
  env: Env
): Promise<(number[] | null)[]> {
  const out: (number[] | null)[] = [];
  for (const text of texts) {
    out.push(await embedText(text, cfg, env));
  }
  return out;
}

async function embedWorkersAI(text: string, model: string, env: Env): Promise<unknown> {
  // Ai.run() is strictly typed on literal @cf/ model ids; a runtime-configured
  // string id resolves to the untyped fallback overload (Record in/out).
  const result: unknown = await env.AI.run(model, { text: [text] });
  if (typeof result !== "object" || result === null) return null;
  const data = (result as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) return null;
  // bge-m3 returns { data: number[][] }; tolerate a flat number[] as well.
  return Array.isArray(data[0]) ? data[0] : data;
}

async function embedOpenAICompatible(
  text: string,
  baseURL: string,
  apiKey: string,
  model: string
): Promise<unknown> {
  const res = await fetch(`${baseURL.replace(/\/+$/, "")}/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, input: text }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) {
    // Status only — error bodies can echo request details.
    throw new Error(`embeddings endpoint returned HTTP ${res.status}`);
  }
  const json = (await res.json()) as { data?: Array<{ embedding?: unknown }> };
  return json.data?.[0]?.embedding;
}

function validateVector(raw: unknown, cfg: EmbeddingsConfig): number[] | null {
  const valid =
    Array.isArray(raw) &&
    raw.length === cfg.dims &&
    raw.every((v) => typeof v === "number" && Number.isFinite(v));
  if (!valid) {
    log("warn", "llm.embed_invalid", {
      model: cfg.model,
      expectedDims: cfg.dims,
      gotLength: Array.isArray(raw) ? raw.length : null,
    });
    return null;
  }
  return raw as number[];
}
