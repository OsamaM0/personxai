/**
 * Chat-model construction for both LLM provider kinds.
 *
 * Every role in AppConfig (main, classifier, vision, stt) resolves to either
 * an OpenAI-compatible HTTP endpoint or a Workers AI binding model; this is
 * the single place that turns an LLMRoleConfig into an AI SDK LanguageModel.
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createWorkersAI } from "workers-ai-provider";
import type { LanguageModel } from "ai";
import type { LLMRoleConfig } from "../../config";
import type { Env } from "../../env";

/**
 * Fields some providers *emit* on assistant messages but reject when they are
 * *sent back* in history. Reasoning models (Groq's gpt-oss, DeepSeek-R1, Qwen
 * thinking variants) all do this, and the failure only appears on the second
 * step of a tool call — i.e. exactly when the assistant is doing real work.
 */
const ECHO_REJECTED_FIELDS = ["reasoning_content", "reasoning", "thinking"] as const;

function stripEchoRejectedFields(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body; // not JSON we understand; forward untouched
  }
  const payload = parsed as { messages?: Record<string, unknown>[] };
  if (!Array.isArray(payload.messages)) return body;

  let touched = false;
  for (const message of payload.messages) {
    if (!message || message["role"] !== "assistant") continue;
    for (const field of ECHO_REJECTED_FIELDS) {
      if (field in message) {
        delete message[field];
        touched = true;
      }
    }
  }
  return touched ? JSON.stringify(payload) : body;
}

/** fetch wrapper that sanitizes outgoing chat-completion request bodies. */
const sanitizingFetch: typeof fetch = async (input, init) => {
  if (init?.body && typeof init.body === "string") {
    return fetch(input, { ...init, body: stripEchoRejectedFields(init.body) });
  }
  return fetch(input, init);
};

export function chatModel(cfg: LLMRoleConfig, env: Env): LanguageModel {
  if (cfg.kind === "openai-compatible") {
    const provider = createOpenAICompatible({
      name: "custom",
      baseURL: cfg.baseURL,
      apiKey: cfg.apiKey,
      fetch: sanitizingFetch,
    });
    return provider.chatModel(cfg.model);
  }
  // workers-ai-provider accepts any string model id (typed autocomplete only
  // covers known @cf/ ids), so the runtime-configured id passes as-is.
  const workersAI = createWorkersAI({ binding: env.AI });
  return workersAI.chat(cfg.model);
}

/** Exported for tests. */
export const __internal = { stripEchoRejectedFields };
