import { dbError, type Db } from "../client";
import type { Enums, FileChunkMatch, HybridHit, MessageMatch } from "../types";

/**
 * Hybrid retrieval: keyword + (optional) vector, fused server-side with RRF.
 * Passing a null embedding degrades gracefully to keyword-only search.
 */
export async function hybridSearch(
  db: Db,
  userId: string,
  query: string,
  opts: { embedding?: number[] | null; kinds?: Enums<"entity_kind">[]; limit?: number } = {}
): Promise<HybridHit[]> {
  const { data, error } = await db.rpc("hybrid_search", {
    p_user_id: userId,
    p_query: query,
    p_query_embedding: opts.embedding ? JSON.stringify(opts.embedding) : null,
    p_kinds: opts.kinds ?? null,
    p_limit: opts.limit ?? 20,
  });
  if (error) throw dbError("hybrid_search", "rpc", error);
  return data ?? [];
}

export async function matchFileChunks(
  db: Db,
  userId: string,
  embedding: number[],
  opts: { projectId?: string; limit?: number } = {}
): Promise<FileChunkMatch[]> {
  const { data, error } = await db.rpc("match_file_chunks", {
    p_user_id: userId,
    p_query_embedding: JSON.stringify(embedding),
    p_project: opts.projectId ?? null,
    p_limit: opts.limit ?? 8,
  });
  if (error) throw dbError("match_file_chunks", "rpc", error);
  return data ?? [];
}

export async function matchMessages(
  db: Db,
  userId: string,
  embedding: number[],
  opts: { conversationId?: string | null; limit?: number } = {}
): Promise<MessageMatch[]> {
  const { data, error } = await db.rpc("match_messages", {
    p_user_id: userId,
    p_conversation: opts.conversationId ?? null,
    p_query_embedding: JSON.stringify(embedding),
    p_limit: opts.limit ?? 5,
  });
  if (error) throw dbError("match_messages", "rpc", error);
  return data ?? [];
}
