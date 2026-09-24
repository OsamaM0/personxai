/**
 * Live context block — rebuilt every turn, explicitly labeled as such so the
 * model never reuses stale values (openmemo pattern).
 */
import { nowInTz } from "../../scheduler/tz";
import type { ConversationRow, UserRow } from "../../database/types";

export interface LiveContextInput {
  user: UserRow;
  conversation: ConversationRow | null;
  activeProjectName?: string | null;
  userFacts?: { category: string; key: string; value: string }[];
  pendingCounts?: { inbox?: number; overdueTasks?: number; reminders?: number };
  autonomyLabel: string;
  /** Most-used tags, so the model reuses vocabulary instead of inventing it. */
  tagsInUse?: string[];
  /** Connected vault channels with their category and tags (routing hints). */
  vaultChannels?: { title: string; category: string | null; tags: string[]; isDefault: boolean }[];
}

export function buildLiveContext(input: LiveContextInput): string {
  const lines: string[] = [
    "Live context (refreshed every turn — do not reuse values from previous turns):",
    `- Current local time for the user: ${nowInTz(input.user.timezone)}`,
    `- User: ${input.user.display_name ?? "the user"} (interface language preference: ${input.user.language})`,
    `- Autonomy level: ${input.user.autonomy_level} (${input.autonomyLabel})`,
  ];
  if (input.conversation) {
    lines.push(`- Active conversation context: ${input.conversation.title ?? "General"}`);
  }
  if (input.activeProjectName) {
    lines.push(`- Active project: ${input.activeProjectName}`);
  }
  const facts = input.userFacts ?? [];
  if (facts.length > 0) {
    const rendered = facts
      .filter((f) => !/timezone|زمن/i.test(f.key))
      .map((f) => `${f.key}=${f.value}`)
      .join(" | ");
    if (rendered) lines.push(`- Known about the user: ${rendered}`);
  }
  const p = input.pendingCounts ?? {};
  const pending: string[] = [];
  if (p.inbox) pending.push(`${p.inbox} unprocessed inbox items`);
  if (p.overdueTasks) pending.push(`${p.overdueTasks} overdue tasks`);
  if (p.reminders) pending.push(`${p.reminders} upcoming reminders`);
  if (pending.length > 0) lines.push(`- Pending: ${pending.join(", ")}`);
  const tags = input.tagsInUse ?? [];
  if (tags.length > 0) lines.push(`- Tags in use (reuse these): ${tags.slice(0, 30).join(", ")}`);
  const vaults = input.vaultChannels ?? [];
  if (vaults.length > 1) {
    const rendered = vaults
      .map((v) => `${v.title}${v.category ? ` [${v.category}]` : ""}${v.tags.length ? ` #${v.tags.slice(0, 4).join(" #")}` : ""}${v.isDefault ? " (default)" : ""}`)
      .join(" | ");
    lines.push(`- Vault channels for files: ${rendered}`);
  }
  return lines.join("\n");
}

export const AUTONOMY_LABELS: Record<number, string> = {
  0: "read-only: every write needs inline-button confirmation",
  1: "safe actions: notes/tasks/memories run without confirmation; destructive and external actions need confirmation",
  2: "managed automation: approved workflows run; destructive actions still need confirmation",
  3: "autonomous: most actions run; irreversible actions still need confirmation",
};
