import { describe, expect, it } from "vitest";
import { isQuiet, renderBrief, type AttentionSnapshot } from "../../src/workflows/daily-brief";
import type { AgentContext } from "../../src/agent/context";
import type { TaskRow } from "../../src/database/types";

const empty: AttentionSnapshot = {
  overdue: [],
  dueToday: [],
  waiting: [],
  upcomingReminders: [],
  staleProjects: [],
  inboxCount: 0,
};

function task(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "t1",
    user_id: "u1",
    project_id: null,
    parent_task_id: null,
    title: "Finish the OpenCV lesson",
    description: null,
    status: "todo",
    priority: "high",
    start_at: null,
    due_at: "2026-08-27T09:00:00Z",
    recurrence_rule: null,
    tags: [],
    source: "chat",
    completed_at: null,
    created_at: "2026-08-20T09:00:00Z",
    updated_at: "2026-08-20T09:00:00Z",
    ...overrides,
  } as TaskRow;
}

const ctx = {
  user: { timezone: "Africa/Cairo" },
  locale: "en",
} as unknown as AgentContext;

describe("attention snapshot", () => {
  it("is quiet when nothing is pending", () => {
    expect(isQuiet(empty)).toBe(true);
  });

  it("is not quiet for any single signal", () => {
    expect(isQuiet({ ...empty, overdue: [task()] })).toBe(false);
    expect(isQuiet({ ...empty, dueToday: [task()] })).toBe(false);
    expect(isQuiet({ ...empty, waiting: [task({ status: "waiting" })] })).toBe(false);
    expect(isQuiet({ ...empty, inboxCount: 1 })).toBe(false);
  });
});

describe("renderBrief", () => {
  it("includes only sections that have content", () => {
    const text = renderBrief(ctx, { ...empty, overdue: [task()] });
    expect(text).toContain("Finish the OpenCV lesson");
    expect(text).toContain("Overdue");
    expect(text).not.toContain("Waiting on");
    expect(text).not.toContain("Projects going quiet");
  });

  it("renders due times in the user's timezone", () => {
    const text = renderBrief(ctx, { ...empty, dueToday: [task()] });
    // 09:00 UTC is noon in Cairo (EEST, +03:00)
    expect(text).toMatch(/12:00/);
  });

  it("reports inbox pressure with a count", () => {
    expect(renderBrief(ctx, { ...empty, inboxCount: 7 })).toContain("7");
  });
});
