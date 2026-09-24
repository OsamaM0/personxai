#!/usr/bin/env node
/**
 * Reset the whole database or one module of it.
 *
 *   npm run db:reset -- wallet              wipe every wallet entry (schema kept)
 *   npm run db:reset -- tasks notes         several modules at once
 *   npm run db:reset -- all                 wipe every row in every table (users too)
 *   npm run db:reset -- all --drop          drop every table/type/function and
 *                                           rebuild the schema from supabase/schema.sql
 *   npm run db:reset -- list                show the modules and their tables
 *
 * Flags
 *   --dry-run            only show row counts / the SQL that would run
 *   --yes                skip the confirmation prompt (CI, scripts)
 *   --db-url <url>       Postgres connection string for --drop (or DATABASE_URL);
 *                        runs the SQL through `psql`. Without it the SQL is written
 *                        to a file for you to paste into the Supabase SQL editor.
 *
 * Data resets go through the REST API with the service_role key from
 * secrets.json / .dev.vars / the environment — the same credentials the Worker
 * uses, so it works on any install (Cloudflare, Docker, Vercel) with no extra
 * setup. Rows are deleted in batches so the 8 s statement timeout never bites.
 *
 * `--drop` cannot run through REST (DDL needs a SQL connection), which is why
 * it either needs a connection string + psql or hands you a file to paste.
 *
 * Zero dependencies — Node 20+ only, like scripts/setup.mjs.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");
const SCHEMA = join(ROOT, "supabase", "schema.sql");

const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};
const say = (s = "") => console.log(s);
const ok = (s) => say(c.green("  ✔ ") + s);
const warn = (s) => say(c.yellow("  ! ") + s);
const fail = (s) => say(c.red("  ✖ ") + s);
const die = (s) => { fail(s); process.exit(1); };
const UA = { "user-agent": "personxai-reset/1.0" };

// ── Modules ──────────────────────────────────────────────────────────────
// Tables listed child-first so a wipe never trips a foreign key. A module is
// what a user thinks of as one thing ("my tasks", "the wallet"); `all` is
// every module with `core` (users) last, since deleting a user cascades.
const MODULES = {
  core:          ["audit_logs", "settings", "user_identities", "users"],
  conversations: ["messages", "conversations"],
  runs:          ["tool_calls", "agent_runs"],
  projects:      ["project_members", "projects"],
  tasks:         ["task_dependencies", "tasks"],
  notes:         ["notes"],
  inbox:         ["inbox_items"],
  reminders:     ["job_outbox", "reminders"],
  files:         ["file_tags", "file_chunks", "files", "tags"],
  vaults:        ["vault_channels"],
  memory:        ["user_facts", "memories"],
  links:         ["links"],
  skills:        ["system_prompts", "mcp_servers", "skills"],
  wallet:        ["wallet_entries"],
};
const ALL_ORDER = [...Object.keys(MODULES).filter((m) => m !== "core"), "core"];
const NOTES = {
  core: "deletes every user — everything else cascades with them",
  projects: "tasks, notes, files, memories and wallet entries keep existing but lose their project",
  files: "the Telegram vault channel keeps the messages; only the index is dropped",
  skills: "includes built-in (global) skills, MCP servers and system prompts",
};

// ── Schema introspection (from the migration files, so new modules are noticed)
function introspect() {
  const tables = new Map(); // name -> first column (used as the delete/order key)
  const types = [];
  const functions = [];
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    for (const m of sql.matchAll(/^create table (?:if not exists )?public\.(\w+)\s*\(\s*\n\s*(\w+)/gm)) tables.set(m[1], m[2]);
    for (const m of sql.matchAll(/^create type public\.(\w+)/gm)) types.push(m[1]);
    for (const m of sql.matchAll(/^create (?:or replace )?function public\.(\w+)\s*\(/gm)) if (!functions.includes(m[1])) functions.push(m[1]);
  }
  return { tables, types, functions };
}

// ── Credentials (same lookup as setup.mjs) ──────────────────────────────
function loadCreds() {
  const out = {};
  const secretsPath = join(ROOT, "secrets.json");
  if (existsSync(secretsPath)) {
    try { Object.assign(out, JSON.parse(readFileSync(secretsPath, "utf8"))); } catch {}
  }
  const devVars = join(ROOT, ".dev.vars");
  if (existsSync(devVars)) {
    for (const line of readFileSync(devVars, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !(m[1] in out)) out[m[1]] = m[2].trim();
    }
  }
  for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "DATABASE_URL"]) if (process.env[k]) out[k] = process.env[k];
  return out;
}

// ── REST helpers ─────────────────────────────────────────────────────────
function rest(creds) {
  const base = creds.SUPABASE_URL.replace(/\/+$/, "") + "/rest/v1/";
  const headers = { apikey: creds.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${creds.SUPABASE_SERVICE_ROLE_KEY}`, ...UA };
  return {
    async count(table) {
      const r = await fetch(`${base}${table}?select=*`, { method: "HEAD", headers: { ...headers, prefer: "count=exact" } });
      if (r.status === 404) return null; // table not in this database (migration not applied)
      if (!r.ok) throw new Error(`${table}: HTTP ${r.status} ${await r.text()}`);
      return Number((r.headers.get("content-range") ?? "*/0").split("/")[1]);
    },
    // PostgREST "limited delete": needs an order + a filter; loop until drained.
    async wipe(table, key, batch = 1000) {
      let total = 0;
      for (;;) {
        const r = await fetch(`${base}${table}?${key}=not.is.null&order=${key}&limit=${batch}&select=${key}`, {
          method: "DELETE", headers: { ...headers, prefer: "return=representation" },
        });
        if (!r.ok) throw new Error(`${table}: HTTP ${r.status} ${await r.text()}`);
        const n = (await r.json()).length;
        total += n;
        if (n < batch) return total;
      }
    },
  };
}

