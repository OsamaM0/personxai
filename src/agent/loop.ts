/**
 * The LLM turn loop: one generateText call with tool-step iteration, guarded by
 * step count, timeout, and (per-tool) budgets enforced in the tool wrappers.
 */
import { generateText, stepCountIs } from "ai";
import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import { UsageAccumulator, type UsageTotals } from "../services/llm/usage";
import { formatError, log } from "../utils/logger";

export interface TurnResult {
  text: string;
  iterations: number;
  toolCallCount: number;
  usage: UsageTotals;
  error?: string;
}

export async function runLlmTurn(opts: {
  model: LanguageModel;
  system: string;
  messages: ModelMessage[];
  tools?: ToolSet;
  maxIterations: number;
  timeoutMs: number;
}): Promise<TurnResult> {
  const usage = new UsageAccumulator();
  try {
    const result = await generateText({
      model: opts.model,
      system: opts.system,
      messages: opts.messages,
      ...(opts.tools && Object.keys(opts.tools).length > 0 ? { tools: opts.tools } : {}),
      stopWhen: stepCountIs(opts.maxIterations),
      abortSignal: AbortSignal.timeout(opts.timeoutMs),
    });
    let toolCallCount = 0;
    for (const step of result.steps) {
      usage.add(step.usage);
      toolCallCount += step.toolCalls?.length ?? 0;
    }
    return {
      text: result.text ?? "",
      iterations: result.steps.length,
      toolCallCount,
      usage: usage.totals(),
    };
  } catch (err) {
    const msg = formatError(err);
    log("error", "llm_turn_failed", { error: msg });
    return { text: "", iterations: 0, toolCallCount: 0, usage: usage.totals(), error: msg };
  }
}
