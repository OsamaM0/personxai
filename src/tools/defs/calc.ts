import { z } from "zod";
import { defineTool } from "../registry";
import { CALC_FUNCTIONS, calculate } from "../../utils/calc";
import { formatMoney, normalizeCurrency, round2 } from "../../utils/money";

/**
 * Arithmetic as a tool call.
 *
 * Language models are unreliable at multi-step arithmetic and completely
 * unaccountable about it — the wrong total arrives with the same confidence as
 * the right one. Routing every sum through here means a number the user sees
 * either came from Postgres (the wallet aggregates) or from this evaluator,
 * and in both cases it can be re-derived. The system prompt forbids mental
 * arithmetic; this is what it forbids it in favour of.
 */
/** Grouped, at most four decimals — Latin digits in every locale, like formatMoney. */
const PLAIN = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 4 });

export const calculateTool = defineTool({
  name: "calculate",
  description: [
    "Evaluate arithmetic. Use this for EVERY calculation — totals, differences, splits, percentages,",
    "unit prices, budgets left — instead of computing in your head, even for sums that look easy.",
    `Supports + - * / % ^, parentheses, percentages ("250 + 14%", "20% of 250"), and`,
    `${CALC_FUNCTIONS.join(", ")}. Pass a currency to get the result formatted as money.`,
  ].join(" "),
  inputSchema: z.object({
    expression: z
      .string()
      .min(1)
      .max(240)
      .describe(`the arithmetic only, no words: "25*2 + 13.5", "sum(120, 80, 45)/3", "1200 - 15%"`),
    currency: z
      .string()
      .max(20)
      .optional()
      .describe("format the result as money in this currency (ISO code or what the user said)"),
    label: z.string().max(80).optional().describe("what this number is, for your own reply"),
  }),
  topics: [],
  permissionLevel: "read",
  execute: async (input) => {
    const outcome = calculate(input.expression);
    if ("error" in outcome) {
      return { error: `cannot evaluate "${input.expression}": ${outcome.error}` };
    }
    const currency = input.currency ? normalizeCurrency(input.currency) : null;
    // Money is rounded to the two decimals it is stored in; anything else keeps
    // its precision and is only rounded for display.
    const result = currency ? round2(outcome.result) : outcome.result;
    return {
      expression: outcome.expression,
      result,
      formatted: currency ? formatMoney(result, currency) : PLAIN.format(result),
      ...(input.label ? { label: input.label } : {}),
    };
  },
});
