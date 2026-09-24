/** Telegram ChannelAdapter wiring + webhook registration helper. */
import type { Env } from "../../env";
import type { ChannelAdapter } from "../types";
import { tgCall } from "./api";
import { parseTelegramUpdate } from "./normalize";
import { TelegramOutbound } from "./send";
import { verifyTelegramWebhook } from "./webhook";

export const telegramAdapter: ChannelAdapter = {
  name: "telegram",
  verifyWebhook: (req: Request, env: Env) => verifyTelegramWebhook(req, env.TELEGRAM_WEBHOOK_SECRET),
  parseUpdate: parseTelegramUpdate,
  outbound: (env: Env) => new TelegramOutbound(env.TELEGRAM_BOT_TOKEN),
};

/** Point Telegram at our webhook. channel_post is needed for vault-channel discovery. */
export async function registerTelegramWebhook(
  botToken: string,
  url: string,
  secret: string
): Promise<void> {
  await tgCall(botToken, "setWebhook", {
    url,
    secret_token: secret,
    allowed_updates: ["message", "edited_message", "callback_query", "channel_post"],
    drop_pending_updates: true,
  });
}

/**
 * The slash-command menu Telegram shows when the user types "/". Kept in sync
 * with the deterministic handlers in src/agent/commands.ts — every entry here
 * must have a handler, and the descriptions mirror the i18n help text.
 * Telegram allows at most 100 commands, names [a-z0-9_]{1,32}, descriptions 3–256 chars.
 */
export const BOT_COMMANDS: Record<"en" | "ar", { command: string; description: string }[]> = {
  en: [
    { command: "today", description: "Overdue + due today" },
    { command: "tasks", description: "Open tasks" },
    { command: "projects", description: "Your projects" },
    { command: "project", description: "One project's details: /project name" },
    { command: "notes", description: "Search notes: /notes text" },
    { command: "inbox", description: "Unorganized captures" },
    { command: "files", description: "Stored files: /files [text]" },
    { command: "find", description: "Search everything: /find text" },
    { command: "memory", description: "What I remember about you" },
    { command: "remember", description: "Keep a fact: /remember text" },
    { command: "links", description: "Saved links" },
    { command: "wallet", description: "Money in and out: /wallet [today|week|month|all] [in|out]" },
    { command: "reminders", description: "Upcoming reminders" },
    { command: "tags", description: "Your tags — tap one to see everything with it" },
    { command: "vault", description: "Vault channels where files are stored" },
    { command: "brief", description: "Daily brief: on 08:00 | off | now" },
    { command: "heartbeat", description: "Periodic nudges: on 4 | off | now" },
    { command: "skills", description: "Saved skills" },
    { command: "mcp", description: "Connected MCP servers" },
    { command: "connect", description: "Token for Claude Code / Codex: /connect [read|off|status]" },
    { command: "dashboard", description: "Sign-in link for the web dashboard" },
    { command: "status", description: "Usage and settings" },
    { command: "settings", description: "View or change settings" },
    { command: "tz", description: "Set timezone: /tz Africa/Cairo or /tz 21:30" },
    { command: "newchat", description: "Start a new conversation context" },
    { command: "contexts", description: "List conversation contexts" },
    { command: "context", description: "Switch context: /context name" },
    { command: "cancel", description: "Clear pending confirmations" },
    { command: "help", description: "All commands" },
  ],
  ar: [
    { command: "today", description: "المتأخر والمستحق اليوم" },
    { command: "tasks", description: "المهام المفتوحة" },
    { command: "projects", description: "مشاريعك" },
    { command: "project", description: "تفاصيل مشروع: /project اسم" },
    { command: "notes", description: "بحث في الملاحظات: /notes نص" },
    { command: "inbox", description: "الوارد غير المرتب" },
    { command: "files", description: "الملفات المحفوظة: /files [نص]" },
    { command: "find", description: "بحث شامل: /find نص" },
    { command: "memory", description: "ما أتذكره عنك" },
    { command: "remember", description: "احفظ معلومة: /remember نص" },
    { command: "links", description: "الروابط المحفوظة" },
    { command: "wallet", description: "المصاريف والدخل: /wallet [today|week|month|all] [in|out]" },
    { command: "reminders", description: "التذكيرات القادمة" },
    { command: "tags", description: "وسومك — اضغط وسماً لترى كل ما يحمله" },
    { command: "vault", description: "قنوات الحفظ التي تُخزَّن فيها الملفات" },
    { command: "brief", description: "الملخص اليومي: on 08:00 | off | now" },
    { command: "heartbeat", description: "تنبيهات دورية: on 4 | off | now" },
    { command: "skills", description: "المهارات المحفوظة" },
    { command: "mcp", description: "خوادم MCP المتصلة" },
    { command: "connect", description: "توكن لربط Claude Code / Codex" },
    { command: "dashboard", description: "رابط الدخول للوحة التحكم" },
    { command: "status", description: "الاستخدام والإعدادات" },
    { command: "settings", description: "عرض الإعدادات أو تغييرها" },
    { command: "tz", description: "ضبط المنطقة الزمنية: /tz Africa/Cairo" },
    { command: "newchat", description: "بدء سياق محادثة جديد" },
    { command: "contexts", description: "قائمة سياقات المحادثة" },
    { command: "context", description: "تبديل السياق: /context اسم" },
    { command: "cancel", description: "إلغاء التأكيدات المعلقة" },
    { command: "help", description: "كل الأوامر" },
  ],
};

/**
 * Publish the command menu, the bot description shown on the empty chat, and
 * the "What can this bot do?" text — in English (default) and Arabic. Idempotent;
 * safe to call on every /admin/register-webhook.
 */
export async function registerTelegramCommands(botToken: string): Promise<void> {
  await tgCall(botToken, "setMyCommands", { commands: BOT_COMMANDS.en });
  await tgCall(botToken, "setMyCommands", { commands: BOT_COMMANDS.ar, language_code: "ar" });
  await tgCall(botToken, "setMyShortDescription", {
    short_description: "Personal AI assistant: projects, tasks, notes, files, memory, reminders.",
  });
  await tgCall(botToken, "setMyDescription", {
    description: [
      "PersonXAI — your personal AI assistant.",
      "",
      "Send me anything: tasks, notes, voice notes, files, links. " +
        "I organise projects, remember what matters, remind you on time, and answer in English or Arabic.",
      "",
      "Type / to see commands, or just talk.",
    ].join("\n"),
  });
}

/**
 * Point the chat menu button at the dashboard so it opens as a Mini App.
 *
 * This replaces the button's default "list the commands" behaviour, not the
 * commands themselves — typing `/` still shows the menu published above, so
 * nothing is lost. Telegram only accepts an https URL, so a plain-http dev
 * origin restores the default button instead of failing the whole registration.
 */
export async function registerTelegramMenuButton(
  botToken: string,
  dashboardUrl?: string
): Promise<void> {
  const url = dashboardUrl?.replace(/\/+$/, "");
  await tgCall(botToken, "setChatMenuButton", {
    menu_button: url?.startsWith("https://")
      ? { type: "web_app", text: "Dashboard", web_app: { url } }
      : { type: "commands" },
  });
}
