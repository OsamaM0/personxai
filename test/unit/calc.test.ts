import { describe, expect, it } from "vitest";
import { calculate, calculateMoney } from "../../src/utils/calc";

/** Unwrap a success, failing loudly if the expression was rejected. */
function value(expression: string): number {
  const outcome = calculate(expression);
  if ("error" in outcome) throw new Error(`${expression} → ${outcome.error}`);
  return outcome.result;
}

function error(expression: string): string {
  const outcome = calculate(expression);
  if (!("error" in outcome)) throw new Error(`${expression} unexpectedly evaluated`);
  return outcome.error;
}

describe("calculate", () => {
  it("applies the usual precedence and associativity", () => {
    expect(value("2 + 3 * 4")).toBe(14);
    expect(value("(2 + 3) * 4")).toBe(20);
    expect(value("100 - 20 - 30")).toBe(50);
    expect(value("2 ^ 3 ^ 2")).toBe(512); // right associative
    expect(value("-5 + 2")).toBe(-3);
    expect(value("10 / 4")).toBe(2.5);
    expect(value("10 % 3")).toBe(1);
  });

  it("reads money the way people type it", () => {
    expect(value("1,250.50 + 749.50")).toBe(2000);
    expect(value("25 * 2")).toBe(50);
    expect(value("١٢٥ + ٢٥")).toBe(150);
    expect(value("١٢٫٥ * 2")).toBe(25);
  });

  it("treats a trailing percent as a fraction, and a percent term as a share of the left side", () => {
    expect(value("20%")).toBeCloseTo(0.2);
    expect(value("20% of 250")).toBe(50);
    expect(value("250 + 14%")).toBe(285);
    expect(value("1200 - 15%")).toBe(1020);
    // Modulo still works where a percent sign sits between two numbers.
    expect(value("17 % 5")).toBe(2);
  });

  it("supports the aggregate helpers a ledger needs", () => {
    expect(value("sum(120, 80, 45)")).toBe(245);
    expect(value("avg(10, 20, 30)")).toBe(20);
    expect(value("max(3, 9, 4) - min(3, 9, 4)")).toBe(6);
    expect(value("round(10/3, 2)")).toBe(3.33);
    expect(value("sum(1200, 800) / 4")).toBe(500);
  });

  it("accepts typographic and word operators", () => {
    expect(value("6 × 7")).toBe(42);
    expect(value("84 ÷ 2")).toBe(42);
    expect(value("3 x 4")).toBe(12);
    expect(value("10 plus 5 minus 3")).toBe(12);
    expect(value("12 divided by 4")).toBe(3);
  });

  it("refuses anything that is not arithmetic, instead of guessing", () => {
    expect(error("")).toMatch(/nothing to calculate/);
    expect(error("2 +")).toMatch(/expected/);
    expect(error("(2 + 3")).toMatch(/closing parenthesis/);
    expect(error("2 + 2 apples")).toMatch(/unknown function/);
    expect(error("fetch(1)")).toMatch(/unknown function/);
    expect(error("1 / 0")).toMatch(/division by zero/);
    expect(error("10 ^ 400")).toMatch(/exponent/);
    expect(error("x".repeat(300))).toMatch(/longer than/);
  });

  it("never returns a non-finite number", () => {
    expect(error("sqrt(0-4)")).toMatch(/not a finite number/);
  });

  it("echoes the normalized expression it actually evaluated", () => {
    const outcome = calculate("١٠ × 3");
    expect(outcome).toEqual({ expression: "10 * 3", result: 30 });
  });
});

describe("calculateMoney", () => {
  it("rounds to the two decimals amounts are stored in", () => {
    const outcome = calculateMoney("10 / 3");
    expect(outcome).toEqual({ expression: "10 / 3", result: 3.33 });
  });

  it("passes errors through unchanged", () => {
    expect(calculateMoney("1/0")).toEqual({ error: "division by zero" });
  });
});
