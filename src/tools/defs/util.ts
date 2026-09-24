import type { AgentContext } from "../../agent/context";
import { findProject } from "../../database/repos/projects";
import type { ProjectRow } from "../../database/types";
import { forceLocalOffset } from "../../scheduler/tz";

/** Resolve an optional project name/slug/id to a row; distinguishes "not given" from "not found". */
export async function resolveProjectRef(
  ctx: AgentContext,
  ref: string | undefined | null
): Promise<{ project: ProjectRow | null; notFound?: string }> {
  if (!ref || ref.trim().length === 0) return { project: null };
  const project = await findProject(ctx.db, ctx.user.id, ref);
  if (!project) return { project: null, notFound: ref };
  return { project };
}

const LOCAL_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?/;

/**
 * Parse an LLM-provided datetime in the user's timezone. The offset the model
 * produced (if any) is always overwritten by the correct one (tz write-guard).
 */
export function parseUserDateTime(
  value: string,
  timezone: string
): { date: Date } | { error: string } {
  if (!LOCAL_DATETIME_RE.test(value)) {
    return { error: `invalid datetime "${value}" — use YYYY-MM-DDTHH:mm in the user's local time` };
  }
  const forced = forceLocalOffset(value, timezone);
  const date = new Date(forced);
  if (Number.isNaN(date.getTime())) {
    return { error: `unparseable datetime "${value}"` };
  }
  return { date };
}
