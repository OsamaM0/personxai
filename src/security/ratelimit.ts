/**
 * Pure token bucket. State lives in the caller (Durable Object storage, KV,
 * settings row, …); this module only computes transitions, so it is trivially
 * testable and has no clock of its own.
 */

export interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

export function takeToken(
  state: BucketState | null,
  nowMs: number,
  opts: { capacity: number; refillPerMinute: number }
): { allowed: boolean; state: BucketState } {
  const prev = state ?? { tokens: opts.capacity, lastRefillMs: nowMs };
  // Continuous refill; max(0, …) guards against a clock that moved backwards.
  const elapsedMinutes = Math.max(0, nowMs - prev.lastRefillMs) / 60_000;
  const tokens = Math.min(
    opts.capacity,
    prev.tokens + elapsedMinutes * opts.refillPerMinute
  );
  // lastRefillMs advances to nowMs even on denial: the refill up to now has
  // already been credited, so keeping the old timestamp would double-count it.
  if (tokens >= 1) {
    return { allowed: true, state: { tokens: tokens - 1, lastRefillMs: nowMs } };
  }
  return { allowed: false, state: { tokens, lastRefillMs: nowMs } };
}
