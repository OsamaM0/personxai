import { describe, expect, it } from "vitest";
import { __internal } from "../../src/services/llm/provider";

const strip = __internal.stripEchoRejectedFields;

describe("outgoing request sanitization", () => {
  it("removes reasoning_content that reasoning models echo back", () => {
    const body = JSON.stringify({
      model: "openai/gpt-oss-120b",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "ok", reasoning_content: "thinking..." },
      ],
    });
    const out = JSON.parse(strip(body));
    expect(out.messages[1]).not.toHaveProperty("reasoning_content");
    expect(out.messages[1].content).toBe("ok");
  });

  it("removes reasoning and thinking variants too", () => {
    const body = JSON.stringify({
      messages: [
        { role: "assistant", content: "a", reasoning: "r" },
        { role: "assistant", content: "b", thinking: "t" },
      ],
    });
    const out = JSON.parse(strip(body));
    expect(out.messages[0]).not.toHaveProperty("reasoning");
    expect(out.messages[1]).not.toHaveProperty("thinking");
  });

  it("leaves user messages untouched", () => {
    const body = JSON.stringify({
      messages: [{ role: "user", content: "keep", reasoning: "mine" }],
    });
    const out = JSON.parse(strip(body));
    expect(out.messages[0].reasoning).toBe("mine");
  });

  it("preserves tool calls on assistant messages", () => {
    const body = JSON.stringify({
      messages: [
        {
          role: "assistant",
          content: null,
          reasoning_content: "x",
          tool_calls: [{ id: "1", type: "function", function: { name: "f", arguments: "{}" } }],
        },
      ],
    });
    const out = JSON.parse(strip(body));
    expect(out.messages[0].tool_calls).toHaveLength(1);
    expect(out.messages[0]).not.toHaveProperty("reasoning_content");
  });

  it("returns the body unchanged when nothing needs stripping", () => {
    const body = JSON.stringify({ messages: [{ role: "assistant", content: "clean" }] });
    expect(strip(body)).toBe(body);
  });

  it("forwards non-JSON and message-less bodies untouched", () => {
    expect(strip("not json")).toBe("not json");
    const noMessages = JSON.stringify({ input: "embed me" });
    expect(strip(noMessages)).toBe(noMessages);
  });
});
