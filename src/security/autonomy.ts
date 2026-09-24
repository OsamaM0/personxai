/**
 * Confirmation policy: given a tool's permission level and the user's autonomy
 * level (0 = confirm everything … 3 = fully autonomous), decide whether the
 * agent must ask before acting.
 *
 * Matrix:
 * - read:        never confirms.
 * - write:       confirms only at autonomy 0.
 * - destructive: confirms at autonomy <= 2; at autonomy 3 still confirms when
 *                the action is irreversible.
 * - external:    confirms at autonomy <= 1.
 * - toolFlag:    a tool marked confirm-always overrides everything.
 *
 * Reason priority: tool_flag > irreversible > autonomy > none.
 */

import type { PermissionLevel } from "./rbac";

export interface ConfirmationDecision {
  requires: boolean;
  reason: "autonomy" | "irreversible" | "tool_flag" | "none";
}

export function needsConfirmation(opts: {
  level: PermissionLevel;
  autonomy: number;
  toolFlag?: boolean;
  irreversible?: boolean;
}): ConfirmationDecision {
  if (opts.toolFlag === true) return { requires: true, reason: "tool_flag" };

  // Invalid autonomy (NaN, Infinity) falls back to 0 — the most cautious tier.
  const autonomy = Number.isFinite(opts.autonomy)
    ? Math.min(3, Math.max(0, Math.trunc(opts.autonomy)))
    : 0;

  switch (opts.level) {
    case "read":
      return { requires: false, reason: "none" };
    case "write":
      return autonomy === 0
        ? { requires: true, reason: "autonomy" }
        : { requires: false, reason: "none" };
    case "destructive":
      // irreversible outranks autonomy as the reported reason.
      if (opts.irreversible === true) return { requires: true, reason: "irreversible" };
      return autonomy <= 2
        ? { requires: true, reason: "autonomy" }
        : { requires: false, reason: "none" };
    case "external":
      return autonomy <= 1
        ? { requires: true, reason: "autonomy" }
        : { requires: false, reason: "none" };
  }
}
