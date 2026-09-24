/** Truncate to n chars, appending a marker when cut. */
export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, Math.max(0, n - 1))}…`;
}

/** Clamp an LLM-supplied limit into [1, max] with a fallback for non-numbers. */
export function safeLimit(raw: unknown, fallback: number, max: number): number {
  const n = typeof raw === "number" ? Math.trunc(raw) : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Strip markdown formatting chars — used as the plain-text fallback for failed sends. */
export function stripMarkdown(s: string): string {
  return s.replace(/[*_`~[\]]/g, "");
}

/** Split text into chunks of at most `size` chars, preferring newline boundaries. */
export function chunkText(s: string, size: number): string[] {
  if (s.length <= size) return [s];
  const chunks: string[] = [];
  let rest = s;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size * 0.5) cut = size;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Strip control chars and filesystem-hostile chars from a filename. */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .split("")
    .filter((ch) => ch.charCodeAt(0) >= 0x20)
    .join("")
    .replace(/[/\\:*?"<>|]/g, "")
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 255) : "file";
}

/** Extract http(s) URLs from free text. */
export function extractUrls(text: string): string[] {
  const re = /https?:\/\/[^\s<>()"']+/g;
  return [...new Set(text.match(re) ?? [])];
}

/** Normalize tags: lowercase, trim, collapse whitespace, dedupe preserving order. */
export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const norm = t.toLowerCase().trim().replace(/\s+/g, "-");
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }
  return out;
}

/** Stable content hash (FNV-1a, hex) — used for classification caches / same-turn dedup. */
export function contentHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
