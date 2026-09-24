/**
 * Telegram-flavoured Markdown → WhatsApp formatting.
 *
 * The core writes replies in Telegram's legacy Markdown (*bold*, _italic_,
 * `code`, [label](url)). WhatsApp renders *bold*, _italic_, ~strike~, `code`
 * and ```blocks``` natively but has no link syntax or headings, so only the
 * constructs it cannot show are rewritten; everything else passes through.
 */
export function toWhatsAppMarkdown(text: string): string {
  const parts = text.split(/(```[\s\S]*?```)/g);
  return parts
    .map((part, i) => (i % 2 === 1 ? part : convertProse(part)))
    .join("");
}

function convertProse(text: string): string {
  return (
    text
      // **bold** / __bold__ (CommonMark) → *bold*
      .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "*$1*")
      .replace(/__(?=\S)([\s\S]*?\S)__/g, "*$1*")
      // ~~strike~~ → ~strike~
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "~$1~")
      // [label](url) → label (url); a bare [url](url) collapses to the url
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, url: string) =>
        label.trim() === url ? url : `${label} (${url})`
      )
      // # Heading → *Heading*
      .replace(/^#{1,6}\s+(.+?)\s*#*\s*$/gm, "*$1*")
      // Telegram-style "* item" bullets → "• item" (a leading * would open bold)
      .replace(/^(\s*)\*\s+/gm, "$1• ")
  );
}

/** Button titles and list rows have hard character caps; cut on a word when possible. */
export function clampLabel(label: string, max: number): string {
  const trimmed = label.trim();
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.lastIndexOf(" ", max - 1);
  return `${trimmed.slice(0, cut >= Math.floor(max / 2) ? cut : max - 1).trimEnd()}…`;
}
