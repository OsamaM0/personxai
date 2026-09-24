/**
 * Wallet ledger: money in and money out, with the totals computed in Postgres.
 *
 * Every read re-filters by user_id (service role bypasses RLS) and skips soft
 * deleted rows, so a corrected entry disappears from history and from totals
 * at the same moment.
 */
import { dbError, type Db } from "../client";
import type {
  Enums,
  TablesInsert,
  TablesUpdate,
  WalletEntryRow,
} from "../types";
import { getSetting, setSetting } from "./settings";
import { normalizeCurrency } from "../../utils/money";

export type WalletDirection = Enums<"wallet_direction">;

export interface WalletFilter {
  direction?: WalletDirection;
  category?: string;
  query?: string;
  tags?: string[];
  projectId?: string;
  currency?: string;
  /** Inclusive, ISO UTC. */
  from?: string | null;
  /** Exclusive, ISO UTC. */
  to?: string | null;
  limit?: number;
}

export interface WalletTotals {
  currency: string;
  moneyIn: number;
  moneyOut: number;
  net: number;
  entries: number;
}

export interface WalletCategoryTotal {
  category: string | null;
  currency: string;
  direction: WalletDirection;
  total: number;
  entries: number;
}

export async function createWalletEntry(
  db: Db,
  row: TablesInsert<"wallet_entries">
): Promise<WalletEntryRow> {
  const { data, error } = await db.from("wallet_entries").insert(row).select().single();
  if (error) throw dbError("wallet_entries", "insert", error);
  return data;
}

export async function listWalletEntries(
  db: Db,
  userId: string,
  filter: WalletFilter = {}
): Promise<WalletEntryRow[]> {
  let q = db.from("wallet_entries").select("*").eq("user_id", userId).is("deleted_at", null);
  if (filter.direction) q = q.eq("direction", filter.direction);
  if (filter.category) q = q.eq("category", filter.category);
  if (filter.currency) q = q.eq("currency", filter.currency);
  if (filter.projectId) q = q.eq("project_id", filter.projectId);
  if (filter.tags?.length) q = q.contains("tags", filter.tags);
  if (filter.from) q = q.gte("occurred_at", filter.from);
  if (filter.to) q = q.lt("occurred_at", filter.to);
  if (filter.query) {
    const escaped = filter.query.replace(/[\%_]/g, (m) => `\${m}`);
    q = q.or(`description.ilike.%${escaped}%,category.ilike.%${escaped}%,note.ilike.%${escaped}%`);
  }
  const { data, error } = await q
    .order("occurred_at", { ascending: false })
    .limit(filter.limit ?? 50);
  if (error) throw dbError("wallet_entries", "list", error);
  return data ?? [];
}

export async function getWalletEntry(
  db: Db,
  userId: string,
  entryId: string
): Promise<WalletEntryRow | null> {
  const { data, error } = await db
    .from("wallet_entries")
    .select("*")
    .eq("user_id", userId)
    .eq("id", entryId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw dbError("wallet_entries", "get", error);
  return data;
}

export async function updateWalletEntry(
  db: Db,
  userId: string,
  entryId: string,
  patch: TablesUpdate<"wallet_entries">
): Promise<boolean> {
  const { data, error } = await db
    .from("wallet_entries")
    .update(patch)
    .eq("user_id", userId)
    .eq("id", entryId)
    .is("deleted_at", null)
    .select("id");
  if (error) throw dbError("wallet_entries", "update", error);
  return (data?.length ?? 0) > 0;
}

/** Soft delete — a mistyped amount stays recoverable, and totals drop it at once. */
export async function deleteWalletEntry(
  db: Db,
  userId: string,
  entryId: string
): Promise<boolean> {
  const { data, error } = await db
    .from("wallet_entries")
    .update({ deleted_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("id", entryId)
    .is("deleted_at", null)
    .select("id");
  if (error) throw dbError("wallet_entries", "delete", error);
  return (data?.length ?? 0) > 0;
}

/** In / out / net per currency over a half-open window (nulls = all time). */
export async function walletSummary(
  db: Db,
  userId: string,
  range: { from?: string | null; to?: string | null } = {}
): Promise<WalletTotals[]> {
  const { data, error } = await db.rpc("wallet_summary", {
    p_user_id: userId,
    p_from: range.from ?? null,
    p_to: range.to ?? null,
  });
  if (error) throw dbError("wallet_summary", "rpc", error);
  // numeric/bigint cross the wire as JSON numbers today, but coerce anyway:
  // a driver that switches to strings must not turn totals into concatenation.
  return (data ?? []).map((row) => ({
    currency: row.currency,
    moneyIn: Number(row.money_in),
    moneyOut: Number(row.money_out),
    net: Number(row.net),
    entries: Number(row.entries),
  }));
}

/** Where the money goes: one row per category, biggest first. */
export async function walletCategoryTotals(
  db: Db,
  userId: string,
  options: {
    direction?: WalletDirection;
    from?: string | null;
    to?: string | null;
    limit?: number;
  } = {}
): Promise<WalletCategoryTotal[]> {
  const { data, error } = await db.rpc("wallet_category_totals", {
    p_user_id: userId,
    p_direction: options.direction ?? null,
    p_from: options.from ?? null,
    p_to: options.to ?? null,
    p_limit: options.limit ?? 20,
  });
  if (error) throw dbError("wallet_category_totals", "rpc", error);
  return (data ?? []).map((row) => ({
    category: row.category === "" ? null : row.category,
    currency: row.currency,
    direction: row.direction,
    total: Number(row.total),
    entries: Number(row.entries),
  }));
}

/** Settings key holding the currency new entries default to. */
export const WALLET_CURRENCY_KEY = "wallet.currency";

/** The user's default currency — what "25" means when they don't name one. */
export async function walletCurrency(db: Db, userId: string): Promise<string> {
  const stored = await getSetting<string>(db, userId, WALLET_CURRENCY_KEY).catch(() => null);
  return normalizeCurrency(typeof stored === "string" ? stored : null);
}

export async function setWalletCurrency(db: Db, userId: string, currency: string): Promise<string> {
  const normalized = normalizeCurrency(currency);
  await setSetting(db, userId, WALLET_CURRENCY_KEY, normalized);
  return normalized;
}
