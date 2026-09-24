import { ar } from "./locales/ar";
import { arEG } from "./locales/ar-eg";
import { en } from "./locales/en";

export type Locale = "en" | "ar" | "ar-EG";

/** Keys of the base (English) catalog — the complete message key set. */
export type MessageKey = keyof typeof en;

const CATALOGS: Record<Locale, Partial<Record<MessageKey, string>>> = {
  en,
  ar,
  "ar-EG": arEG,
};

/** Lookup order per locale: ar-EG → ar → en. */
const FALLBACK_CHAIN: Record<Locale, readonly Locale[]> = {
  en: ["en"],
  ar: ["ar", "en"],
  "ar-EG": ["ar-EG", "ar", "en"],
};

/** Map a raw language tag (Telegram language_code, stored setting) to a supported locale. */
export function resolveLocale(raw: string | undefined | null): Locale {
  if (!raw) return "en";
  // Tags arrive in mixed shapes ("ar-EG", "AR_EG", "en-US"); compare case-insensitively.
  const tag = raw.trim().toLowerCase().replace(/_/g, "-");
  if (tag === "ar-eg") return "ar-EG";
  if (tag.startsWith("ar")) return "ar";
  return "en";
}

/** Translate a message key, walking the locale fallback chain and interpolating {name} params. */
export function t(locale: Locale, key: MessageKey, params?: Record<string, string | number>): string {
  let template: string | undefined;
  for (const step of FALLBACK_CHAIN[locale]) {
    template = CATALOGS[step][key];
    if (template !== undefined) break;
  }
  // en is complete, so the key itself only surfaces if a catalog regresses.
  const message = template ?? key;
  if (!params) return message;
  return message.replace(/\{(\w+)\}/g, (match: string, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/** BCP 47 tag for Intl: Arabic output keeps Latin (ASCII) digits via the nu-latn extension. */
function intlTag(locale: Locale): string {
  return locale === "en" ? "en-GB" : "ar-EG-u-nu-latn";
}

function toDate(iso: string | Date): Date {
  return typeof iso === "string" ? new Date(iso) : iso;
}

function makeFormatter(locale: Locale, timezone: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(intlTag(locale), { ...opts, timeZone: timezone });
  } catch {
    // A stored user timezone can go stale/invalid; degrade to UTC rather than throw mid-reply.
    return new Intl.DateTimeFormat(intlTag(locale), { ...opts, timeZone: "UTC" });
  }
}

/** Localized date + time, e.g. "15 Mar 2026, 14:34" / "15 مارس 2026 في 2:34 م" (Latin digits). */
export function formatDateTime(iso: string | Date, timezone: string, locale: Locale): string {
  return makeFormatter(locale, timezone, { dateStyle: "medium", timeStyle: "short" }).format(toDate(iso));
}

/** Localized date only, e.g. "15 Mar 2026". */
export function formatDate(iso: string | Date, timezone: string, locale: Locale): string {
  return makeFormatter(locale, timezone, { dateStyle: "medium" }).format(toDate(iso));
}

export function isRtl(locale: Locale): boolean {
  return locale === "ar" || locale === "ar-EG";
}
