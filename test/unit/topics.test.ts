import { describe, expect, it } from "vitest";
import { selectTopics } from "../../src/tools/topics";

describe("selectTopics", () => {
  it("matches English task phrasing", () => {
    expect(selectTopics("add a task to deploy the bot before Sunday")).toContain("tasks");
  });

  it("matches Arabic reminder phrasing", () => {
    const topics = selectTopics("فكرني بكرة الساعة 9 أكلم أحمد");
    expect(topics).toContain("reminders");
  });

  it("matches Egyptian Arabic task phrasing", () => {
    expect(selectTopics("ضيف مهمة اني اخلص الشابتر")).toContain("tasks");
  });

  it("adds projects when tasks are in play", () => {
    expect(selectTopics("show my overdue tasks")).toContain("projects");
  });

  it("falls back to a broad default when nothing matches", () => {
    const topics = selectTopics("hello there");
    expect(topics).toEqual(expect.arrayContaining(["tasks", "projects", "notes", "reminders"]));
  });

  it("picks inbox for organize requests", () => {
    expect(selectTopics("organize my inbox please")).toContain("inbox");
    expect(selectTopics("رتب صندوق الوارد")).toContain("inbox");
  });

  it("picks search for find requests", () => {
    expect(selectTopics("find everything about OCR")).toContain("search");
  });
});
