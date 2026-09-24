/**
 * A small, total arithmetic evaluator.
 *
 * The model must never do sums in its head — a wrong total in a money ledger
 * is worse than no total at all — so every number it reports is produced here.
 * That means this parser has to be safe against anything an LLM (or a user)
 * types: no `eval`, no unbounded work, no NaN/Infinity leaking out as a
 * result, and an explicit error message for everything it will not evaluate.
 *
 * Grammar:
 *   expr    := term (('+' | '-') term)*
 *   term    := power (('*' | '/' | '%') power)*
 *   power   := unary ('^' power)?            -- right associative
 *   unary   := ('+' | '-') unary | postfix
 *   postfix := primary '%'?                  -- 25% is 0.25
 *   primary := number | '(' expr ')' | name '(' expr (',' expr)* ')'
 */
import { latinDigits, round2 } from "./money";

/** Long enough for a real shopping list, short enough to bound the work. */
const MAX_INPUT = 240;
const MAX_TOKENS = 200;
/** 2^64 is already past anything a personal ledger means; beyond it, ^ is a denial of service. */
const MAX_EXPONENT = 64;

export interface CalcSuccess {
  /** The normalized expression that was actually evaluated. */
  expression: string;
  result: number;
}

export type CalcOutcome = CalcSuccess | { error: string };

type Token =
  | { kind: "num"; value: number }
  | { kind: "name"; value: string }
  | { kind: "op"; value: string };

const FUNCTIONS: Record<string, { arity: [number, number]; apply: (args: number[]) => number }> = {
  min: { arity: [1, 16], apply: (a) => Math.min(...a) },
  max: { arity: [1, 16], apply: (a) => Math.max(...a) },
  sum: { arity: [1, 32], apply: (a) => a.reduce((x, y) => x + y, 0) },
  avg: { arity: [1, 32], apply: (a) => a.reduce((x, y) => x + y, 0) / a.length },
  abs: { arity: [1, 1], apply: (a) => Math.abs(a[0] as number) },
  round: {
    arity: [1, 2],
    apply: (a) => {
      const digits = Math.min(Math.max(Math.trunc(a[1] ?? 0), 0), 10);
      const factor = 10 ** digits;
      return Math.round((a[0] as number) * factor) / factor;
    },
  },
  floor: { arity: [1, 1], apply: (a) => Math.floor(a[0] as number) },
  ceil: { arity: [1, 1], apply: (a) => Math.ceil(a[0] as number) },
  sqrt: { arity: [1, 1], apply: (a) => Math.sqrt(a[0] as number) },
  pow: { arity: [2, 2], apply: (a) => (a[0] as number) ** (a[1] as number) },
};

export const CALC_FUNCTIONS = Object.keys(FUNCTIONS);

/**
 * Fold the ways people actually write arithmetic into the grammar above:
 * Arabic-Indic digits and separators, typographic operators, and the words
 * that carry an operator ("20% of 250", "3 x 4").
 */
function normalize(raw: string): string {
  let text = latinDigits(raw)
    .replace(/٫/g, ".")
    .replace(/[٬،]/g, ",")
    .replace(/[×✕✖]/g, "*")
    .replace(/÷/g, "/")
    .replace(/[−–—]/g, "-")
    .replace(/[[{]/g, "(")
    .replace(/[\]}]/g, ")")
    .replace(/=+\s*$/, "");
  // Word operators, whole-word only so "of" inside a function name is safe.
  text = text
    .replace(/\bof\b/gi, "*")
    .replace(/\bplus\b/gi, "+")
    .replace(/\bminus\b/gi, "-")
    .replace(/\btimes\b/gi, "*")
    .replace(/\bdivided\s+by\b/gi, "/")
    .replace(/(\d)\s*[xX]\s*(?=[\d(])/g, "$1*");
  return text.trim();
}

function tokenize(text: string): Token[] | { error: string } {
  // "1,250" is a thousands separator; "max(1, 250)" is an argument list. The
  // expression cannot mean both, so the presence of a function name decides.
  const hasCall = /[a-z]/i.test(text);
  const source = hasCall ? text : text.replace(/(\d),(?=\d{3}(\D|$))/g, "$1");
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      const match = /^\d*\.?\d+/.exec(source.slice(i));
      if (!match) return { error: `cannot read a number at "${source.slice(i, i + 8)}"` };
      tokens.push({ kind: "num", value: Number.parseFloat(match[0]) });
      i += match[0].length;
    } else if (/[a-z]/i.test(ch)) {
      const match = /^[a-z]+/i.exec(source.slice(i)) as RegExpExecArray;
      const name = match[0].toLowerCase();
      if (!(name in FUNCTIONS)) {
        return { error: `unknown function "${name}" — available: ${CALC_FUNCTIONS.join(", ")}` };
      }
      tokens.push({ kind: "name", value: name });
      i += match[0].length;
    } else if ("+-*/%^(),".includes(ch)) {
      tokens.push({ kind: "op", value: ch });
      i++;
    } else {
      return { error: `"${ch}" is not part of an arithmetic expression` };
    }
    if (tokens.length > MAX_TOKENS) return { error: "expression is too long to evaluate" };
  }
  return tokens;
}

