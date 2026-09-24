/**
 * Web dashboard entry. Owns every `/api/*` and `/auth/*` request; returns null
 * for anything else so the worker's existing routes (and then the static asset
 * server) keep handling it.
 */
import type { Env } from "../env";
import { loadConfig } from "../config";
import { createDb } from "../database/client";
import { log, formatError } from "../utils/logger";
import { HttpError, json } from "./http";
import { handleApi } from "./api";
import { handleLoginCallback, resolveSession } from "./auth";

export function isWebRoute(pathname: string): boolean {
  return pathname === "/auth/callback" || pathname === "/api" || pathname.startsWith("/api/");
}

export async function handleWeb(
  request: Request,
  env: Env,
  url: URL,
  waitUntil: (p: Promise<unknown>) => void
): Promise<Response | null> {
  if (!isWebRoute(url.pathname)) return null;

  try {
    const config = loadConfig(env);
    const db = createDb(config.supabase.url, config.supabase.serviceRoleKey);

    if (url.pathname === "/auth/callback") {
      if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
      // Deliberately does not take `db`: a GET here must not touch stored state.
      return await handleLoginCallback(env, url, Date.now());
    }

    const session = await resolveSession(request, env, db, Date.now());
    return await handleApi(request, env, url, db, session, waitUntil);
  } catch (err) {
    if (err instanceof HttpError) {
      // 401 is the normal signed-out state, not an incident — don't log it.
      if (err.status !== 401) {
        log("warn", "web.request_rejected", { path: url.pathname, status: err.status });
      }
      return json({ error: err.message }, err.status);
    }
    // Repo errors carry table/op/code but no row values or key material, so
    // they are safe to return to the signed-in owner of the data.
    log("error", "web.request_failed", { path: url.pathname, error: formatError(err) });
    return json({ error: formatError(err) }, 500);
  }
}