// ── --drop: SQL that tears down every known object, then schema.sql ─────
function buildDropSql({ tables, types, functions }) {
  const lines = [
    "-- PersonXAI — GENERATED by scripts/reset-db.mjs. Drops every PersonXAI object",
    "-- in `public` (nothing else) and re-applies supabase/schema.sql.",
    "begin;",
    ...functions.map((f) => `drop function if exists public.${f} cascade;`),
    ...[...tables.keys()].map((t) => `drop table if exists public.${t} cascade;`),
    ...types.map((t) => `drop type if exists public.${t} cascade;`),
    "commit;",
    "",
    readFileSync(SCHEMA, "utf8"),
  ];
  return lines.join("\n");
}

// ── CLI ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const dbUrlIdx = argv.indexOf("--db-url");
const targets = argv.filter((a, i) => !a.startsWith("--") && (dbUrlIdx < 0 || i !== dbUrlIdx + 1));
const dryRun = flags.has("--dry-run");
const drop = flags.has("--drop");
const schema = introspect();

// Keep MODULES honest: a table created by a migration but missing here would
// silently survive `all`.
const covered = new Set(Object.values(MODULES).flat());
const unknown = [...schema.tables.keys()].filter((t) => !covered.has(t));
const stale = [...covered].filter((t) => !schema.tables.has(t));
if (unknown.length) die(`tables in supabase/migrations not assigned to a module in scripts/reset-db.mjs: ${unknown.join(", ")}`);
if (stale.length) die(`scripts/reset-db.mjs lists tables no migration creates: ${stale.join(", ")}`);

if (!targets.length || targets.includes("list") || flags.has("--help")) {
  say(c.bold("\nUsage: npm run db:reset -- <module…|all> [--drop] [--dry-run] [--yes] [--db-url <postgres url>]\n"));
  say(c.bold("Modules"));
  for (const [m, t] of Object.entries(MODULES)) say(`  ${c.cyan(m.padEnd(14))} ${t.join(", ")}${NOTES[m] ? c.dim(`  — ${NOTES[m]}`) : ""}`);
  say(`  ${c.cyan("all".padEnd(14))} every module above, users last`);
  process.exit(targets.length && !targets.includes("list") ? 1 : 0);
}

const isAll = targets.includes("all");
const modules = isAll ? ALL_ORDER : targets;
for (const m of modules) if (!MODULES[m]) die(`unknown module "${m}" — run \`npm run db:reset -- list\``);
if (drop && !isAll) die("--drop rebuilds the whole schema; use it with `all` (per-module resets keep the schema and wipe rows)");

const creds = loadCreds();

