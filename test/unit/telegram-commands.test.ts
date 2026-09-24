import { describe, expect, it } from "vitest";
import { BOT_COMMANDS } from "../../src/channels/telegram/index";
import { listCommandNames } from "../../src/agent/commands";

/**
 * The "/" menu Telegram shows is published from BOT_COMMANDS. Every entry must
 * map to a real handler, obey Telegram's limits, and exist in both languages,
 * otherwise users see commands the bot answers with "Unknown command".
 */
describe("Telegram command menu", () => {
  const handlers = new Set(listCommandNames());

  it("only lists commands that have a handler", () => {
    for (const { command } of BOT_COMMANDS.en) {
      expect(handlers.has(command), `/${command} has no handler`).toBe(true);
    }
  });

  it("covers every user-facing handler (except aliases and /start)", () => {
    const listed = new Set(BOT_COMMANDS.en.map((c) => c.command));
    const hidden = new Set(["start", "search", "archive", "tag"]); // /start is implicit; search=find and tag=tags aliases; archive is niche
    for (const name of handlers) {
      if (hidden.has(name)) continue;
      expect(listed.has(name), `/${name} is missing from the menu`).toBe(true);
    }
  });

  it("respects Telegram's setMyCommands constraints", () => {
    for (const locale of ["en", "ar"] as const) {
      expect(BOT_COMMANDS[locale].length).toBeLessThanOrEqual(100);
      for (const { command, description } of BOT_COMMANDS[locale]) {
        expect(command).toMatch(/^[a-z0-9_]{1,32}$/);
        expect(description.length).toBeGreaterThanOrEqual(3);
        expect(description.length).toBeLessThanOrEqual(256);
      }
    }
  });

  it("keeps English and Arabic menus in the same order", () => {
    expect(BOT_COMMANDS.ar.map((c) => c.command)).toEqual(BOT_COMMANDS.en.map((c) => c.command));
  });
});
