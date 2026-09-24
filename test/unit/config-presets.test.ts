import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";
import type { Env } from "../../src/env";

const base = {
  TELEGRAM_BOT_TOKEN: "123456:ABCDEFGHIJKLMNOP",
  TELEGRAM_WEBHOOK_SECRET: "x".repeat(32),
  OWNER_TELEGRAM_ID: "42",
  VAULT_CHANNEL_ID: "-1001234567890",
  SUPABASE_URL: "https://abc.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "y".repeat(40),
  DISPATCH_SECRET: "z".repeat(32),
  DEFAULT_TIMEZONE: "Africa/Cairo",
  DEFAULT_LANGUAGE: "en",
  EMBEDDINGS_DIMS: "1024",
} as unknown as Env;

const env = (extra: Record<string, string>): Env => ({ ...base, ...extra }) as Env;

describe("LLM presets", () => {
  it("defaults to Workers AI with no preset and no keys", () => {
    const cfg = loadConfig(base);
    expect(cfg.llm.main.kind).toBe("workers-ai");
    expect(cfg.embeddings.model).toBe("@cf/baai/bge-m3");
    expect(cfg.embeddings.dims).toBe(1024);
  });

  it("cloudflare preset keeps everything on the AI binding", () => {
    const cfg = loadConfig(env({ LLM_PRESET: "cloudflare" }));
    expect(cfg.llm.main.kind).toBe("workers-ai");
    expect(cfg.llm.classifier.kind).toBe("workers-ai");
    expect(cfg.stt.kind).toBe("workers-ai");
  });

  it("groq preset wires chat and STT to groq, embeddings stay on Workers AI", () => {
    const cfg = loadConfig(env({ LLM_PRESET: "groq", GROQ_API_KEY: "gsk_test" }));
    expect(cfg.llm.main).toMatchObject({
      kind: "openai-compatible",
      baseURL: "https://api.groq.com/openai/v1",
      apiKey: "gsk_test",
    });
    expect(cfg.stt).toMatchObject({ kind: "openai-compatible", model: "whisper-large-v3-turbo" });
    expect(cfg.embeddings.kind).toBe("workers-ai");
  });

  it("openrouter preset leaves voice on Workers AI (no audio endpoint)", () => {
    const cfg = loadConfig(env({ LLM_PRESET: "openrouter", OPENROUTER_API_KEY: "sk-or-test" }));
    expect(cfg.llm.main).toMatchObject({ kind: "openai-compatible", baseURL: "https://openrouter.ai/api/v1" });
    expect(cfg.stt.kind).toBe("workers-ai");
  });

  it("explicit per-role variables override the preset", () => {
    const cfg = loadConfig(
      env({
        LLM_PRESET: "groq",
        GROQ_API_KEY: "gsk_test",
        LLM_MAIN_BASE_URL: "https://api.openai.com/v1",
        LLM_MAIN_API_KEY: "sk-custom",
        LLM_MAIN_MODEL: "gpt-4.1",
      })
    );
    expect(cfg.llm.main).toMatchObject({ baseURL: "https://api.openai.com/v1", model: "gpt-4.1" });
    // the untouched role still comes from the preset
    expect(cfg.llm.classifier).toMatchObject({ baseURL: "https://api.groq.com/openai/v1" });
  });

  it("fails fast on an unknown preset or a missing key", () => {
    expect(() => loadConfig(env({ LLM_PRESET: "nope" }))).toThrow(/unknown LLM_PRESET/);
    expect(() => loadConfig(env({ LLM_PRESET: "groq" }))).toThrow(/GROQ_API_KEY/);
  });

  it("rejects an embedding dimension that contradicts the model", () => {
    expect(() => loadConfig(env({ EMBEDDINGS_DIMS: "1536" }))).toThrow(/1024 dims/);
  });

  it("openai preset keeps embeddings on Workers AI (dims would not match)", () => {
    const cfg = loadConfig(env({ LLM_PRESET: "openai", OPENAI_API_KEY: "sk-test" }));
    expect(cfg.llm.main).toMatchObject({
      kind: "openai-compatible",
      baseURL: "https://api.openai.com/v1",
      model: "gpt-4.1",
    });
    expect(cfg.stt).toMatchObject({ kind: "openai-compatible", model: "whisper-1" });
    expect(cfg.embeddings.kind).toBe("workers-ai");
  });

  it("custom preset points at any OpenAI-compatible service", () => {
    const cfg = loadConfig(
      env({
        LLM_PRESET: "custom",
        LLM_BASE_URL: "https://my-llm.example.com/v1",
        LLM_API_KEY: "k",
        LLM_MAIN_MODEL: "my-model",
      })
    );
    expect(cfg.llm.main).toMatchObject({
      baseURL: "https://my-llm.example.com/v1",
      model: "my-model",
      apiKey: "k",
    });
    // classifier falls back to the main model when not given its own
    expect(cfg.llm.classifier).toMatchObject({ model: "my-model" });
  });

  it("custom preset states what it is missing", () => {
    expect(() => loadConfig(env({ LLM_PRESET: "custom" }))).toThrow(/LLM_BASE_URL/);
    expect(() =>
      loadConfig(env({ LLM_PRESET: "custom", LLM_BASE_URL: "https://x/v1", LLM_API_KEY: "k" }))
    ).toThrow(/LLM_MAIN_MODEL/);
  });

  it("overriding only the model keeps the preset's endpoint", () => {
    // Regression: this used to fall through to Workers AI with a non-@cf model id.
    const cfg = loadConfig(
      env({ LLM_PRESET: "groq", GROQ_API_KEY: "gsk_x", LLM_MAIN_MODEL: "qwen/qwen3.8-27b" })
    );
    expect(cfg.llm.main).toMatchObject({
      kind: "openai-compatible",
      baseURL: "https://api.groq.com/openai/v1",
      model: "qwen/qwen3.8-27b",
      apiKey: "gsk_x",
    });
  });

  it("an aggregator gateway is just a custom endpoint — no provider special case", () => {
    const cfg = loadConfig(
      env({
        LLM_PRESET: "custom",
        LLM_BASE_URL: "https://llm-api.inxai.dev/v1",
        LLM_API_KEY: "sk-cp-test",
        LLM_MAIN_MODEL: "auto",
      })
    );
    expect(cfg.llm.main).toMatchObject({
      kind: "openai-compatible",
      baseURL: "https://llm-api.inxai.dev/v1",
      model: "auto",
      apiKey: "sk-cp-test",
    });
    expect(cfg.llm.classifier).toMatchObject({ model: "auto" });
    // nothing routes embeddings or voice unless the user points them somewhere
    expect(cfg.embeddings.kind).toBe("workers-ai");
    expect(cfg.stt.kind).toBe("workers-ai");
    expect(() => loadConfig(env({ LLM_PRESET: "custome", LLM_API_KEY: "k" }))).toThrow(/unknown LLM_PRESET/);
  });

  it("reports missing required secrets by name", () => {
    const { SUPABASE_URL: _omit, ...rest } = base as unknown as Record<string, string>;
    expect(() => loadConfig(rest as unknown as Env)).toThrow(/SUPABASE_URL/);
  });
});