/** A parsed value, plus whether it was written as a bare percentage. */
interface Value {
  value: number;
  /** True for "20%" alone, so "250 + 20%" can mean "add 20% of 250". */
  percent: boolean;
}

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private eatOp(...ops: string[]): string | null {
    const token = this.peek();
    if (token?.kind === "op" && ops.includes(token.value)) {
      this.pos++;
      return token.value;
    }
    return null;
  }

  atEnd(): boolean {
    return this.pos >= this.tokens.length;
  }

  /** The first unconsumed tokens, for the "trailing junk" message. */
  rest(): string {
    return this.tokens
      .slice(this.pos)
      .map((t) => (t.kind === "num" ? String(t.value) : t.value))
      .join(" ");
  }

  expr(): Value {
    let left = this.term();
    for (;;) {
      const op = this.eatOp("+", "-");
      if (!op) return left;
      const right = this.term();
      // "250 + 20%" is 300, the way every pocket calculator reads it.
      const delta = right.percent ? left.value * right.value : right.value;
      left = { value: op === "+" ? left.value + delta : left.value - delta, percent: false };
    }
  }

  private term(): Value {
    let left = this.power();
    for (;;) {
      const op = this.eatOp("*", "/", "%");
      if (!op) return left;
      const right = this.power();
      if (op === "*") {
        left = { value: left.value * right.value, percent: false };
      } else {
        if (right.value === 0) throw new Error("division by zero");
        left = {
          value: op === "/" ? left.value / right.value : left.value % right.value,
          percent: false,
        };
      }
    }
  }

  private power(): Value {
    const base = this.unary();
    if (!this.eatOp("^")) return base;
    const exponent = this.power();
    if (Math.abs(exponent.value) > MAX_EXPONENT) {
      throw new Error(`exponent larger than ${MAX_EXPONENT} is not supported`);
    }
    return { value: base.value ** exponent.value, percent: false };
  }

  private unary(): Value {
    const sign = this.eatOp("+", "-");
    if (sign) {
      const operand = this.unary();
      return { value: sign === "-" ? -operand.value : operand.value, percent: operand.percent };
    }
    return this.postfix();
  }

  private postfix(): Value {
    const base = this.primary();
    // A "%" with no operand after it is the percent suffix, not modulo.
    const next = this.tokens[this.pos];
    const after = this.tokens[this.pos + 1];
    const isSuffix =
      next?.kind === "op" &&
      next.value === "%" &&
      (after === undefined || (after.kind === "op" && ")+-*/^,".includes(after.value)));
    if (isSuffix) {
      this.pos++;
      return { value: base.value / 100, percent: true };
    }
    return base;
  }

  private primary(): Value {
    const token = this.peek();
    if (token === undefined) throw new Error("expression ends where a number was expected");
    if (token.kind === "num") {
      this.pos++;
      return { value: token.value, percent: false };
    }
    if (token.kind === "name") {
      this.pos++;
      const fn = FUNCTIONS[token.value] as (typeof FUNCTIONS)[string];
      if (!this.eatOp("(")) throw new Error(`${token.value} must be called like ${token.value}(...)`);
      const args: number[] = [];
      if (!this.eatOp(")")) {
        for (;;) {
          args.push(this.expr().value);
          if (this.eatOp(",")) continue;
          if (this.eatOp(")")) break;
          throw new Error(`unclosed call to ${token.value}(`);
        }
      }
      const [min, max] = fn.arity;
      if (args.length < min || args.length > max) {
        throw new Error(
          `${token.value} takes ${min === max ? min : `${min}-${max}`} argument(s), got ${args.length}`
        );
      }
      return { value: fn.apply(args), percent: false };
    }
    if (token.value === "(") {
      this.pos++;
      const inner = this.expr();
      if (!this.eatOp(")")) throw new Error("missing a closing parenthesis");
      return { value: inner.value, percent: false };
    }
    throw new Error(`"${token.value}" is not where a number can start`);
  }
}

/**
 * Evaluate an arithmetic expression. Never throws: an unparseable or
 * non-finite expression comes back as `{ error }` so a caller can hand the
 * reason straight to the user.
 */
export function calculate(input: string): CalcOutcome {
  const raw = (input ?? "").trim();
  if (!raw) return { error: "nothing to calculate" };
  if (raw.length > MAX_INPUT) return { error: `expression longer than ${MAX_INPUT} characters` };

  const expression = normalize(raw);
  const tokens = tokenize(expression);
  if ("error" in tokens) return tokens;
  if (tokens.length === 0) return { error: "nothing to calculate" };

  const parser = new Parser(tokens);
  let value: number;
  try {
    value = parser.expr().value;
    if (!parser.atEnd()) return { error: `unexpected "${parser.rest()}" after the expression` };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "could not evaluate that expression" };
  }
  if (!Number.isFinite(value)) return { error: "the result is not a finite number" };
  return { expression, result: value };
}

/**
 * The money-facing rounding: two decimals, which is also how amounts are
 * stored. Kept separate from `calculate` so a non-money calculation
 * (quantities, percentages) keeps its precision.
 */
export function calculateMoney(input: string): CalcOutcome {
  const outcome = calculate(input);
  if ("error" in outcome) return outcome;
  return { ...outcome, result: round2(outcome.result) };
}
