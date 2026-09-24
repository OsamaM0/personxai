import type { AgentContext } from "../../agent/context";
import { log } from "../../utils/logger";

/** Best-effort note embedding write — never throws (embedding failure must not block writes). */
export async function setNoteEmbeddingSafe(
  ctx: AgentContext,
  noteId: string,
  embedding: number[]
): Promise<void> {
  const { error } = await ctx.db
    .from("notes")
    .update({ embedding: JSON.stringify(embedding) })
    .eq("user_id", ctx.user.id)
    .eq("id", noteId);
  if (error) log("warn", "note_embedding_write_failed", { noteId, error: error.message });
}
