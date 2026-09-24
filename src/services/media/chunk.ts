/** Chunking for RAG: ~size chars per chunk with overlap, preferring paragraph breaks. */
export function chunkForEmbedding(
  text: string,
  opts: { size?: number; overlap?: number; maxChunks?: number } = {}
): string[] {
  const size = opts.size ?? 1200;
  const overlap = Math.min(opts.overlap ?? 150, Math.floor(size / 2));
  const maxChunks = opts.maxChunks ?? 200;
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (clean.length === 0) return [];
  if (clean.length <= size) return [clean];

  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length && chunks.length < maxChunks) {
    let end = Math.min(start + size, clean.length);
    if (end < clean.length) {
      // prefer to break on a paragraph, then a sentence, then a space
      const window = clean.slice(start, end);
      const para = window.lastIndexOf("\n\n");
      const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf("۔"), window.lastIndexOf("؟"));
      const space = window.lastIndexOf(" ");
      const cut = para > size * 0.4 ? para : sentence > size * 0.4 ? sentence + 1 : space > size * 0.4 ? space : window.length;
      end = start + cut;
    }
    chunks.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks.filter((c) => c.length > 0);
}
