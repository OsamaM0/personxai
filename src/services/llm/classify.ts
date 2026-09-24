/**
 * Schema-constrained one-shot classification. Used for intent routing and
 * structured extraction where a null result must fall back to heuristics.
 */
import { generateObject } from "ai";
import type { ZodType } from "zod";
import type { LLMRoleConfig } from "../../config";
import type { Env } from "../../env";
import { formatError, log } from "../../utils/logger";
import { chatModel } from "./provider";

const DEFAULT_TIMEOUT_MS = 20_000;

export async function classifyJson<T>(opts: {
  schema: ZodType<T>;
  system: string;
  prompt: string;
  cfg: LLMRoleConfig;
  env: Env;
  timeoutMs?: number;
}): Promise<T | null> {
  try {
    // Explicit type args pin OUTPUT to "object": with a bare generic T the
    // default `InferSchema<SCHEMA> extends string ? "enum" : "object"` stays
    // an unresolved conditional and rejects the options shape.
    const result = await generateObject<ZodType<T>, "object", T>({
      model: chatModel(opts.cfg, opts.env),
      schema: opts.schema,
      system: opts.system,
      prompt: opts.prompt,
      abortSignal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    return result.object;
  } catch (err) {
    log("warn", "llm.classify_failed", {
      kind: opts.cfg.kind,
      model: opts.cfg.model,
      error: formatError(err),
    });
    return null;
  }
}
