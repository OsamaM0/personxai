/**
 * Money formatting and parsing for the wallet.
 *
 * Amounts are stored as numeric(14,2) and handled as JS numbers: a personal
 * ledger never approaches the 2^53 boundary, and every total is recomputed in
 * Postgres rather than accumulated in the client.
 */

/** Fallback when the user has never set one (the author's currency; /wallet currency changes it). */
export const DEFAULT_CURRENCY = "EGP";

/** Symbols and colloquial spellings → ISO-4217, so "25 LE" and "٢٥ جنيه" agree. */
const CURRENCY_ALIASES: Record<string, string> = {
  le: "EGP", "l.e": "EGP", "l.e.": "EGP", egp: "EGP", pound: "EGP", pounds: "EGP",
  جنيه: "EGP", "ج.م": "EGP", جنية: "EGP",
  $: "USD", usd: "USD", dollar: "USD", dollars: "USD", دولار: "USD",
  "€": "EUR", eur: "EUR", euro: "EUR", يورو: "EUR",
  "£": "GBP", gbp: "GBP",
  sar: "SAR", ريال: "SAR", aed: "AED", درهم: "AED", kwd: "KWD", qar: "QAR",
};

/**
 * Normalize a currency the user or the model supplied. Unknown codes are kept
 * (upper-cased) rather than rejected — a ledger should not lose an entry over
 * an unrecognised ticker.
 */
export function normalizeCurrency(raw: string | null | undefined): string {
  const text = (raw ?? "").trim();
  if (!text) return DEFAULT_CURRENCY;
  const alias = CURRENCY_ALIASES[text.toLowerCase()];
  if (alias) return alias;
  return text.toUpperCase().slice(0, 8);
}

/** Arabic-Indic digits arrive from Arabic keyboards; normalize before parsing. */
function latinDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (ch) => {
    const code = ch.charCodeAt(0);
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });
}

/**
 * Parse an amount from a number or a loose string ("25", "1,250.50", "٢٥").
 * Returns null for anything that is not a positive finite amount.
 */
export function parseAmount(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? round2(raw) : null;
  if (typeof raw !== "string") return null;
  const cleaned = latinDigits(raw).replace(/[\s,٬]/g, "").replace(/٫/g, ".");
  const match = cleaned.match(/-?\d+(\.\d+)?/);
  if (!match) return null;
  const value = Number.parseFloat(match[0]);
  return Number.isFinite(value) && value > 0 ? round2(value) : null;
}

/** Two decimal places, without the float dust of naive multiplication. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * "1,250.50 EGP" — Latin digits in every locale (the same choice the date
 * formatter makes), whole amounts without the trailing ".00".
 */
export function formatMoney(amount: number, currency: string): string {
  const value = round2(amount);
  const digits = Number.isInteger(value) ? 0 : 2;
  const formatted = new Intl.NumberFormat("en-GB", {
    minimumFractionDigits: digits,
    maximumFractionDigits: 2,
  }).format(value);
  return `${formatted} ${currency}`;
}

/** "2 kg sugar" — the quantity prefix, when the user gave one. */
export function formatQuantity(quantity: number | null, unit: string | null): string {
  if (quantity === null || quantity === undefined) return "";
  const value = Number.isInteger(quantity) ? String(quantity) : String(round2(quantity));
  return unit ? `${value} ${unit}` : value;
}
