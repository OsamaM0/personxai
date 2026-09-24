import { z } from "zod";
import type { Env } from "./env";

export interface OpenAICompatConfig {
  kind: "openai-compatible";
  baseURL: string;
  apiKey: string;
  model: string;
}

export interface WorkersAIConfig {
  kind: "workers-ai";
  model: string;
}

export type LLMRoleConfig = OpenAICompatConfig | WorkersAIConfig;
export type EmbeddingsConfig = LLMRoleConfig & { dims: number };

export interface WhatsAppConfig {
  accessToken: string;
  phoneNumberId: string;
  appSecret: string;
  verifyToken: string;
  apiVersion?: string;
}

export interface AppConfig {
  llm: {
    main: LLMRoleConfig;
    classifier: LLMRoleConfig;
    vision?: LLMRoleConfig;
  };
  embeddings: EmbeddingsConfig;
  stt: LLMRoleConfig;
  telegram: {
    botToken: string;
    webhookSecret: string;
    vaultChannelId: string;
  };
  /** Present only when every WhatsApp secret is set (docs/WHATSAPP.md). */
  whatsapp?: WhatsAppConfig;
  supabase: { url: string; serviceRoleKey: string };
  ownerTelegramId: string;
  /** Owner's WhatsApp wa_id (digits only); links the channel to the owner on first contact. */
  ownerWhatsAppId?: string;
  dispatchSecret: string;
  /** Extra origins the dashboard API accepts state-changing requests from (docs/VERCEL.md). */
  allowedOrigins: string[];
  defaults: { timezone: string; language: string };
  limits: {
    maxIterations: number;
    toolBudgetPerTurn: number;
    toolResultChars: number;
    historyWindow: number;
    maxExtractChars: number;
    rateLimitPerMinute: number;
    llmTimeoutMs: number;
    toolTimeoutMs: number;
    minEmbedChars: number;
  };
  searchApiKey?: string;
  r2Enabled: boolean;
}

// Workers AI defaults keep the zero-external-keys recipe working (docs/FREE_TIER.md)
const WORKERS_AI_MAIN = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const WORKERS_AI_CLASSIFIER = "@cf/meta/llama-3.1-8b-instruct";
const WORKERS_AI_EMBEDDINGS = "@cf/baai/bge-m3";
const WORKERS_AI_STT = "@cf/openai/whisper-large-v3-turbo";


/**
 * Provider presets. A preset supplies base URLs and model ids for a whole
 * recipe so a user only has to provide one API key. Any explicit per-role
 * variable still wins over the preset — including overriding just the model
 * while keeping the preset's endpoint. See docs/FREE_TIER.md.
 */
export type PresetName = "cloudflare" | "groq" | "openrouter" | "openai" | "custom";

interface PresetRole {
  baseURL?: string;
  model: string;
}

interface ResolvedPreset {
  name: string;
  apiKey?: string;
  /** Name of the variable that supplies the key, so errors can say which to set. */
  apiKeyVar?: string;
  main: PresetRole;
  classifier: PresetRole;
  /** Only set when the provider's embeddings match our vector(1024) columns. */
  embeddings?: PresetRole;
  stt?: PresetRole;
}

const GROQ = "https://api.groq.com/openai/v1";
const OPENROUTER = "https://openrouter.ai/api/v1";
const OPENAI = "https://api.openai.com/v1";

/**
 * Builds the preset for a name. Named presets exist only for providers whose
 * endpoint and model ids are worth remembering on the user's behalf. Anything
 * else that speaks the OpenAI API — an aggregator, a proxy, a self-hosted
 * gateway — goes through `custom`, which takes the endpoint, key and models
 * from the environment with no provider-specific handling. Model ids were
 * verified against each provider's live catalog on 2026-08-27 — catalogs
 * drift, so override a role's model if one is retired.
 */
