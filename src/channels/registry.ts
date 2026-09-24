import type { Env } from "../env";
import type { ChannelAdapter } from "./types";
import { telegramAdapter } from "./telegram";
import { whatsappAdapter } from "./whatsapp";

const adapters: Record<string, ChannelAdapter> = {
  [telegramAdapter.name]: telegramAdapter,
  [whatsappAdapter.name]: whatsappAdapter,
  // discord / slack: implement ChannelAdapter in channels/<name>/ and register here (docs/EXTENDING.md)
};

export function getAdapter(name: string): ChannelAdapter | null {
  return adapters[name] ?? null;
}

export function listAdapters(): ChannelAdapter[] {
  return Object.values(adapters);
}

/** Channel names with their configuration state — what /health reports. */
export function channelStatus(env: Env): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const a of listAdapters()) out[a.name] = a.isConfigured ? a.isConfigured(env) : true;
  return out;
}
