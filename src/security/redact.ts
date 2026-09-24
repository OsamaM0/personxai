/**
 * Redaction for persisted tool telemetry (tool_calls.args / result_summary).
 * Tighter than the logger's redaction: tool args land in the database, so
 * strings cap at 200 chars and arrays at 10 items.
 */

import { redactObject } from "../utils/logger";
import { truncate } from "../utils/text";

const MAX_STRING_CHARS = 200;
const MAX_ARRAY_ITEMS = 10;

/** Deep-redact tool args: sensitive keys masked, strings/arrays tightly capped. */
export function redactToolArgs(args: unknown): unknown {
  // redactObject already bounds depth, so this second pass cannot recurse forever.
  return tighten(redactObject(args));
}

function tighten(value: unknown): unknown {
  if (typeof value === "string") return truncate(value, MAX_STRING_CHARS);
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_ITEMS).map(tighten);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = tighten(v);
    }
    return out;
  }
  return value;
}

/** Compact string form of a tool result for storage/log lines. */
export function summarizeToolResult(result: unknown, maxChars: number): string {
  let text: string;
  try {
    // JSON.stringify yields undefined for undefined/functions/symbols.
    text = JSON.stringify(result) ?? String(result);
  } catch {
    // Circular structures and BigInt throw.
    text = String(result);
  }
  return truncate(text, maxChars);
}
