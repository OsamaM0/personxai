/**
 * Structured logging with redaction. Workers `console.log` feeds Cloudflare
 * observability; keep entries single-line JSON.
 */

const SENSITIVE_KEY_RE = /token|secret|key|password|authorization|api_key|apikey/i;

export function redactObject(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[depth]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.length > 500 ? `${value.slice(0, 500)}…[${value.length}]` : value;
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redactObject(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY_RE.test(k) ? "[redacted]" : redactObject(v, depth + 1);
  }
  return out;
}

/** Error → readable string, following the `cause` chain (AI SDK errors stringify poorly). */
export function formatError(err: unknown, depth = 0): string {
  if (depth > 5) return "…";
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    const causeStr = cause ? ` <- ${formatError(cause, depth + 1)}` : "";
    return `${err.name}: ${err.message}${causeStr}`;
  }
  if (typeof err === "object" && err !== null) {
    try {
      return JSON.stringify(err).slice(0, 500);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

export function log(
  level: "info" | "warn" | "error",
  event: string,
  fields?: Record<string, unknown>
): void {
  const entry = { level, event, ...(fields ? (redactObject(fields) as Record<string, unknown>) : {}) };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
