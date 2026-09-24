/**
 * Role-based access control. Roles are ordered owner > admin > user > viewer.
 * Data is single-tenant-per-user, so every non-viewer role gets all permission
 * levels ("destructive" means deleting the user's own entities, not others').
 */

import type { Enums } from "../database/types";

export type PermissionLevel = "read" | "write" | "destructive" | "external";

const ROLE_RANK: Record<Enums<"user_role">, number> = {
  owner: 3,
  admin: 2,
  user: 1,
  viewer: 0,
};

export function hasRoleAtLeast(
  role: Enums<"user_role">,
  min: Enums<"user_role">
): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

export function roleAllowsPermission(
  role: Enums<"user_role">,
  level: PermissionLevel
): boolean {
  if (role === "viewer") return level === "read";
  return true;
}
