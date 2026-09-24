import { z } from "zod";
import { defineTool } from "../registry";
import { webSearch } from "../../services/search/web";
import {
  canonicalMediaUrl,
  isDownloadableUrl,
  probeContentLength,
  resolveMediaDownload,
  SEND_BY_URL_MAX_BYTES,
  youTubeId,
} from "../../services/media/download";
import { insertAudit } from "../../database/repos/audit";
import { formatFileSize, truncate } from "../../utils/text";
import { formatError, log } from "../../utils/logger";

/**
 * The two tools that reach the open internet on the user's behalf: a search,
 * and a media download. Both are `external` — at autonomy 0-1 they ask first,
 * because both hand something of the user's (a query, a link) to a third-party
 * service — and both record what they did in the audit log.
 */
export const webTools = [
  defineTool({
    name: "web_search",
    description: [
      "Search the public web and get back titles, links and snippets.",
      "Use it for anything outside the user's own data: facts, prices, news, opening hours, documentation.",
      "Snippets are short — call read_url on a result to actually read the page before quoting it.",
      "Always tell the user where an answer came from.",
    ].join(" "),
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .max(300)
        .describe("what to search for, as you would type it into a search box"),
      limit: z.number().int().min(1).max(10).optional().describe("how many results (default 6)"),
    }),
    topics: ["search"],
    permissionLevel: "external",
    timeoutMs: 25_000,
    confirmLabel: (i) => `Search the web for "${truncate(i.query, 60)}"`,
    execute: async (input, ctx) => {
      const cfg = ctx.config.search;
      if (!cfg) {
        return {
          error:
            "web search is not configured on this deployment — tell the user you cannot look things up online",
        };
      }
      const outcome = await webSearch(cfg, input.query, {
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      });
      if ("error" in outcome) return outcome;

      ctx.waitUntil(
        insertAudit(ctx.db, {
          user_id: ctx.user.id,
          actor: "agent",
          action: "web.search",
          details: { query: truncate(input.query, 200), provider: outcome.provider },
        }).catch(() => {})
      );

      if (outcome.results.length === 0) {
        return {
          query: outcome.query,
          results: [],
          note: "no results — say so plainly rather than answering from memory",
        };
      }
      return {
        query: outcome.query,
        ...(outcome.answer ? { providerAnswer: outcome.answer } : {}),
        results: outcome.results,
        note: "snippets are not the page — read_url before quoting anything in detail",
      };
    },
  }),

  defineTool({
    name: "download_media",
    description: [
      "Download a video or its audio from YouTube (or another supported site) and send it into this chat.",
      "Set audioOnly for 'as mp3 / as a song / just the audio'.",
      "Files small enough are delivered in the chat; anything larger comes back as a direct link.",
    ].join(" "),
    inputSchema: z.object({
      url: z.string().url().describe("the video link the user sent"),
      audioOnly: z
        .boolean()
        .optional()
        .describe("true for audio only (mp3); default false = video with sound"),
      quality: z
        .enum(["144", "240", "360", "480", "720", "1080", "max"])
        .optional()
        .describe("maximum video height; default 720, which usually fits the chat size limit"),
      caption: z.string().max(200).optional().describe("a short caption to send with the file"),
    }),
    topics: ["media"],
    permissionLevel: "external",
    timeoutMs: 45_000,
    confirmLabel: (i) => `${i.audioOnly ? "Download audio from" : "Download"} ${truncate(i.url, 60)}`,
    execute: async (input, ctx) => {
      const cfg = ctx.config.mediaApi;
      if (!cfg) {
        return {
          error:
            "downloads are not configured on this deployment (MEDIA_API_URL is unset) — tell the user you cannot fetch videos",
        };
      }
      if (!isDownloadableUrl(input.url)) return { error: "that is not an http(s) link" };

      const source = canonicalMediaUrl(input.url);
      const resolved = await resolveMediaDownload(cfg, source, {
        ...(input.audioOnly !== undefined ? { audioOnly: input.audioOnly } : {}),
        ...(input.quality !== undefined ? { quality: input.quality } : {}),
      });
      if ("error" in resolved) {
        await insertAudit(ctx.db, {
          user_id: ctx.user.id,
          actor: "agent",
          action: "media.download",
          details: {
            url: truncate(source, 300),
            audioOnly: !!input.audioOnly,
            error: truncate(resolved.error, 200),
          },
          status: "error",
        }).catch(() => {});
        return { error: `could not fetch that: ${resolved.error}` };
      }

      const size = await probeContentLength(resolved.url);
      const fits = size !== null && size <= SEND_BY_URL_MAX_BYTES;
      let delivered = false;
      let sendError: string | null = null;

      if (fits && ctx.out.sendMediaByUrl) {
        try {
          await ctx.out.chatAction(ctx.chatRef, "upload_document").catch(() => {});
          await ctx.out.sendMediaByUrl(ctx.chatRef, resolved.url, {
            kind: resolved.kind,
            fileName: resolved.fileName,
            ...(input.caption ? { caption: input.caption } : {}),
          });
          delivered = true;
        } catch (err) {
          sendError = formatError(err);
          log("warn", "media_send_failed", { error: sendError });
        }
      }

      await insertAudit(ctx.db, {
        user_id: ctx.user.id,
        actor: "agent",
        action: "media.download",
        details: {
          url: truncate(source, 300),
          youtubeId: youTubeId(source),
          fileName: resolved.fileName,
          kind: resolved.kind,
          bytes: size,
          delivered,
          ...(sendError ? { sendError: truncate(sendError, 200) } : {}),
        },
        status: delivered ? "ok" : "partial",
      }).catch(() => {});

      if (delivered) {
        return {
          delivered: true,
          fileName: resolved.fileName,
          kind: resolved.kind,
          size: size === null ? null : formatFileSize(size),
          note: "the file is already in the chat — confirm it briefly and do NOT repeat the link",
        };
      }
      return {
        delivered: false,
        fileName: resolved.fileName,
        kind: resolved.kind,
        size: size === null ? null : formatFileSize(size),
        downloadUrl: resolved.url,
        reason: sendError
          ? "the chat refused the file"
          : size === null
            ? "the file size is unknown"
            : `the file is larger than ${formatFileSize(SEND_BY_URL_MAX_BYTES)}`,
        note: "give the user the downloadUrl as a link and say why it was not sent as a file; the link is temporary",
      };
    },
  }),
];
