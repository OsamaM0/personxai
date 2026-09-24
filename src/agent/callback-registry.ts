/**
 * Registry of inline-button callback handlers, keyed by callback kind
 * ('cfm', 'inbox', …). Separate module so feature modules (tools) and the
 * orchestrator can both import it without a circular dependency.
 */
import type { AgentContext } from "./context";

export type CallbackHandler = (
  ctx: AgentContext,
  payload: unknown,
  verb: string,
  messageId?: string
) => Promise<void>;

const handlers = new Map<string, CallbackHandler>();

export function registerCallbackKind(kind: string, handler: CallbackHandler): void {
  handlers.set(kind, handler);
}

export function getCallbackHandler(kind: string): CallbackHandler | undefined {
  return handlers.get(kind);
}