// ── Mode 1: --drop (DDL) ─────────────────────────────────────────────────
if (drop) {
  const sql = buildDropSql(schema);
  const out = join(tmpdir(), "personxai-reset.sql");
  writeFileSync(out, sql);
  say(`\n${c.bold("Drop & rebuild")}: ${schema.tables.size} tables, ${schema.types.length} types, ${schema.functions.length} functions, then schema.sql`);
  say(`  SQL written to ${c.cyan(out)}`);
  const dbUrl = dbUrlIdx >= 0 ? argv[dbUrlIdx + 1] : creds.DATABASE_URL;
  const hasPsql = spawnSync("psql", ["--version"], { shell: process.platform === "win32", encoding: "utf8" }).status === 0;
  if (dryRun) { say(c.dim("  --dry-run: nothing executed")); process.exit(0); }
  if (dbUrl && hasPsql) {
    await confirm("all --drop", `This DROPS every PersonXAI table (all data, every user) and recreates the schema on\n  ${dbUrl.replace(/:[^:@/]+@/, ":••••@")}`);
    const res = spawnSync("psql", [dbUrl, "-v", "ON_ERROR_STOP=1", "-q", "-f", out], { stdio: "inherit", shell: process.platform === "win32" });
    if (res.status !== 0) die(`psql exited with ${res.status} — the drop ran in a transaction, so nothing is half-applied`);
    ok("schema dropped and rebuilt");
  } else {
    if (dbUrl && !hasPsql) warn("psql is not installed, so the SQL was not executed automatically");
    else warn("no --db-url / DATABASE_URL, so the SQL was not executed automatically");
    const ref = (creds.SUPABASE_URL ?? "").match(/https:\/\/([a-z0-9-]+)\.supabase\.co/)?.[1] ?? "_";
    say(`\n  Paste the file into ${c.cyan(`https://supabase.com/dashboard/project/${ref}/sql/new`)} and press Run.`);
    say(c.dim("  (or: Project Settings → Database → Connection string, then re-run with --db-url)"));
  }
  process.exit(0);
}

// ── Mode 2: data wipe (REST) ─────────────────────────────────────────────
if (!creds.SUPABASE_URL || !creds.SUPABASE_SERVICE_ROLE_KEY) {
  die("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY not found in secrets.json, .dev.vars or the environment (run `npm run setup`)");
}
const api = rest(creds);
const plan = [];
for (const m of modules) for (const t of MODULES[m]) plan.push({ module: m, table: t, key: schema.tables.get(t) });

say(`\n${c.bold(isAll ? "Reset ALL data" : `Reset ${modules.join(", ")}`)} on ${c.cyan(creds.SUPABASE_URL)}\n`);
let missing = 0;
for (const p of plan) {
  p.rows = await api.count(p.table);
  if (p.rows === null) { missing++; say(`  ${c.dim(p.table.padEnd(20))} ${c.yellow("table missing")} ${c.dim("(migration not applied)")}`); }
  else say(`  ${p.table.padEnd(20)} ${String(p.rows).padStart(8)} rows`);
}
for (const m of modules) if (NOTES[m]) warn(`${m}: ${NOTES[m]}`);
const total = plan.reduce((n, p) => n + (p.rows ?? 0), 0);
say(`\n  ${c.bold(total)} rows across ${plan.length - missing} tables`);
if (dryRun) { say(c.dim("  --dry-run: nothing deleted")); process.exit(0); }
if (!total) { ok("nothing to delete"); process.exit(0); }

await confirm(isAll ? "all" : modules.join(" "), `This permanently deletes the ${total} rows listed above. There is no undo.`);

for (const p of plan) {
  if (p.rows === null) continue;
  try {
    const n = await api.wipe(p.table, p.key);
    ok(`${p.table.padEnd(20)} ${String(n).padStart(8)} deleted`);
  } catch (e) {
    die(`${e.message}\n  (earlier tables in the list are already wiped; re-run to continue)`);
  }
}
ok(isAll ? "database is empty — the owner is re-created on their next message" : "done");

async function confirm(word, text) {
  say(`\n${c.red(c.bold("  DANGER"))} ${text}`);
  if (flags.has("--yes")) return;
  if (!stdin.isTTY) die("refusing to run non-interactively without --yes");
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = (await rl.question(`  Type ${c.bold(word)} to continue: `)).trim();
  rl.close();
  if (answer !== word) die("aborted — nothing was changed");
}
