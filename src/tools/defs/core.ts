import { z } from "zod";
import { defineTool } from "../registry";
import { nowInTz } from "../../scheduler/tz";

/** Always-registered tools (kept tiny — they ship with every turn). */
export const currentTime = defineTool({
  name: "current_time",
  description:
    "Get the user's current local date and time. ALWAYS call this before computing any relative time ('in 20 minutes', 'tomorrow') — never reuse timestamps from earlier turns.",
  inputSchema: z.object({}),
  topics: [],
  permissionLevel: "read",
  execute: async (_input, ctx) => ({
    local: nowInTz(ctx.user.timezone),
    isoUtc: new Date().toISOString(),
    timezoneNote: "Times you pass to other tools must be the user's LOCAL wall time (YYYY-MM-DDTHH:mm).",
  }),
});

export const coreTools = [currentTime];
