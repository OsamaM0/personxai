import type { AgentNamespace } from "agents";
import type { UserAgent } from "./agent/user-agent";

export interface Env {
  // Bindings
  UserAgent: AgentNamespace<UserAgent>;
  AI: Ai;
  ARTIFACTS?: R2Bucket; // optional — R2 is opt-in (see docs/FREE_TIER.md)
  /** Static assets for the web dashboard (see docs/DASHBOARD.md). */
  ASSETS?: Fetcher;

  // Vars
  DEFAULT_TIMEZONE: string;
  DEFAULT_LANGUAGE: string;
  EMBEDDINGS_DIMS: string;

  // Secrets — Telegram
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  OWNER_TELEGRAM_ID: string;
  VAULT_CHANNEL_ID: string;

  // Secrets — WhatsApp Cloud API (optional channel; all-or-nothing, see docs/WHATSAPP.md).
  // OWNER_WHATSAPP_ID is the owner's wa_id (E.164 digits, no "+"); a first
  // message from it links WhatsApp to the existing owner account.
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  WHATSAPP_APP_SECRET?: string;
  WHATSAPP_VERIFY_TOKEN?: string;
  WHATSAPP_API_VERSION?: string;
  OWNER_WHATSAPP_ID?: string;

  // Secrets — Supabase
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;

  // Secrets — dispatcher
  DISPATCH_SECRET: string;

  // Web dashboard. WEB_SESSION_SECRET signs magic links and session cookies;
  // when unset it falls back to DISPATCH_SECRET. PUBLIC_BASE_URL is needed for
  // /dashboard before the site has been opened once, and is the Mini App URL
  // the chat menu button is pointed at (see docs/DASHBOARD.md).
  // ALLOWED_ORIGINS (comma-separated) lets a dashboard hosted elsewhere — e.g.
  // Vercel in front of this Worker (docs/VERCEL.md) — pass the CSRF guard.
  WEB_SESSION_SECRET?: string;
  PUBLIC_BASE_URL?: string;
  ALLOWED_ORIGINS?: string;

  // Provider preset: "cloudflare" | "groq" | "openrouter" | "openai" | "custom"
  // (see docs/FREE_TIER.md).
  // A preset fills in base URLs and models; explicit per-role vars override it.
  LLM_PRESET?: string;
  GROQ_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  OPENAI_API_KEY?: string;
  // Generic endpoint for LLM_PRESET=custom: any OpenAI-compatible service.
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;

  // Secrets — LLM roles (all optional; absent => preset, then Workers AI defaults)
  LLM_MAIN_BASE_URL?: string;
  LLM_MAIN_API_KEY?: string;
  LLM_MAIN_MODEL?: string;
  LLM_CLASSIFIER_BASE_URL?: string;
  LLM_CLASSIFIER_API_KEY?: string;
  LLM_CLASSIFIER_MODEL?: string;
  EMBEDDINGS_BASE_URL?: string;
  EMBEDDINGS_API_KEY?: string;
  EMBEDDINGS_MODEL?: string;
  STT_BASE_URL?: string;
  STT_API_KEY?: string;
  STT_MODEL?: string;
  VISION_BASE_URL?: string;
  VISION_API_KEY?: string;
  VISION_MODEL?: string;
  SEARCH_API_KEY?: string;

  R2_ENABLED?: string;
}