function buildPreset(name: string, env: Env): ResolvedPreset {
  switch (name) {
    // No external account at all: everything runs on the Workers AI binding.
    case "cloudflare":
      return {
        name,
        main: { model: WORKERS_AI_MAIN },
        classifier: { model: WORKERS_AI_CLASSIFIER },
        stt: { model: WORKERS_AI_STT },
      };
    case "groq":
      return {
        name,
        apiKey: env.GROQ_API_KEY,
        apiKeyVar: "GROQ_API_KEY",
        main: { baseURL: GROQ, model: "openai/gpt-oss-120b" },
        classifier: { baseURL: GROQ, model: "openai/gpt-oss-20b" },
        stt: { baseURL: GROQ, model: "whisper-large-v3-turbo" },
      };
    case "openrouter":
      // OpenRouter has no audio endpoint; voice falls back to Workers AI.
      return {
        name,
        apiKey: env.OPENROUTER_API_KEY,
        apiKeyVar: "OPENROUTER_API_KEY",
        main: { baseURL: OPENROUTER, model: "deepseek/deepseek-chat-v3.1:free" },
        classifier: { baseURL: OPENROUTER, model: "meta-llama/llama-3.3-70b-instruct:free" },
      };
    case "openai":
      // Embeddings deliberately stay on Workers AI: text-embedding-3-small is
      // 1536-dim and would not fit the vector(1024) columns (docs/RE_EMBEDDING.md).
      return {
        name,
        apiKey: env.OPENAI_API_KEY,
        apiKeyVar: "OPENAI_API_KEY",
        main: { baseURL: OPENAI, model: "gpt-4.1" },
        classifier: { baseURL: OPENAI, model: "gpt-4.1-mini" },
        stt: { baseURL: OPENAI, model: "whisper-1" },
      };
    // Generic: any OpenAI-compatible service. Endpoint and models come entirely
    // from the environment, so no code change is needed to adopt a new provider.
    case "custom": {
      const baseURL = env.LLM_BASE_URL;
      if (!baseURL) {
        throw new Error('LLM_PRESET="custom" requires LLM_BASE_URL');
      }
      const model = env.LLM_MAIN_MODEL;
      if (!model) {
        throw new Error('LLM_PRESET="custom" requires LLM_MAIN_MODEL');
      }
      return {
        name,
        apiKey: env.LLM_API_KEY,
        apiKeyVar: "LLM_API_KEY",
        main: { baseURL, model },
        classifier: { baseURL, model: env.LLM_CLASSIFIER_MODEL || model },
      };
    }
    default:
      throw new Error(
        `unknown LLM_PRESET "${name}" — expected one of: cloudflare, groq, openrouter, openai, custom`
      );
  }
}

function resolvePreset(env: Env): ResolvedPreset | null {
  const name = (env.LLM_PRESET ?? "").trim().toLowerCase();
  if (!name) return null;
  const preset = buildPreset(name, env);
  if (preset.main.baseURL && !preset.apiKey) {
    throw new Error(
      `LLM_PRESET="${name}" requires ${preset.apiKeyVar ?? "its API key"} to be set`
    );
  }
  return preset;
}

const secretsSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(10),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(16),
  OWNER_TELEGRAM_ID: z.string().min(1),
  VAULT_CHANNEL_ID: z.string().min(1),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  DISPATCH_SECRET: z.string().min(16),
});

const WHATSAPP_VARS = [
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_VERIFY_TOKEN",
] as const;

/**
 * WhatsApp is optional but all-or-nothing: a half-configured channel would
 * accept webhooks it cannot answer (or answer ones it cannot verify), so a
 * partial set fails at boot like any other bad secret.
 */
function whatsappFromEnv(env: Env): WhatsAppConfig | undefined {
  const present = WHATSAPP_VARS.filter((k) => !!env[k]);
  if (present.length === 0) return undefined;
  if (present.length < WHATSAPP_VARS.length) {
    const missing = WHATSAPP_VARS.filter((k) => !env[k]).join(", ");
    throw new Error(`WhatsApp is partially configured — also set ${missing} (or unset all WHATSAPP_* vars)`);
  }
  const cfg: WhatsAppConfig = {
    accessToken: env.WHATSAPP_ACCESS_TOKEN as string,
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID as string,
    appSecret: env.WHATSAPP_APP_SECRET as string,
    verifyToken: env.WHATSAPP_VERIFY_TOKEN as string,
  };
  if (env.WHATSAPP_API_VERSION) cfg.apiVersion = env.WHATSAPP_API_VERSION;
  return cfg;
}

/** wa_id is E.164 digits without "+"; accept the human spelling and normalise. */
export function normalizeWhatsAppId(raw: string | undefined): string | undefined {
  const digits = (raw ?? "").replace(/\D/g, "");
  return digits.length > 0 ? digits : undefined;
}

/** Comma-separated origins → normalised list (scheme + host, no path, no trailing slash). */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const s = part.trim();
    if (!s) continue;
    try {
      out.push(new URL(s).origin);
    } catch {
      throw new Error(`ALLOWED_ORIGINS entry is not a valid origin: "${s}"`);
    }
  }
  return out;
}

/** Whether a first-contact identity on `channel` is the configured owner. */
export function isOwnerIdentity(config: AppConfig, channel: string, externalId: string): boolean {
  if (channel === "telegram") return externalId === config.ownerTelegramId;
  if (channel === "whatsapp") {
    return !!config.ownerWhatsAppId && normalizeWhatsAppId(externalId) === config.ownerWhatsAppId;
  }
  return false;
}

