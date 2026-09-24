/**
 * Token-usage accumulation across an agent run.
 *
 * AI SDK v7 reports `inputTokens`/`outputTokens` (LanguageModelUsage, fields
 * `number | undefined`); some providers/older shapes use
 * `promptTokens`/`completionTokens`. Both are tolerated, defaulting to 0.
 */
export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
}

export class UsageAccumulator {
  private prompt = 0;
  private completion = 0;

  add(usage: unknown): void {
    if (typeof usage !== "object" || usage === null) return;
    const u = usage as Record<string, unknown>;
    this.prompt += firstFiniteNumber(u.inputTokens, u.promptTokens);
    this.completion += firstFiniteNumber(u.outputTokens, u.completionTokens);
  }

  totals(): UsageTotals {
    return { promptTokens: this.prompt, completionTokens: this.completion };
  }
}

function firstFiniteNumber(...values: unknown[]): number {
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return 0;
}
