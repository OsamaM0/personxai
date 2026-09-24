#!/usr/bin/env sh
# Container entrypoint: turn environment variables into the .dev.vars file
# wrangler reads (wrangler dev does not expose the process environment to the
# Worker), then start workerd via wrangler with persistent Durable Object
# storage under $PERSONXAI_DATA_DIR.
set -eu

PORT="${PERSONXAI_PORT:-8787}"
CONFIG="${PERSONXAI_WRANGLER_CONFIG:-wrangler.docker.jsonc}"
DATA_DIR="${PERSONXAI_DATA_DIR:-/data}"
VARS_FILE="/app/.dev.vars"

# Every variable the Worker understands (src/env.d.ts). Anything else in the
# environment is ignored so unrelated container variables never leak in.
KNOWN="TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET OWNER_TELEGRAM_ID VAULT_CHANNEL_ID \
WHATSAPP_ACCESS_TOKEN WHATSAPP_PHONE_NUMBER_ID WHATSAPP_APP_SECRET WHATSAPP_VERIFY_TOKEN WHATSAPP_API_VERSION OWNER_WHATSAPP_ID \
SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY DISPATCH_SECRET WEB_SESSION_SECRET PUBLIC_BASE_URL ALLOWED_ORIGINS \
LLM_PRESET GROQ_API_KEY OPENROUTER_API_KEY OPENAI_API_KEY LLM_BASE_URL LLM_API_KEY \
LLM_MAIN_BASE_URL LLM_MAIN_API_KEY LLM_MAIN_MODEL LLM_CLASSIFIER_BASE_URL LLM_CLASSIFIER_API_KEY LLM_CLASSIFIER_MODEL \
EMBEDDINGS_BASE_URL EMBEDDINGS_API_KEY EMBEDDINGS_MODEL EMBEDDINGS_DIMS STT_BASE_URL STT_API_KEY STT_MODEL \
VISION_BASE_URL VISION_API_KEY VISION_MODEL SEARCH_API_KEY R2_ENABLED DEFAULT_TIMEZONE DEFAULT_LANGUAGE"

if [ -f "$VARS_FILE" ] && [ "${PERSONXAI_REGENERATE_VARS:-0}" != "1" ]; then
  echo "[personxai] using mounted $VARS_FILE"
else
  : > "$VARS_FILE"
  chmod 600 "$VARS_FILE"
  for name in $KNOWN; do
    value="$(printenv "$name" 2>/dev/null || true)"
    [ -n "$value" ] && printf '%s=%s\n' "$name" "$value" >> "$VARS_FILE"
  done
  echo "[personxai] wrote $VARS_FILE from the environment ($(wc -l < "$VARS_FILE") vars)"
fi

if [ "${LLM_PRESET:-}" = "cloudflare" ] || [ -z "${LLM_PRESET:-}" ]; then
  echo "[personxai] WARNING: no Workers AI binding inside a container — set LLM_PRESET to groq / openrouter / openai / custom (docs/DOCKER.md)" >&2
fi

mkdir -p "$DATA_DIR"
echo "[personxai] starting workerd on :$PORT (config $CONFIG, state in $DATA_DIR)"
exec npx wrangler dev \
  --config "$CONFIG" \
  --ip 0.0.0.0 \
  --port "$PORT" \
  --persist-to "$DATA_DIR" \
  --log-level "${WRANGLER_LOG:-log}" \
  --show-interactive-dev-session=false \
  "$@"
