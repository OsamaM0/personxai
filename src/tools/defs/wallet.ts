import { z } from "zod";
import { defineTool } from "../registry";
import {
  createWalletEntry,
  deleteWalletEntry,
  getWalletEntry,
  listWalletEntries,
  updateWalletEntry,
  walletCategoryTotals,
  walletCurrency,
  walletSummary,
  type WalletDirection,
} from "../../database/repos/wallet";
import { insertAudit } from "../../database/repos/audit";
import { normalizeTags, truncate } from "../../utils/text";
import { formatMoney, formatQuantity, normalizeCurrency, parseAmount } from "../../utils/money";
import { localPeriodRange, type LocalPeriod } from "../../scheduler/tz";
import { formatDate } from "../../i18n";
import type { AgentContext } from "../../agent/context";
import { parseUserDateTime, resolveProjectRef } from "./util";

const PERIODS = ["today", "yesterday", "week", "month", "year", "all"] as const;

/** Categories stay short and lowercase so totals group instead of fragmenting. */
function normalizeCategory(raw: string | undefined | null): string | null {
  const text = (raw ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return text ? text.slice(0, 40) : null;
}

/**
 * When the entry happened. A bare date means local midnight, so an entry
 * back-dated to yesterday lands inside yesterday's window; no value means now.
 */
function occurredAt(
  value: string | undefined,
  ctx: AgentContext
): { iso: string } | { error: string } {
  if (!value) return { iso: ctx.now.toISOString() };
  const trimmed = value.trim();
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00` : trimmed;
  const parsed = parseUserDateTime(normalized, ctx.user.timezone);
  if ("error" in parsed) return { error: parsed.error };
  return { iso: parsed.date.toISOString() };
}

const entryShape = {
  description: z
    .string()
    .min(1)
    .max(300)
    .describe("what the money was for, in the user's own words: '2 kg sugar', 'October salary'"),
  amount: z.union([z.number(), z.string()]).describe("how much, a positive number (25, 1250.50)"),
  currency: z
    .string()
    .max(20)
    .optional()
    .describe("ISO code or what the user said (LE, EGP, dollar); defaults to their wallet currency"),
  category: z
    .string()
    .max(40)
    .optional()
    .describe("one short lowercase bucket: groceries, transport, rent, salary, freelance"),
  quantity: z.number().positive().optional().describe("units bought, when the user said so (the 2 in '2 kg sugar')"),
  unit: z.string().max(20).optional().describe("unit for quantity: kg, litre, piece, hour"),
  method: z.string().max(30).optional().describe("cash, card, bank, instapay — only when mentioned"),
  when: z
    .string()
    .optional()
    .describe("user-LOCAL YYYY-MM-DD or YYYY-MM-DDTHH:mm; omit for now, call current_time for relative phrases"),
  project: z.string().optional().describe("project name/slug/id, when the money belongs to one"),
  tags: z.array(z.string()).max(10).optional(),
  note: z.string().max(500).optional(),
};

interface EntryInput {
  description: string;
  amount: number | string;
  currency?: string;
  category?: string;
  quantity?: number;
  unit?: string;
  method?: string;
  when?: string;
  project?: string;
  tags?: string[];
  note?: string;
}

/** Shared body of record_expense / record_income. */
async function record(
  direction: WalletDirection,
  input: EntryInput,
  ctx: AgentContext
): Promise<unknown> {
  const amount = parseAmount(input.amount);
  if (amount === null) return { error: `"${input.amount}" is not a positive amount` };

  const at = occurredAt(input.when, ctx);
  if ("error" in at) return { error: at.error };

  const { project, notFound } = await resolveProjectRef(ctx, input.project);
  if (notFound) return { error: `no project matching "${notFound}"` };

  const currency = input.currency
    ? normalizeCurrency(input.currency)
    : await walletCurrency(ctx.db, ctx.user.id);

  const row = await createWalletEntry(ctx.db, {
    user_id: ctx.user.id,
    direction,
    amount,
    currency,
    description: input.description.trim(),
    category: normalizeCategory(input.category),
    quantity: input.quantity ?? null,
    unit: input.unit?.trim() || null,
    method: input.method?.trim().toLowerCase() || null,
    occurred_at: at.iso,
    project_id: project?.id ?? null,
    tags: normalizeTags(input.tags ?? []),
    note: input.note?.trim() || null,
    source: "chat",
  });

  await insertAudit(ctx.db, {
    user_id: ctx.user.id,
    actor: "agent",
    action: `wallet.${direction === "out" ? "expense" : "income"}`,
    entity_id: row.id,
    details: { amount, currency, category: row.category },
  });

  // The month total is what the user wants to hear next ("that's 1,430 EGP
  // this month"), and it costs one indexed aggregate.
  const month = localPeriodRange("month", ctx.user.timezone, ctx.now);
  const totals = await walletSummary(ctx.db, ctx.user.id, month).catch(() => []);
  const forCurrency = totals.find((t) => t.currency === currency);

  return {
    recorded: true,
    entryId: row.id,
    direction,
    amount: formatMoney(amount, currency),
    description: row.description,
    category: row.category,
    quantity: formatQuantity(row.quantity, row.unit) || null,
    when: formatDate(row.occurred_at, ctx.user.timezone, ctx.locale),
    monthToDate: forCurrency
      ? {
          spent: formatMoney(forCurrency.moneyOut, currency),
          received: formatMoney(forCurrency.moneyIn, currency),
          net: formatMoney(forCurrency.net, currency),
        }
      : null,
  };
}

export const walletTools = [
  defineTool({
    name: "record_expense",
    description:
      "Log money the user SPENT (bought, paid). One entry per purchase: '2 kg sugar for 25 LE' becomes description '2 kg sugar', amount 25, quantity 2, unit kg, category groceries.",
    inputSchema: z.object(entryShape),
    topics: ["wallet"],
    permissionLevel: "write",
    isCreate: true,
    confirmLabel: (i) => `Log expense ${i.amount} for "${truncate(i.description, 50)}"`,
    execute: (input, ctx) => record("out", input, ctx),
  }),

  defineTool({
    name: "record_income",
    description:
      "Log money the user RECEIVED (salary, payment, refund, gift). Same fields as record_expense.",
    inputSchema: z.object(entryShape),
    topics: ["wallet"],
    permissionLevel: "write",
    isCreate: true,
    confirmLabel: (i) => `Log income ${i.amount} from "${truncate(i.description, 50)}"`,
    execute: (input, ctx) => record("in", input, ctx),
  }),

  defineTool({
    name: "list_wallet_entries",
    description:
      "The wallet history: every expense and income, newest first. Filter by direction, category, text, tag, project, or period (today/yesterday/week/month/year/all).",
    inputSchema: z.object({
      direction: z.enum(["in", "out"]).optional().describe("'out' = spending, 'in' = income; omit for both"),
      period: z.enum(PERIODS).optional().describe("defaults to month"),
      category: z.string().max(40).optional(),
      query: z.string().max(120).optional().describe("text to match in description/category/note"),
      tag: z.string().optional(),
      project: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    topics: ["wallet"],
    permissionLevel: "read",
    execute: async (input, ctx) => {
      const { project, notFound } = await resolveProjectRef(ctx, input.project);
      if (notFound) return { error: `no project matching "${notFound}"` };
      const range = localPeriodRange((input.period ?? "month") as LocalPeriod, ctx.user.timezone, ctx.now);
      const rows = await listWalletEntries(ctx.db, ctx.user.id, {
        direction: input.direction,
        category: normalizeCategory(input.category) ?? undefined,
        query: input.query,
        tags: input.tag ? normalizeTags([input.tag]) : undefined,
        projectId: project?.id,
        from: range.from,
        to: range.to,
        limit: input.limit ?? 20,
      });
      return {
        period: range.period,
        count: rows.length,
        entries: rows.map((row) => ({
          id: row.id,
          direction: row.direction,
          amount: formatMoney(row.amount, row.currency),
          description: truncate(row.description, 120),
          category: row.category,
          quantity: formatQuantity(row.quantity, row.unit) || null,
          when: formatDate(row.occurred_at, ctx.user.timezone, ctx.locale),
          tags: row.tags,
        })),
      };
    },
  }),

  defineTool({
    name: "wallet_balance",
    description:
      "Wallet totals: money in, money out, and what is left, per currency, plus the biggest spending categories. Use for 'how much did I spend', 'what is my balance', 'where does my money go'.",
    inputSchema: z.object({
      period: z.enum(PERIODS).optional().describe("defaults to month"),
      breakdown: z.boolean().optional().describe("include per-category totals (default true)"),
    }),
    topics: ["wallet"],
    permissionLevel: "read",
    execute: async (input, ctx) => {
      const range = localPeriodRange((input.period ?? "month") as LocalPeriod, ctx.user.timezone, ctx.now);
      const [totals, categories] = await Promise.all([
        walletSummary(ctx.db, ctx.user.id, range),
        input.breakdown === false
          ? Promise.resolve([])
          : walletCategoryTotals(ctx.db, ctx.user.id, {
              direction: "out",
              from: range.from,
              to: range.to,
              limit: 10,
            }),
      ]);
      if (totals.length === 0) {
        return { period: range.period, empty: true, note: "no wallet entries in this period" };
      }
      return {
        period: range.period,
        totals: totals.map((t) => ({
          currency: t.currency,
          received: formatMoney(t.moneyIn, t.currency),
          spent: formatMoney(t.moneyOut, t.currency),
          net: formatMoney(t.net, t.currency),
          entries: t.entries,
        })),
        topSpendingCategories: categories.map((c) => ({
          category: c.category ?? "uncategorized",
          total: formatMoney(c.total, c.currency),
          entries: c.entries,
        })),
      };
    },
  }),

  defineTool({
    name: "update_wallet_entry",
    description:
      "Correct a wallet entry: a wrong amount, a better description, a missing category. Get the id from list_wallet_entries first.",
    inputSchema: z.object({
      entryId: z.string().uuid(),
      amount: z.union([z.number(), z.string()]).optional(),
      description: z.string().min(1).max(300).optional(),
      category: z.string().max(40).nullable().optional(),
      currency: z.string().max(20).optional(),
      quantity: z.number().positive().nullable().optional(),
      unit: z.string().max(20).nullable().optional(),
      method: z.string().max(30).nullable().optional(),
      when: z.string().optional().describe("user-LOCAL YYYY-MM-DD or YYYY-MM-DDTHH:mm"),
      tags: z.array(z.string()).max(10).optional(),
      note: z.string().max(500).nullable().optional(),
    }),
    topics: ["wallet"],
    permissionLevel: "write",
    confirmLabel: () => "Update wallet entry",
    execute: async (input, ctx) => {
      const entry = await getWalletEntry(ctx.db, ctx.user.id, input.entryId);
      if (!entry) return { error: "wallet entry not found" };

      let amount: number | undefined;
      if (input.amount !== undefined) {
        const parsed = parseAmount(input.amount);
        if (parsed === null) return { error: `"${input.amount}" is not a positive amount` };
        amount = parsed;
      }
      let occurred: string | undefined;
      if (input.when !== undefined) {
        const at = occurredAt(input.when, ctx);
        if ("error" in at) return { error: at.error };
        occurred = at.iso;
      }

      await updateWalletEntry(ctx.db, ctx.user.id, entry.id, {
        ...(amount !== undefined ? { amount } : {}),
        ...(input.description !== undefined ? { description: input.description.trim() } : {}),
        ...(input.category !== undefined ? { category: normalizeCategory(input.category) } : {}),
        ...(input.currency !== undefined ? { currency: normalizeCurrency(input.currency) } : {}),
        ...(input.quantity !== undefined ? { quantity: input.quantity } : {}),
        ...(input.unit !== undefined ? { unit: input.unit?.trim() || null } : {}),
        ...(input.method !== undefined ? { method: input.method?.trim().toLowerCase() || null } : {}),
        ...(occurred !== undefined ? { occurred_at: occurred } : {}),
        ...(input.tags !== undefined ? { tags: normalizeTags(input.tags) } : {}),
        ...(input.note !== undefined ? { note: input.note?.trim() || null } : {}),
      });
      await insertAudit(ctx.db, {
        user_id: ctx.user.id,
        actor: "agent",
        action: "wallet.update",
        entity_id: entry.id,
      });
      return { updated: true, entryId: entry.id };
    },
  }),

  defineTool({
    name: "delete_wallet_entry",
    description: "Remove a wallet entry from the history and from every total (soft delete).",
    inputSchema: z.object({ entryId: z.string().uuid() }),
    topics: ["wallet"],
    permissionLevel: "destructive",
    confirmLabel: () => "Delete wallet entry",
    execute: async (input, ctx) => {
      const ok = await deleteWalletEntry(ctx.db, ctx.user.id, input.entryId);
      await insertAudit(ctx.db, {
        user_id: ctx.user.id,
        actor: "agent",
        action: "wallet.delete",
        entity_id: input.entryId,
        status: ok ? "ok" : "noop",
      });
      return ok ? { deleted: true } : { error: "wallet entry not found" };
    },
  }),
];
