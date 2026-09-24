/**
 * URL capture: fetch → summarize with the cheap model → bookmark → embed.
 * Shared by the deterministic bare-link route and the save_link tool.
 */
import { z } from "zod";
import type { AgentContext } from "../agent/context";
import { updateLink, upsertLink } from "../database/repos/links";
import { insertAudit } from "../database/repos/audit";
import type { LinkRow } from "../database/types";
import { classifyJson } from "../services/llm/classify";
import { embedText } from "../services/llm/embeddings";
import { fetchUrlMetadata } from "../services/url/metadata";
import { normalizeTags, truncate } from "../utils/text";
import { formatError, log } from "../utils/logger";

const summarySchema = z.object({
  summary: z.string().max(1200),
  tags: z.array(z.string()).max(5),
});

export async function ingestUrl(
  ctx: AgentContext,
  url: string,
  opts: { projectId?: string | null; note?: string; tags?: string[] } = {}
): Promise<LinkRow | null> {
  try {
    const meta = await fetchUrlMetadata(url, { maxChars: 8000 });
    let summary: string | null = opts.note ?? null;
    let tags = normalizeTags(opts.tags ?? []);

    if (meta && meta.text.length > 200) {
      const result = await classifyJson({
        schema: summarySchema,
        system:
          "Summarize a web page for a personal bookmark library in 2-4 sentences, in the page's own language. Suggest up to 3 short lowercase topical tags.",
        prompt: `URL: ${meta.finalUrl}\nTitle: ${meta.title ?? ""}\n\n${truncate(meta.text, 6000)}`,
        cfg: ctx.config.llm.classifier,
        env: ctx.env,
        timeoutMs: 25_000,
      });
      if (result) {
        summary = [opts.note, result.summary].filter(Boolean).join("\n\n");
        tags = normalizeTags([...tags, ...result.tags]);
      }
    }

    const row = await upsertLink(ctx.db, {
      user_id: ctx.user.id,
      url,
      title: meta?.title ?? null,
      description: meta?.description ?? null,
      site_name: meta?.siteName ?? null,
      summary,
      project_id: opts.projectId ?? null,
      tags,
    });

    ctx.waitUntil(
      embedText(`${row.title ?? ""}\n${summary ?? ""}`.trim(), ctx.config.embeddings, ctx.env)
        .then((vec) =>
          vec ? updateLink(ctx.db, ctx.user.id, row.id, { embedding: JSON.stringify(vec) }) : undefined
        )
        .catch(() => {})
    );
    await insertAudit(ctx.db, {
      user_id: ctx.user.id,
      actor: "system",
      action: "link.ingest",
      entity_kind: "link",
      entity_id: row.id,
      details: { fetched: !!meta },
    });
    return row;
  } catch (err) {
    log("warn", "url_ingest_failed", { error: formatError(err) });
    return null;
  }
}
