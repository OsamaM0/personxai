/**
 * Document text extraction. Primary: Workers AI Markdown Conversion
 * (env.AI.toMarkdown — PDFs, images, HTML, CSV, spreadsheets). Fallback:
 * unpdf for PDFs; direct decode for text-ish mimes. Extraction is best-effort;
 * failures mark the file 'failed' and never break ingestion.
 */
import type { Env } from "../../env";
import { log, formatError } from "../../utils/logger";

const TEXT_MIME_RE = /^(text\/|application\/(json|xml|x-yaml|yaml|toml))/i;
const TEXT_EXT_RE = /\.(txt|md|markdown|csv|json|xml|yaml|yml|log|srt)$/i;

export const EXTRACTABLE_MIME_RE =
  /^(text\/|application\/(pdf|json|xml|x-yaml|yaml)|image\/(png|jpe?g|webp|svg))/i;

export interface ExtractResult {
  text: string;
  method: "text" | "toMarkdown" | "unpdf";
}

export function isExtractable(mime: string | undefined, fileName: string): boolean {
  if (mime && EXTRACTABLE_MIME_RE.test(mime)) return true;
  return TEXT_EXT_RE.test(fileName) || /\.pdf$/i.test(fileName);
}

export async function extractText(
  env: Env,
  data: ArrayBuffer,
  opts: { mime: string; fileName: string; maxChars: number }
): Promise<ExtractResult | null> {
  const { mime, fileName, maxChars } = opts;

  if (TEXT_MIME_RE.test(mime) || TEXT_EXT_RE.test(fileName)) {
    try {
      const text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(data).slice(0, maxChars);
      if (text.trim().length > 0) return { text, method: "text" };
    } catch {
      // fall through
    }
  }

  // Workers AI Markdown Conversion (free with Workers AI).
  try {
    const ai = env.AI as unknown as {
      toMarkdown?: (
        files: { name: string; blob: Blob }[]
      ) => Promise<{ name: string; data: string }[]>;
    };
    if (typeof ai.toMarkdown === "function") {
      const results = await ai.toMarkdown([
        { name: fileName, blob: new Blob([data], { type: mime || "application/octet-stream" }) },
      ]);
      const text = results?.[0]?.data;
      if (typeof text === "string" && text.trim().length > 0) {
        return { text: text.slice(0, maxChars), method: "toMarkdown" };
      }
    }
  } catch (err) {
    log("warn", "to_markdown_failed", { fileName, error: formatError(err) });
  }

  if (/pdf/i.test(mime) || /\.pdf$/i.test(fileName)) {
    try {
      const { extractText: unpdfExtract, getDocumentProxy } = await import("unpdf");
      const pdf = await getDocumentProxy(new Uint8Array(data));
      const { text } = await unpdfExtract(pdf, { mergePages: true });
      const merged = Array.isArray(text) ? text.join("\n") : text;
      if (merged.trim().length > 0) return { text: merged.slice(0, maxChars), method: "unpdf" };
    } catch (err) {
      log("warn", "unpdf_failed", { fileName, error: formatError(err) });
    }
  }

  return null;
}
