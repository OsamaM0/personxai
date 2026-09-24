# Switching embedding providers / dimensions

Every embedding column is `vector(1024)` (Workers AI `@cf/baai/bge-m3`). pgvector columns have a fixed dimension, so switching to a provider with different dims (e.g. OpenAI `text-embedding-3-small` = 1536) requires a migration + re-embed.

The Worker asserts `EMBEDDINGS_DIMS` against its config at startup and refuses mismatched vectors, so a config change without this migration fails fast rather than corrupting search.

## Procedure (example: 1024 → 1536)

1. **Stop writes** briefly (undeploy or announce downtime — personal instance, so this is trivial).
2. For each embedding column (`messages.embedding`, `notes.embedding`, and in later phases `memories.embedding`, `files.embedding`, `file_chunks.embedding`, `links.embedding`):

```sql
-- drop dependent HNSW indexes first
drop index if exists messages_embedding_idx;
alter table public.messages alter column embedding type extensions.vector(1536) using null; -- discards old vectors
create index messages_embedding_idx on public.messages
  using hnsw (embedding extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 64)
  where embedding is not null;
```

(Repeat per table; partial-index predicates vary — copy them from `supabase/migrations/`.)

3. Update config: set `EMBEDDINGS_BASE_URL/_API_KEY/_MODEL` and `EMBEDDINGS_DIMS=1536` (both the `wrangler.jsonc` var and any `.dev.vars`), redeploy.
4. **Re-embed**: content re-embeds lazily on the next content change. For bulk backfill, select rows where `embedding is null` and run them through the new provider (a small script hitting your `/dispatch`-style admin endpoint, or a one-off local script using the service key).

> Old vectors and new vectors are never mixed: the `using null` cast wipes them, and similarity search treats `embedding is null` rows as non-candidates until re-embedded.