function roleFromEnv(
  baseURL: string | undefined,
  apiKey: string | undefined,
  model: string | undefined,
  workersAiDefault: string | null,
  roleName: string,
  preset?: { role?: PresetRole; apiKey?: string }
): LLMRoleConfig {
  // Explicit variables win field by field, so a preset's endpoint can be kept
  // while overriding only the model (or vice versa).
  const effectiveBaseURL = baseURL ?? preset?.role?.baseURL;
  const effectiveApiKey = apiKey ?? preset?.apiKey;
  const effectiveModel = model ?? preset?.role?.model;

  if (effectiveBaseURL) {
    if (!effectiveApiKey || !effectiveModel) {
      throw new Error(
        `LLM role "${roleName}": an endpoint is configured but its API key or model is missing`
      );
    }
    return {
      kind: "openai-compatible",
      baseURL: effectiveBaseURL,
      apiKey: effectiveApiKey,
      model: effectiveModel,
    };
  }
  if (effectiveModel?.startsWith("@cf/")) {
    return { kind: "workers-ai", model: effectiveModel };
  }
  if (workersAiDefault) {
    return { kind: "workers-ai", model: effectiveModel ?? workersAiDefault };
  }
  throw new Error(
    `LLM role "${roleName}" is not configured (set ${roleName.toUpperCase()}_BASE_URL, _API_KEY and _MODEL)`
  );
}

export function loadConfig(env: Env): AppConfig {
  const parsed = secretsSchema.safeParse(env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Missing/invalid required secrets: ${missing}`);
  }

  const resolved = resolvePreset(env);

  const dims = Number.parseInt(env.EMBEDDINGS_DIMS ?? "1024", 10);
  if (!Number.isFinite(dims) || dims <= 0) {
    throw new Error(`EMBEDDINGS_DIMS must be a positive integer, got "${env.EMBEDDINGS_DIMS}"`);
  }

  const embeddingsRole = roleFromEnv(
    env.EMBEDDINGS_BASE_URL,
    env.EMBEDDINGS_API_KEY,
    env.EMBEDDINGS_MODEL,
    WORKERS_AI_EMBEDDINGS,
    "embeddings",
    resolved?.embeddings ? { role: resolved.embeddings, apiKey: resolved.apiKey } : undefined
  );
  // bge-m3 is 1024-dim; a mismatch between config and the vector(N) columns must fail fast.
  if (embeddingsRole.kind === "workers-ai" && embeddingsRole.model === WORKERS_AI_EMBEDDINGS && dims !== 1024) {
    throw new Error(`EMBEDDINGS_DIMS=${dims} but ${WORKERS_AI_EMBEDDINGS} produces 1024 dims`);
  }

  return {
    llm: {
      main: roleFromEnv(
        env.LLM_MAIN_BASE_URL,
        env.LLM_MAIN_API_KEY,
        env.LLM_MAIN_MODEL,
        WORKERS_AI_MAIN,
        "llm_main",
        resolved ? { role: resolved.main, apiKey: resolved.apiKey } : undefined
      ),
      classifier: roleFromEnv(
        env.LLM_CLASSIFIER_BASE_URL,
        env.LLM_CLASSIFIER_API_KEY,
        env.LLM_CLASSIFIER_MODEL,
        WORKERS_AI_CLASSIFIER,
        "llm_classifier",
        resolved ? { role: resolved.classifier, apiKey: resolved.apiKey } : undefined
      ),
      vision: env.VISION_BASE_URL || env.VISION_MODEL
        ? roleFromEnv(env.VISION_BASE_URL, env.VISION_API_KEY, env.VISION_MODEL, null, "vision")
        : undefined,
    },
    embeddings: { ...embeddingsRole, dims },
    stt: roleFromEnv(
      env.STT_BASE_URL,
      env.STT_API_KEY,
      env.STT_MODEL,
      WORKERS_AI_STT,
      "stt",
      resolved?.stt ? { role: resolved.stt, apiKey: resolved.apiKey } : undefined
    ),
    telegram: {
      botToken: env.TELEGRAM_BOT_TOKEN,
      webhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
      vaultChannelId: env.VAULT_CHANNEL_ID,
    },
    whatsapp: whatsappFromEnv(env),
    supabase: { url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY },
    ownerTelegramId: env.OWNER_TELEGRAM_ID,
    ownerWhatsAppId: normalizeWhatsAppId(env.OWNER_WHATSAPP_ID),
    dispatchSecret: env.DISPATCH_SECRET,
    allowedOrigins: parseAllowedOrigins(env.ALLOWED_ORIGINS),
    defaults: {
      timezone: env.DEFAULT_TIMEZONE || "UTC",
      language: env.DEFAULT_LANGUAGE || "en",
    },
    limits: {
      maxIterations: 8,
      toolBudgetPerTurn: 12,
      toolResultChars: 4000,
      historyWindow: 20,
      maxExtractChars: 500_000,
      rateLimitPerMinute: 20,
      llmTimeoutMs: 60_000,
      toolTimeoutMs: 15_000,
      minEmbedChars: 20,
    },
    searchApiKey: env.SEARCH_API_KEY,
    r2Enabled: env.R2_ENABLED === "true" && !!env.ARTIFACTS,
  };
}
