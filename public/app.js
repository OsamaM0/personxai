/**
 * PersonXAI dashboard client.
 *
 * Plain ES modules, no build step — the whole app is three static files served
 * by Cloudflare's asset host next to the worker, so `wrangler deploy` ships the
 * UI and the API together.
 */

// ── Tiny DOM/HTML helpers ────────────────────────────────────────────────────

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** Marks a string as already-safe HTML so `html` will not escape it again. */
const raw = (s) => ({ __raw: String(s ?? "") });

/** Tagged template that escapes every interpolation unless wrapped in raw(). */
function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    out += Array.isArray(v)
      ? v.map((item) => (item && item.__raw !== undefined ? item.__raw : esc(item))).join("")
      : v && v.__raw !== undefined
        ? v.__raw
        : esc(v);
    out += strings[i + 1];
  }
  return out;
}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ── Formatting ───────────────────────────────────────────────────────────────

const fmtDate = (iso, withTime = true) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const opts = withTime
    ? { dateStyle: "medium", timeStyle: "short" }
    : { dateStyle: "medium" };
  return new Intl.DateTimeFormat(undefined, opts).format(d);
};

/** "in 3h" / "2d ago" — the scannable form for due dates and triggers. */
const fmtRelative = (iso) => {
  if (!iso) return "—";
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return "—";
  const abs = Math.abs(ms);
  // [upper bound, unit, ms per unit] — pick the first bucket the delta fits in.
  const units = [
    [60_000, "second", 1000],
    [3_600_000, "minute", 60_000],
    [86_400_000, "hour", 3_600_000],
    [2_592_000_000, "day", 86_400_000],
    [31_536_000_000, "month", 2_592_000_000],
    [Infinity, "year", 31_536_000_000],
  ];
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [limit, unit, divisor] of units) {
    if (abs < limit) return rtf.format(Math.round(ms / divisor), unit);
  }
  return fmtDate(iso);
};

const fmtBytes = (n) => {
  if (!n && n !== 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value < 10 && i > 0 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
};

const fmtNum = (n) => new Intl.NumberFormat().format(n ?? 0);
/** "1,250.50 EGP" — Latin digits, and no trailing .00 on whole amounts. */
const fmtMoney = (amount, currency) => {
  const value = Number(amount ?? 0);
  const text = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
  return currency ? `${text} ${currency}` : text;
};

const truncate = (s, n = 140) => (s && s.length > n ? `${s.slice(0, n)}…` : s ?? "");

/** `<input type="datetime-local">` wants local wall-clock, not an ISO instant. */
function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const fromLocalInput = (value) => (value ? new Date(value).toISOString() : null);

// ── Telegram Mini App ────────────────────────────────────────────────────────
// The dashboard doubles as the bot's Mini App. When Telegram hosts the page it
// injects window.Telegram.WebApp and hands us a signed initData string; posting
// that to /api/auth/miniapp starts the same session a magic link would, so the
// menu button opens straight into a signed-in dashboard.

/** Truthy only inside Telegram — a plain browser has no initData to send. */
const miniApp = window.Telegram?.WebApp?.initData ? window.Telegram.WebApp : null;

/** Last failure from signInWithTelegram, so the login card can explain itself. */
let miniAppError = "";

/** Telegram's palette drives the same variables the stylesheet already uses. */
const THEME_VARS = {
  bg_color: "--bg",
  // section_bg_color is Telegram's card colour, so it maps to ours (--bg-2),
  // not to secondary_bg_color, which is the shade *behind* a section.
  section_bg_color: "--bg-2",
  secondary_bg_color: "--bg-3",
  text_color: "--fg",
  hint_color: "--fg-2",
  subtitle_text_color: "--fg-3",
  button_color: "--accent",
  button_text_color: "--accent-fg",
  section_separator_color: "--line",
  destructive_text_color: "--danger",
};

function applyTelegramTheme() {
  if (!miniApp) return;
  const root = document.documentElement;
  root.style.colorScheme = miniApp.colorScheme === "light" ? "light" : "dark";
  const params = miniApp.themeParams ?? {};
  for (const [key, cssVar] of Object.entries(THEME_VARS)) {
    // Only override what Telegram actually sent; the rest keeps our defaults.
    if (params[key]) root.style.setProperty(cssVar, params[key]);
  }
}

function initMiniApp() {
  if (!miniApp) return;
  miniApp.ready();
  miniApp.expand();
  // Without this a downward flick on any list closes the whole app.
  miniApp.disableVerticalSwipes?.();
  document.body.classList.add("in-miniapp");
  applyTelegramTheme();
  miniApp.onEvent?.("themeChanged", applyTelegramTheme);
}

/**
 * Trade initData for a session cookie. Deliberately a bare fetch rather than
 * api(): this IS the 401 recovery path, so it must not recurse into one.
 */
async function signInWithTelegram() {
  if (!miniApp) return false;
  try {
    const res = await fetch("/api/auth/miniapp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initData: miniApp.initData }),
      credentials: "same-origin",
    });
    if (res.ok) {
      miniAppError = "";
      return true;
    }
    const payload = await res.json().catch(() => null);
    miniAppError = payload?.error ?? `sign-in failed (${res.status})`;
  } catch {
    miniAppError = "could not reach the server";
  }
  return false;
}

// ── API client ───────────────────────────────────────────────────────────────

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(path, { method = "GET", body, retried = false } = {}) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  if (res.status === 204) return null;

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  if (!res.ok) {
    if (res.status === 401) {
      // Inside Telegram the launch initData can mint a fresh session, so an
      // expired cookie is recoverable without bouncing anyone to a login card.
      if (miniApp && !retried && (await signInWithTelegram())) {
        return api(path, { method, body, retried: true });
      }
      // A first visit is simply signed out; only an established session "ends".
      showLogin(state.user ? "Your session ended. Request a new link to sign back in." : "");
      throw new ApiError(401, "signed out");
    }
    throw new ApiError(res.status, payload?.error ?? `request failed (${res.status})`);
  }
  return payload;
}

// ── Toasts ───────────────────────────────────────────────────────────────────

function toast(message, kind = "") {
  const node = document.createElement("div");
  node.className = `toast ${kind}`;
  node.textContent = message;
  $("#toasts").append(node);
  setTimeout(() => node.remove(), kind === "err" ? 6000 : 3200);
}

/** Run an action, surface failures as a toast, and refresh on success. */
async function act(fn, { success, refresh = true } = {}) {
  try {
    const result = await fn();
    invalidateTags();
    if (success) toast(success, "ok");
    if (refresh) await render();
    return result;
  } catch (err) {
    if (err.status !== 401) toast(err.message, "err");
    return null;
  }
}

// ── Modal ────────────────────────────────────────────────────────────────────

const modalRoot = $("#modal-root");
let modalSubmit = null;

function fieldHtml(f) {
  const id = `f-${f.name}`;
  const common = `id="${esc(id)}" name="${esc(f.name)}"${f.required ? " required" : ""}${
    f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ""
  }`;
  let control;
  if (f.type === "textarea") {
    control = html`<textarea ${raw(common)} rows="${f.rows ?? 6}">${f.value ?? ""}</textarea>`;
  } else if (f.type === "select") {
    const options = (f.options ?? []).map(
      (o) => html`<option value="${o.value}" ${raw(String(o.value) === String(f.value ?? "") ? "selected" : "")}>${o.label}</option>`
    );
    control = html`<select ${raw(common)}>${raw(options.join(""))}</select>`;
  } else if (f.type === "checkbox") {
    return html`<div class="field checkbox">
      <input type="checkbox" ${raw(common)} ${raw(f.value ? "checked" : "")} />
      <label for="${id}" style="margin:0">${f.label}</label>
    </div>`;
  } else {
    control = html`<input type="${f.type ?? "text"}" ${raw(common)} value="${f.value ?? ""}" />`;
  }
  return html`<div class="field">
    <label for="${id}">${f.label}</label>
    ${raw(control)}
    ${raw(f.help ? html`<div class="muted small" style="margin-top:5px">${f.help}</div>` : "")}
  </div>`;
}

/**
 * Open a form modal. `onSubmit(values)` may throw to keep the modal open with
 * the error shown inline.
 */
function openModal({ title, fields, submitLabel = "Save", onSubmit }) {
  $("#modal-title").textContent = title;
  $("#modal-submit").textContent = submitLabel;
  $("#modal-error").textContent = "";
  const form = $("#modal-form");
  form.innerHTML = fields
    .map((f) => (f.type === "row" ? html`<div class="field-row">${raw(f.fields.map(fieldHtml).join(""))}</div>` : fieldHtml(f)))
    .join("");
  modalSubmit = onSubmit;
  modalRoot.hidden = false;
  const first = form.querySelector("input, textarea, select");
  if (first) first.focus();
}

function closeModal() {
  modalRoot.hidden = true;
  modalSubmit = null;
  $("#modal-form").innerHTML = "";
}

function formValues() {
  const out = {};
  for (const el of $$("#modal-form [name]")) {
    out[el.name] = el.type === "checkbox" ? el.checked : el.value;
  }
  return out;
}

modalRoot.addEventListener("click", (e) => {
  if (e.target.closest("[data-close]")) closeModal();
});

$("#modal-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!modalSubmit) return;
  const button = $("#modal-submit");
  button.disabled = true;
  try {
    await modalSubmit(formValues());
    invalidateTags();
    closeModal();
    await render();
  } catch (err) {
    $("#modal-error").textContent = err.message ?? "failed";
  } finally {
    button.disabled = false;
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !modalRoot.hidden) closeModal();
});

// ── Shared render pieces ─────────────────────────────────────────────────────

const state = {
  user: null,
  projects: [],
  walletCurrency: null,
  system: null,
  conversationId: null,
};

const projectName = (id) => state.projects.find((p) => p.id === id)?.name ?? "—";

const projectOptions = (blankLabel = "— no project —") => [
  { value: "", label: blankLabel },
  ...state.projects.map((p) => ({ value: p.id, label: p.name })),
];

const STATUS_TONE = {
  done: "badge-ok", completed: "badge-ok", active: "badge-ok", delivered: "badge-ok",
  blocked: "badge-bad", failed: "badge-bad", cancelled: "badge-bad", dead_letter: "badge-bad",
  waiting: "badge-warn", paused: "badge-warn", in_progress: "badge-accent", scheduled: "badge-accent",
};
const badge = (text, tone) => html`<span class="badge ${tone ?? STATUS_TONE[text] ?? ""}">${text}</span>`;

const card = (title, bodyHtml, { actions = "", flush = false } = {}) => html`<div class="card">
  <div class="card-head"><h3>${title}</h3><span class="spacer"></span>${raw(actions)}</div>
  <div class="card-body ${raw(flush ? "flush" : "")}">${raw(bodyHtml)}</div>
</div>`;

const table = (headers, rows, emptyText = "Nothing here yet.") =>
  rows.length === 0
    ? html`<div class="empty">${emptyText}</div>`
    : html`<div class="table-wrap"><table>
        <thead><tr>${raw(headers.map((h) => html`<th>${h}</th>`).join(""))}</tr></thead>
        <tbody>${raw(rows.join(""))}</tbody>
      </table></div>`;

const btn = (label, action, id, { cls = "btn-ghost btn-sm", title = "" } = {}) =>
  html`<button class="btn ${raw(cls)}" data-act="${action}" data-id="${id}" title="${title}">${label}</button>`;

const stat = (n, k, tone = "") => html`<div class="stat ${raw(tone)}"><div class="n">${n}</div><div class="k">${k}</div></div>`;

const TASK_STATUSES = ["inbox", "todo", "in_progress", "waiting", "blocked", "done", "cancelled"];
const PROJECT_STATUSES = ["idea", "planned", "active", "waiting", "blocked", "completed", "archived"];
const PRIORITIES = ["critical", "high", "medium", "low"];
const MEMORY_TYPES = ["preference", "decision", "project_context", "fact", "workflow", "event"];
const opts = (list) => list.map((v) => ({ value: v, label: v.replace(/_/g, " ") }));

// ── Tags, grouping (Odoo-style "Group by" + filter chips) ─────────────────────

const GROUP_LABELS = {
  none: "No grouping", project: "Project", status: "Status", priority: "Priority", tag: "Tag",
  kind: "Kind", type: "Type", channel: "Channel", date: "Date", vault: "Channel",
  category: "Category", direction: "Kind",
};

let tagCache = { at: 0, items: [] };
/** Tag facets are cheap (one indexed RPC) but shared by many views — cache for 30 s. */
async function loadTags() {
  if (Date.now() - tagCache.at < 30_000) return tagCache.items;
  try {
    const { items } = await api("/api/tags");
    tagCache = { at: Date.now(), items };
  } catch {
    tagCache = { at: Date.now(), items: [] };
  }
  return tagCache.items;
}
const invalidateTags = () => { tagCache.at = 0; };

let vaultCache = { at: 0, items: [] };
async function loadVaults(force = false) {
  if (!force && Date.now() - vaultCache.at < 30_000) return vaultCache.items;
  try {
    const { items } = await api("/api/vault");
    vaultCache = { at: Date.now(), items };
  } catch {
    vaultCache = { at: Date.now(), items: [] };
  }
  return vaultCache.items;
}
const vaultName = (chatId) => vaultCache.items.find((v) => v.chat_id === chatId)?.title ?? (chatId ? "Channel" : "—");

const activeTags = (params) => (params.tag ? params.tag.split(",").filter(Boolean) : []);

/** Keep only rows carrying every active tag (AND). `pick` extracts the tags array. */
function filterByTags(items, params, pick = (x) => x.tags) {
  const want = activeTags(params);
  if (want.length === 0) return items;
  return items.filter((it) => want.every((tag) => (pick(it) ?? []).includes(tag)));
}

/** Clickable tag chips for one entity kind; active ones are highlighted. */
function tagChips(kind, params, facets) {
  const active = new Set(activeTags(params));
  const chips = facets
    .filter((f) => (kind ? f.counts?.[kind] : f.total) > 0)
    .slice(0, 40)
    .map((f) => html`<button class="chip ${raw(active.has(f.name) ? "active" : "")}" data-chip="${f.name}" type="button">#${f.name} <small>${kind ? f.counts[kind] : f.total}</small></button>`);
  if (chips.length === 0 && active.size === 0) return "";
  const clear = active.size > 0 ? html`<button class="chip clear" data-chip="" type="button">✕ clear</button>` : "";
  return html`<div class="chips">${raw(chips.join(""))}${raw(clear)}</div>`;
}

/** "Group by" select for the toolbar. */
function groupSelect(params, options) {
  return html`<select data-filter="by" title="Group by">
    ${raw(options.map((o) => html`<option value="${o}" ${raw(o === (params.by ?? options[0]) ? "selected" : "")}>${o === "none" ? "No grouping" : `Group by ${GROUP_LABELS[o] ?? o}`}</option>`).join(""))}
  </select>`;
}

/**
 * Render rows either as one table or as one collapsible card per group.
 * `rows[i]` is the HTML for `items[i]`; `keyOf(item)` yields the group label.
 */
function groupedCards(title, headers, items, rows, params, keyOf, emptyText, defaultBy = "none") {
  const by = params.by ?? defaultBy;
  if (by === "none" || !keyOf) return card(title, table(headers, rows, emptyText), { flush: true });
  const groups = new Map();
  items.forEach((it, i) => {
    const key = keyOf(it, by) ?? "—";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rows[i]);
  });
  if (groups.size === 0) return card(title, table(headers, [], emptyText), { flush: true });
  const sink = new Set(["Unfiled", "Untagged", "No date", "—", "Not in a channel"]);
  const keys = [...groups.keys()].sort((a, b) => (sink.has(a) ? 1 : 0) - (sink.has(b) ? 1 : 0) || String(a).localeCompare(String(b)));
  return keys
    .map((key) => html`<details class="group" open>
      <summary><span class="group-title">${key}</span> <span class="badge">${groups.get(key).length}</span></summary>
      ${raw(table(headers, groups.get(key), emptyText))}
    </details>`)
    .join("");
}

const firstTag = (tags) => (tags && tags[0] ? `#${tags[0]}` : "Untagged");
const dayOf = (iso) => (iso ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(iso)) : "No date");

// ── Views ────────────────────────────────────────────────────────────────────

const ACTIONS = {};
const VIEWS = {};

// Overview ────────────────────────────────────────────────────────────────────

VIEWS.overview = {
  title: "Overview",
  async render() {
    const data = await api("/api/overview");
    const u = data.usage24h;

    const taskRows = data.tasksDueSoon.map(
      (t) => html`<tr>
        <td class="wrap">
          <div class="cell-title">${t.title}</div>
          <div class="cell-sub">${projectName(t.project_id)} · ${t.priority}</div>
        </td>
        <td>${raw(badge(t.status))}</td>
        <td title="${fmtDate(t.due_at)}">${fmtRelative(t.due_at)}</td>
        <td class="actions">${raw(btn("Done", "task:done", t.id))}</td>
      </tr>`
    );

    const reminderRows = data.reminders.map(
      (r) => html`<tr>
        <td class="wrap">${truncate(r.content ?? r.raw_text, 90)}</td>
        <td>${raw(badge(r.status))}</td>
        <td title="${fmtDate(r.next_trigger_at)}">${fmtRelative(r.next_trigger_at)}</td>
      </tr>`
    );

    return html`
      <div class="stats">
        ${raw(stat(fmtNum(data.overdueCount), "Overdue tasks", data.overdueCount > 0 ? "bad" : ""))}
        ${raw(stat(fmtNum(data.tasksDueSoon.length), "Due in 24h"))}
        ${raw(stat(fmtNum(data.inboxPending), "Inbox pending", data.inboxPending > 0 ? "alert" : ""))}
        ${raw(stat(fmtNum(data.reminderCount), "Live reminders"))}
        ${raw(stat(fmtNum(data.activeProjects), "Active projects"))}
        ${raw(
          data.walletMonth
            ? stat(
                fmtMoney(data.walletMonth.moneyOut, data.walletMonth.currency),
                "Spent · this month",
                data.walletMonth.net < 0 ? "alert" : ""
              )
            : ""
        )}
        ${raw(stat(fmtNum(u.runs), "Agent runs · 24h"))}
        ${raw(stat(fmtNum(u.promptTokens + u.completionTokens), "Tokens · 24h"))}
        ${raw(stat(fmtNum(u.toolCalls), "Tool calls · 24h"))}
      </div>

      ${raw(
        card("Quick actions", html`<div class="toolbar">
          ${raw(btn("New task", "task:new", "", { cls: "btn-primary btn-sm" }))}
          ${raw(btn("New reminder", "reminder:new", "", { cls: "btn-sm" }))}
          ${raw(btn("New expense", "wallet:new-out", "", { cls: "btn-sm" }))}
          ${raw(btn("Run dispatcher now", "system:dispatch", "", { cls: "btn-sm" }))}
          ${raw(btn("Send daily brief", "system:brief", "", { cls: "btn-sm" }))}
          ${raw(btn("Send heartbeat", "system:heartbeat", "", { cls: "btn-sm" }))}
        </div>`)
      )}

      ${raw(card("Due in the next 24 hours", table(["Task", "Status", "Due", ""], taskRows, "Nothing due — enjoy it."), { flush: true }))}
      ${raw(card("Upcoming reminders", table(["Reminder", "Status", "Fires"], reminderRows, "No reminders scheduled."), { flush: true }))}
    `;
  },
};

// Tasks ───────────────────────────────────────────────────────────────────────

VIEWS.tasks = {
  title: "Tasks",
  async render(params) {
    const query = new URLSearchParams();
    if (params.status) query.set("status", params.status);
    if (params.project_id) query.set("project_id", params.project_id);
    if (params.overdue === "true") query.set("overdue", "true");
    query.set("limit", "200");
    const [{ items: fetched }, facets] = await Promise.all([api(`/api/tasks?${query}`), loadTags()]);
    const items = filterByTags(fetched, params);

    const rows = items.map(
      (t) => html`<tr>
        <td class="wrap">
          <div class="cell-title">${t.title}</div>
          ${raw(t.description ? html`<div class="cell-sub">${truncate(t.description, 120)}</div>` : "")}
          ${raw(t.tags?.length ? html`<div class="cell-sub">${raw(t.tags.map((tag) => badge(tag)).join(" "))}</div>` : "")}
        </td>
        <td>${projectName(t.project_id)}</td>
        <td>${raw(badge(t.status))}</td>
        <td>${raw(badge(t.priority, t.priority === "critical" ? "badge-bad" : t.priority === "high" ? "badge-warn" : ""))}</td>
        <td title="${fmtDate(t.due_at)}">${fmtRelative(t.due_at)}</td>
        <td class="actions">
          ${raw(t.status === "done" ? btn("Reopen", "task:reopen", t.id) : btn("Done", "task:done", t.id))}
          ${raw(btn("Edit", "task:edit", t.id))}
          ${raw(btn("Delete", "task:del", t.id, { cls: "btn-ghost btn-sm btn-danger" }))}
        </td>
      </tr>`
    );

    return html`
      <div class="toolbar">
        ${raw(btn("New task", "task:new", "", { cls: "btn-primary btn-sm" }))}
        <select data-filter="status">
          ${raw([
            { value: "", label: "Open tasks" },
            { value: TASK_STATUSES.join(","), label: "All statuses" },
            ...opts(TASK_STATUSES),
          ].map((o) => html`<option value="${o.value}" ${raw(o.value === (params.status ?? "") ? "selected" : "")}>${o.label}</option>`).join(""))}
        </select>
        <select data-filter="project_id">
          ${raw([{ value: "", label: "All projects" }, ...state.projects.map((p) => ({ value: p.id, label: p.name }))]
            .map((o) => html`<option value="${o.value}" ${raw(o.value === (params.project_id ?? "") ? "selected" : "")}>${o.label}</option>`)
            .join(""))}
        </select>
        <label class="checkbox" style="margin:0">
          <input type="checkbox" data-filter="overdue" value="true" ${raw(params.overdue === "true" ? "checked" : "")} />
          Overdue only
        </label>
        ${raw(groupSelect(params, ["none", "project", "status", "priority", "tag", "date"]))}
        <span class="spacer"></span>
        <span class="muted small">${items.length} shown</span>
      </div>
      ${raw(tagChips("task", params, facets))}
      ${raw(groupedCards("Tasks", ["Task", "Project", "Status", "Priority", "Due", ""], items, rows, params, (t, by) =>
        by === "project" ? (t.project_id ? projectName(t.project_id) : "Unfiled")
        : by === "status" ? t.status : by === "priority" ? t.priority
        : by === "tag" ? firstTag(t.tags) : dayOf(t.due_at)))}
    `;
  },
};

const taskFields = (t = {}) => [
  { name: "title", label: "Title", value: t.title, required: true },
  { name: "description", label: "Description", type: "textarea", rows: 4, value: t.description ?? "" },
  {
    type: "row",
    fields: [
      { name: "status", label: "Status", type: "select", options: opts(TASK_STATUSES), value: t.status ?? "todo" },
      { name: "priority", label: "Priority", type: "select", options: opts(PRIORITIES), value: t.priority ?? "medium" },
    ],
  },
  {
    type: "row",
    fields: [
      { name: "project_id", label: "Project", type: "select", options: projectOptions(), value: t.project_id ?? "" },
      { name: "due_at", label: "Due", type: "datetime-local", value: toLocalInput(t.due_at) },
    ],
  },
  { name: "tags", label: "Tags", value: (t.tags ?? []).join(", "), help: "Comma separated." },
  {
    name: "recurrence_rule",
    label: "Recurrence (RRULE)",
    value: t.recurrence_rule ?? "",
    help: "Optional, e.g. FREQ=WEEKLY;BYDAY=MO",
  },
];

const taskBody = (v) => ({
  title: v.title,
  description: v.description || null,
  status: v.status,
  priority: v.priority,
  project_id: v.project_id || null,
  due_at: fromLocalInput(v.due_at),
  tags: v.tags ? v.tags.split(",").map((s) => s.trim()).filter(Boolean) : [],
  recurrence_rule: v.recurrence_rule || null,
});

ACTIONS["task:new"] = () =>
  openModal({
    title: "New task",
    fields: taskFields(),
    submitLabel: "Create",
    onSubmit: (v) => api("/api/tasks", { method: "POST", body: taskBody(v) }),
  });

ACTIONS["task:edit"] = async (id) => {
  const { items } = await api(`/api/tasks?status=${TASK_STATUSES.join(",")}&limit=200`);
  const task = items.find((t) => t.id === id);
  if (!task) return toast("task not found", "err");
  openModal({
    title: "Edit task",
    fields: taskFields(task),
    onSubmit: (v) => api(`/api/tasks/${id}`, { method: "PATCH", body: taskBody(v) }),
  });
};

ACTIONS["task:done"] = (id) =>
  act(() => api(`/api/tasks/${id}`, { method: "PATCH", body: { status: "done" } }), { success: "Task completed" });

ACTIONS["task:reopen"] = (id) =>
  act(() => api(`/api/tasks/${id}`, { method: "PATCH", body: { status: "todo" } }), { success: "Task reopened" });

ACTIONS["task:del"] = (id) => {
  if (!confirm("Delete this task permanently?")) return;
  return act(() => api(`/api/tasks/${id}`, { method: "DELETE" }), { success: "Task deleted" });
};

// Projects ────────────────────────────────────────────────────────────────────

VIEWS.projects = {
  title: "Projects",
  async render(params) {
    const query = new URLSearchParams({ limit: "200" });
    if (params.status) query.set("status", params.status);
    const [{ items: fetched }, facets] = await Promise.all([api(`/api/projects?${query}`), loadTags()]);
    const items = filterByTags(fetched, params, (x) => x.project.tags);

    const rows = items.map(
      ({ project: p, openTasks, doneTasks, notes }) => html`<tr>
        <td class="wrap">
          <div class="cell-title">${p.name}</div>
          ${raw(p.description ? html`<div class="cell-sub">${truncate(p.description, 130)}</div>` : "")}
          ${raw(p.tags?.length ? html`<div class="cell-sub">${raw(p.tags.map((tag) => badge(tag)).join(" "))}</div>` : "")}
        </td>
        <td>${raw(badge(p.status))}</td>
        <td>${raw(badge(p.priority, p.priority === "critical" ? "badge-bad" : ""))}</td>
        <td>${openTasks} open · ${doneTasks} done</td>
        <td>${notes}</td>
        <td title="${fmtDate(p.due_date, false)}">${p.due_date ? fmtRelative(p.due_date) : "—"}</td>
        <td class="actions">
          ${raw(btn("Tasks", "project:tasks", p.id))}
          ${raw(btn("Edit", "project:edit", p.id))}
          ${raw(p.status === "archived" ? "" : btn("Archive", "project:archive", p.id, { cls: "btn-ghost btn-sm btn-danger" }))}
        </td>
      </tr>`
    );

    return html`
      <div class="toolbar">
        ${raw(btn("New project", "project:new", "", { cls: "btn-primary btn-sm" }))}
        <select data-filter="status">
          ${raw([{ value: "", label: "Not archived" }, ...opts(PROJECT_STATUSES)]
            .map((o) => html`<option value="${o.value}" ${raw(o.value === (params.status ?? "") ? "selected" : "")}>${o.label}</option>`)
            .join(""))}
        </select>
        ${raw(groupSelect(params, ["none", "status", "priority", "tag"]))}
      </div>
      ${raw(tagChips("project", params, facets))}
      ${raw(groupedCards("Projects", ["Project", "Status", "Priority", "Tasks", "Notes", "Due", ""], items, rows, params, ({ project: p }, by) =>
        by === "status" ? p.status : by === "priority" ? p.priority : firstTag(p.tags)))}
    `;
  },
};

const projectFields = (p = {}) => [
  { name: "name", label: "Name", value: p.name, required: true },
  { name: "description", label: "Description", type: "textarea", rows: 3, value: p.description ?? "" },
  {
    type: "row",
    fields: [
      { name: "status", label: "Status", type: "select", options: opts(PROJECT_STATUSES), value: p.status ?? "active" },
      { name: "priority", label: "Priority", type: "select", options: opts(PRIORITIES), value: p.priority ?? "medium" },
    ],
  },
  {
    type: "row",
    fields: [
      { name: "category", label: "Category", value: p.category ?? "" },
      { name: "due_date", label: "Due date", type: "date", value: p.due_date ? p.due_date.slice(0, 10) : "" },
    ],
  },
  { name: "tags", label: "Tags", value: (p.tags ?? []).join(", "), help: "Comma separated." },
];

const projectBody = (v) => ({
  name: v.name,
  description: v.description || null,
  status: v.status,
  priority: v.priority,
  category: v.category || null,
  due_date: v.due_date ? new Date(`${v.due_date}T00:00:00`).toISOString() : null,
  tags: v.tags ? v.tags.split(",").map((s) => s.trim()).filter(Boolean) : [],
});

ACTIONS["project:new"] = () =>
  openModal({
    title: "New project",
    fields: projectFields(),
    submitLabel: "Create",
    onSubmit: async (v) => {
      await api("/api/projects", { method: "POST", body: projectBody(v) });
      await loadBootstrap();
    },
  });

ACTIONS["project:edit"] = async (id) => {
  const { items } = await api(`/api/projects?status=${PROJECT_STATUSES.join(",")}&limit=200`);
  const found = items.find((s) => s.project.id === id);
  if (!found) return toast("project not found", "err");
  openModal({
    title: "Edit project",
    fields: [
      ...projectFields(found.project),
      { name: "progress", label: "Progress %", type: "number", value: found.project.progress ?? 0 },
    ],
    onSubmit: async (v) => {
      await api(`/api/projects/${id}`, { method: "PATCH", body: { ...projectBody(v), progress: Number(v.progress) || 0 } });
      await loadBootstrap();
    },
  });
};

ACTIONS["project:archive"] = (id) => {
  if (!confirm("Archive this project? Its tasks and notes stay put.")) return;
  return act(async () => {
    await api(`/api/projects/${id}`, { method: "DELETE" });
    await loadBootstrap();
  }, { success: "Project archived" });
};

ACTIONS["project:tasks"] = (id) => {
  location.hash = `#/tasks?project_id=${id}`;
};

// Notes ───────────────────────────────────────────────────────────────────────

VIEWS.notes = {
  title: "Notes",
  async render(params) {
    const query = new URLSearchParams({ limit: "200" });
    if (params.q) query.set("q", params.q);
    if (params.project_id) query.set("project_id", params.project_id);
    const [{ items: fetched }, facets] = await Promise.all([api(`/api/notes?${query}`), loadTags()]);
    const items = filterByTags(fetched, params);

    const rows = items.map(
      (n) => html`<tr>
        <td class="wrap">
          <div class="cell-title">${n.title || "(untitled)"} ${raw(n.pinned ? badge("pinned", "badge-accent") : "")}</div>
          <div class="cell-sub">${truncate(n.content, 180)}</div>
        </td>
        <td>${projectName(n.project_id)}</td>
        <td>${raw((n.tags ?? []).map((t) => badge(t)).join(" "))}</td>
        <td title="${fmtDate(n.updated_at)}">${fmtRelative(n.updated_at)}</td>
        <td class="actions">
          ${raw(btn(n.pinned ? "Unpin" : "Pin", "note:pin", n.id))}
          ${raw(btn("Edit", "note:edit", n.id))}
          ${raw(btn("Delete", "note:del", n.id, { cls: "btn-ghost btn-sm btn-danger" }))}
        </td>
      </tr>`
    );

    return html`
      <div class="toolbar">
        ${raw(btn("New note", "note:new", "", { cls: "btn-primary btn-sm" }))}
        <input type="search" data-filter="q" placeholder="Search notes…" value="${params.q ?? ""}" />
        <select data-filter="project_id">
          ${raw([{ value: "", label: "All projects" }, ...state.projects.map((p) => ({ value: p.id, label: p.name }))]
            .map((o) => html`<option value="${o.value}" ${raw(o.value === (params.project_id ?? "") ? "selected" : "")}>${o.label}</option>`)
            .join(""))}
        </select>
        ${raw(groupSelect(params, ["none", "project", "tag", "date"]))}
      </div>
      ${raw(tagChips("note", params, facets))}
      ${raw(groupedCards("Notes", ["Note", "Project", "Tags", "Updated", ""], items, rows, params, (n, by) =>
        by === "project" ? (n.project_id ? projectName(n.project_id) : "Unfiled") : by === "tag" ? firstTag(n.tags) : dayOf(n.updated_at)))}
    `;
  },
};

const noteFields = (n = {}) => [
  { name: "title", label: "Title", value: n.title ?? "" },
  { name: "content", label: "Content", type: "textarea", rows: 10, value: n.content ?? "", required: true },
  {
    type: "row",
    fields: [
      { name: "project_id", label: "Project", type: "select", options: projectOptions(), value: n.project_id ?? "" },
      { name: "tags", label: "Tags", value: (n.tags ?? []).join(", ") },
    ],
  },
  { name: "pinned", label: "Pinned", type: "checkbox", value: Boolean(n.pinned) },
];

const noteBody = (v) => ({
  title: v.title || null,
  content: v.content,
  project_id: v.project_id || null,
  tags: v.tags ? v.tags.split(",").map((s) => s.trim()).filter(Boolean) : [],
  pinned: Boolean(v.pinned),
});

ACTIONS["note:new"] = () =>
  openModal({ title: "New note", fields: noteFields(), submitLabel: "Create", onSubmit: (v) => api("/api/notes", { method: "POST", body: noteBody(v) }) });

ACTIONS["note:edit"] = async (id) => {
  const { items } = await api("/api/notes?limit=200");
  const note = items.find((n) => n.id === id);
  if (!note) return toast("note not found", "err");
  openModal({ title: "Edit note", fields: noteFields(note), onSubmit: (v) => api(`/api/notes/${id}`, { method: "PATCH", body: noteBody(v) }) });
};

ACTIONS["note:pin"] = async (id) => {
  const { items } = await api("/api/notes?limit=200");
  const note = items.find((n) => n.id === id);
  if (!note) return;
  return act(() => api(`/api/notes/${id}`, { method: "PATCH", body: { pinned: !note.pinned } }));
};

ACTIONS["note:del"] = (id) => {
  if (!confirm("Delete this note?")) return;
  return act(() => api(`/api/notes/${id}`, { method: "DELETE" }), { success: "Note deleted" });
};

// Inbox ───────────────────────────────────────────────────────────────────────

VIEWS.inbox = {
  title: "Inbox",
  async render() {
    const { items } = await api("/api/inbox?limit=100");
    const rows = items.map(
      (i) => html`<tr>
        <td class="wrap">
          <div>${truncate(i.raw_content, 260) || "(no text)"}</div>
          <div class="cell-sub">${fmtDate(i.created_at)} · ${i.source}</div>
        </td>
        <td>${raw(i.suggested_kind ? badge(i.suggested_kind, "badge-accent") : "—")}</td>
        <td class="actions">
          ${raw(btn("→ Task", "inbox:task", i.id, { cls: "btn-sm" }))}
          ${raw(btn("→ Note", "inbox:note", i.id, { cls: "btn-sm" }))}
          ${raw(btn("Dismiss", "inbox:dismiss", i.id, { cls: "btn-ghost btn-sm btn-danger" }))}
        </td>
      </tr>`
    );
    return html`${raw(
      card("Pending captures", table(["Captured", "Suggested", ""], rows, "Inbox zero."), { flush: true })
    )}`;
  },
};

async function inboxItem(id) {
  const { items } = await api("/api/inbox?limit=100");
  return items.find((i) => i.id === id);
}

ACTIONS["inbox:task"] = async (id) => {
  const item = await inboxItem(id);
  if (!item) return;
  openModal({
    title: "Turn capture into a task",
    fields: taskFields({ title: truncate(item.raw_content, 200), description: item.raw_content }),
    submitLabel: "Create task",
    onSubmit: async (v) => {
      const { item: task } = await api("/api/tasks", { method: "POST", body: taskBody(v) });
      await api(`/api/inbox/${id}/resolve`, {
        method: "POST",
        body: { status: "organized", resolved_kind: "task", resolved_entity_id: task.id },
      });
    },
  });
};

ACTIONS["inbox:note"] = async (id) => {
  const item = await inboxItem(id);
  if (!item) return;
  openModal({
    title: "Turn capture into a note",
    fields: noteFields({ content: item.raw_content ?? "" }),
    submitLabel: "Create note",
    onSubmit: async (v) => {
      const { item: note } = await api("/api/notes", { method: "POST", body: noteBody(v) });
      await api(`/api/inbox/${id}/resolve`, {
        method: "POST",
        body: { status: "organized", resolved_kind: "note", resolved_entity_id: note.id },
      });
    },
  });
};

ACTIONS["inbox:dismiss"] = (id) =>
  act(() => api(`/api/inbox/${id}/resolve`, { method: "POST", body: { status: "dismissed" } }), { success: "Dismissed" });

// Reminders ───────────────────────────────────────────────────────────────────

VIEWS.reminders = {
  title: "Reminders",
  async render(params) {
    const query = new URLSearchParams();
    if (params.status) query.set("status", params.status);
    const { items } = await api(`/api/reminders?${query}`);

    const rows = items.map(
      (r) => html`<tr>
        <td class="wrap">
          <div class="cell-title">${truncate(r.content ?? r.raw_text, 150)}</div>
          ${raw(r.recurrence_rule ? html`<div class="cell-sub"><code>${r.recurrence_rule}</code></div>` : "")}
        </td>
        <td>${raw(badge(r.kind))}</td>
        <td>${raw(badge(r.status))}</td>
        <td title="${fmtDate(r.next_trigger_at)}">${fmtRelative(r.next_trigger_at)}</td>
        <td>${r.timezone}</td>
        <td class="actions">
          ${raw(r.status === "paused" ? btn("Resume", "reminder:resume", r.id) : btn("Pause", "reminder:pause", r.id))}
          ${raw(btn("Edit", "reminder:edit", r.id))}
          ${raw(btn("Cancel", "reminder:cancel", r.id, { cls: "btn-ghost btn-sm btn-danger" }))}
        </td>
      </tr>`
    );

    return html`
      <div class="toolbar">
        ${raw(btn("New reminder", "reminder:new", "", { cls: "btn-primary btn-sm" }))}
        <select data-filter="status">
          ${raw([
            { value: "", label: "Scheduled + active" },
            { value: "scheduled,active,paused,completed,cancelled,failed", label: "All" },
            ...opts(["scheduled", "active", "paused", "completed", "cancelled", "failed"]),
          ].map((o) => html`<option value="${o.value}" ${raw(o.value === (params.status ?? "") ? "selected" : "")}>${o.label}</option>`).join(""))}
        </select>
      </div>
      ${raw(card("Reminders", table(["Reminder", "Kind", "Status", "Fires", "Timezone", ""], rows), { flush: true }))}
    `;
  },
};

const reminderFields = (r = {}) => [
  { name: "content", label: "What to say", value: r.content ?? r.raw_text ?? "", required: true },
  {
    type: "row",
    fields: [
      { name: "next_trigger_at", label: "When", type: "datetime-local", value: toLocalInput(r.next_trigger_at) },
      { name: "timezone", label: "Timezone", value: r.timezone ?? state.user?.timezone ?? "UTC" },
    ],
  },
  {
    name: "recurrence_rule",
    label: "Repeat (RRULE)",
    value: r.recurrence_rule ?? "",
    help: "Leave empty for one-off. Recurring example: FREQ=DAILY;BYHOUR=8;BYMINUTE=0",
  },
];

const reminderBody = (v) => ({
  content: v.content,
  next_trigger_at: fromLocalInput(v.next_trigger_at),
  timezone: v.timezone,
  recurrence_rule: v.recurrence_rule || null,
});

ACTIONS["reminder:new"] = () =>
  openModal({
    title: "New reminder",
    fields: reminderFields(),
    submitLabel: "Schedule",
    onSubmit: (v) => api("/api/reminders", { method: "POST", body: reminderBody(v) }),
  });

ACTIONS["reminder:edit"] = async (id) => {
  const { items } = await api("/api/reminders?status=scheduled,active,paused,completed,cancelled,failed");
  const reminder = items.find((r) => r.id === id);
  if (!reminder) return toast("reminder not found", "err");
  openModal({
    title: "Edit reminder",
    fields: reminderFields(reminder),
    onSubmit: (v) => api(`/api/reminders/${id}`, { method: "PATCH", body: reminderBody(v) }),
  });
};

ACTIONS["reminder:pause"] = (id) =>
  act(() => api(`/api/reminders/${id}`, { method: "PATCH", body: { status: "paused" } }), { success: "Paused" });

ACTIONS["reminder:resume"] = (id) =>
  act(() => api(`/api/reminders/${id}`, { method: "PATCH", body: { status: "scheduled" } }), { success: "Resumed" });

ACTIONS["reminder:cancel"] = (id) => {
  if (!confirm("Cancel this reminder?")) return;
  return act(() => api(`/api/reminders/${id}`, { method: "DELETE" }), { success: "Cancelled" });
};

// Files ───────────────────────────────────────────────────────────────────────

VIEWS.files = {
  title: "Files",
  async render(params) {
    const query = new URLSearchParams({ limit: "200" });
    if (params.q) query.set("q", params.q);
    if (params.kind) query.set("kind", params.kind);
    if (params.vault) query.set("vault", params.vault);
    const [{ items: fetched }, facets, vaults] = await Promise.all([api(`/api/files?${query}`), loadTags(), loadVaults()]);
    const items = filterByTags(fetched, params);

    const rows = items.map(
      (f) => html`<tr>
        <td class="wrap">
          <div class="cell-title">${f.file_name}</div>
          ${raw(f.caption ? html`<div class="cell-sub">${truncate(f.caption, 120)}</div>` : "")}
          ${raw(f.tags?.length ? html`<div class="cell-sub">${raw(f.tags.map((tag) => badge(tag)).join(" "))}</div>` : "")}
        </td>
        <td>${raw(badge(f.media_kind ?? "file"))}</td>
        <td>${fmtBytes(f.file_size)}</td>
        <td>${raw(badge(f.extraction_status, f.extraction_status === "done" ? "badge-ok" : f.extraction_status === "failed" ? "badge-bad" : ""))}</td>
        <td>${projectName(f.project_id)}</td>
        <td>${f.vault_chat_id ? vaultName(f.vault_chat_id) : "—"}</td>
        <td title="${fmtDate(f.created_at)}">${fmtRelative(f.created_at)}</td>
        <td class="actions">
          ${raw(f.vault_link ? html`<a class="btn btn-ghost btn-sm" href="${f.vault_link}" target="_blank" rel="noopener noreferrer" title="Open the post in your Telegram channel">Open ↗</a>` : "")}
          ${raw(btn("Send to me", "file:send", f.id, { cls: "btn-sm", title: "Deliver this file to your Telegram chat" }))}
          ${raw(vaults.length > 1 ? btn("Move", "file:move", f.id) : "")}
          ${raw(btn("Edit", "file:edit", f.id))}
          ${raw(btn("Delete", "file:del", f.id, { cls: "btn-ghost btn-sm btn-danger" }))}
        </td>
      </tr>`
    );

    const vaultRows = vaults.map(
      (v) => html`<tr>
        <td class="wrap">
          <div class="cell-title">${v.title ?? v.chat_id} ${raw(v.is_default ? badge("default", "badge-accent") : "")} ${raw(v.enabled ? "" : badge("disabled"))}</div>
          <div class="cell-sub"><code>${v.chat_id}</code>${raw(v.description ? html` · ${truncate(v.description, 90)}` : "")}</div>
        </td>
        <td>${v.category ?? "—"}</td>
        <td>${raw((v.tags ?? []).map((t) => badge(t)).join(" "))}</td>
        <td>${v.file_count}</td>
        <td class="actions">
          ${raw(v.link ? html`<a class="btn btn-ghost btn-sm" href="${v.link}" target="_blank" rel="noopener noreferrer">Open ↗</a>` : "")}
          ${raw(btn("Files", "vault:files", v.chat_id))}
          ${raw(btn("Sync", "vault:sync", v.id, { title: "Re-read the channel description for category and tags" }))}
          ${raw(btn("Edit", "vault:edit", v.id))}
          ${raw(v.is_default ? "" : btn("Make default", "vault:default", v.id))}
          ${raw(v.is_default ? "" : btn("Remove", "vault:del", v.id, { cls: "btn-ghost btn-sm btn-danger" }))}
        </td>
      </tr>`
    );

    return html`
      <div class="toolbar">
        <input type="search" data-filter="q" placeholder="Search name, caption, extracted text…" value="${params.q ?? ""}" />
        <select data-filter="kind">
          ${raw([{ value: "", label: "All kinds" }, ...opts(["document", "photo", "video", "audio", "voice", "animation", "video_note", "sticker"])]
            .map((o) => html`<option value="${o.value}" ${raw(o.value === (params.kind ?? "") ? "selected" : "")}>${o.label}</option>`)
            .join(""))}
        </select>
        ${raw(vaults.length > 1 ? html`<select data-filter="vault">
          ${raw([{ value: "", label: "All channels" }, ...vaults.map((v) => ({ value: v.chat_id, label: v.title ?? v.chat_id }))]
            .map((o) => html`<option value="${o.value}" ${raw(o.value === (params.vault ?? "") ? "selected" : "")}>${o.label}</option>`)
            .join(""))}
        </select>` : "")}
        ${raw(groupSelect(params, ["none", "project", "kind", "channel", "tag", "date"]))}
        <span class="spacer"></span>
        <span class="muted small">Bytes live in your Telegram channels — "Open" jumps to the post, "Send to me" copies it to your chat.</span>
      </div>
      ${raw(tagChips("file", params, facets))}
      ${raw(groupedCards("Files", ["File", "Kind", "Size", "Text", "Project", "Channel", "Added", ""], items, rows, params, (f, by) =>
        by === "project" ? (f.project_id ? projectName(f.project_id) : "Unfiled")
        : by === "kind" ? (f.media_kind ?? "file")
        : by === "channel" ? (f.vault_chat_id ? vaultName(f.vault_chat_id) : "Not in a channel")
        : by === "tag" ? firstTag(f.tags) : dayOf(f.created_at)))}
      ${raw(card("Vault channels", table(["Channel", "Category", "Tags", "Files", ""], vaultRows, "No channels yet."), {
        flush: true,
        actions: btn("Connect channel", "vault:new", "", { cls: "btn-sm" }),
      }))}
      <p class="muted small">Put <code>Category: research</code> and <code>Tags: papers, pdf</code> (or #hashtags) in a channel's description, then <b>Sync</b> — the assistant uses them to decide where new files go. You can also connect a channel by forwarding any post from it to the bot.</p>
    `;
  },
};

ACTIONS["file:move"] = async (id) => {
  const vaults = await loadVaults();
  openModal({
    title: "Move file to another channel",
    fields: [{ name: "vault_id", label: "Channel", type: "select", options: vaults.filter((v) => v.enabled).map((v) => ({ value: v.id, label: `${v.title ?? v.chat_id}${v.category ? ` · ${v.category}` : ""}` })) }],
    submitLabel: "Move",
    onSubmit: (v) => api(`/api/files/${id}/move`, { method: "POST", body: { vault_id: v.vault_id } }),
  });
};

ACTIONS["vault:new"] = () =>
  openModal({
    title: "Connect a vault channel",
    fields: [
      { name: "chat_id", label: "Channel id", value: "", required: true, placeholder: "-1001234567890", help: "Private channel where the bot is an administrator. Forward a post from the channel to @userinfobot to get the id — or just forward a post to the bot and press Connect." },
      { name: "category", label: "Category", value: "", placeholder: "research" },
      { name: "tags", label: "Tags", value: "", help: "Comma separated. Left empty, both are read from the channel description." },
    ],
    submitLabel: "Connect",
    onSubmit: async (v) => {
      await api("/api/vault", { method: "POST", body: { chat_id: v.chat_id.trim(), category: v.category || null, tags: v.tags ? v.tags.split(",").map((s) => s.trim()).filter(Boolean) : [] } });
      await loadVaults(true);
    },
  });

ACTIONS["vault:edit"] = async (id) => {
  const v = (await loadVaults()).find((x) => x.id === id);
  if (!v) return;
  openModal({
    title: "Edit vault channel",
    fields: [
      { name: "title", label: "Title", value: v.title ?? "" },
      { name: "category", label: "Category", value: v.category ?? "" },
      { name: "tags", label: "Tags", value: (v.tags ?? []).join(", ") },
      { name: "enabled", label: "Enabled (new files may be routed here)", type: "checkbox", value: v.enabled },
    ],
    onSubmit: async (val) => {
      await api(`/api/vault/${id}`, { method: "PATCH", body: { title: val.title || null, category: val.category || null, tags: val.tags ? val.tags.split(",").map((s) => s.trim()).filter(Boolean) : [], enabled: Boolean(val.enabled) } });
      await loadVaults(true);
    },
  });
};

ACTIONS["vault:sync"] = (id) => act(async () => { await api(`/api/vault/${id}/sync`, { method: "POST" }); await loadVaults(true); }, { success: "Channel description re-read" });
ACTIONS["vault:default"] = (id) => act(async () => { await api(`/api/vault/${id}`, { method: "PATCH", body: { is_default: true } }); await loadVaults(true); }, { success: "Default channel updated" });
ACTIONS["vault:del"] = (id) => {
  if (!confirm("Disconnect this channel? Files already stored there stay reachable.")) return;
  return act(async () => { await api(`/api/vault/${id}`, { method: "DELETE" }); await loadVaults(true); }, { success: "Channel removed" });
};
ACTIONS["vault:files"] = (chatId) => { location.hash = `#/files?vault=${encodeURIComponent(chatId)}`; };

ACTIONS["file:send"] = (id) =>
  act(() => api(`/api/files/${id}/send`, { method: "POST" }), { success: "Sent to your Telegram chat", refresh: false });

ACTIONS["file:edit"] = async (id) => {
  const { item } = await api(`/api/files/${id}`);
  openModal({
    title: "Edit file",
    fields: [
      { name: "file_name", label: "File name", value: item.file_name, required: true },
      { name: "caption", label: "Caption", type: "textarea", rows: 2, value: item.caption ?? "" },
      { name: "summary", label: "Summary", type: "textarea", rows: 3, value: item.summary ?? "" },
      { name: "project_id", label: "Project", type: "select", options: projectOptions(), value: item.project_id ?? "" },
      { name: "tags", label: "Tags", value: (item.tags ?? []).join(", "), help: "Comma separated." },
    ],
    onSubmit: async (v) => {
      await api(`/api/files/${id}`, {
        method: "PATCH",
        body: { file_name: v.file_name, caption: v.caption || null, summary: v.summary || null, project_id: v.project_id || null, tags: v.tags ? v.tags.split(",").map((s) => s.trim()).filter(Boolean) : [] },
      });
      invalidateTags();
    },
  });
};

ACTIONS["file:del"] = (id) => {
  if (!confirm("Remove this file from the index? The copy in your Telegram vault channel stays.")) return;
  return act(() => api(`/api/files/${id}`, { method: "DELETE" }), { success: "File removed from index" });
};

// Memory ──────────────────────────────────────────────────────────────────────

VIEWS.memory = {
  title: "Memory",
  async render(params) {
    const query = new URLSearchParams({ limit: "200" });
    if (params.q) query.set("q", params.q);
    if (params.type) query.set("type", params.type);
    const [{ items: fetchedMemories }, { items: facts }, facets] = await Promise.all([
      api(`/api/memories?${query}`),
      api("/api/facts"),
      loadTags(),
    ]);
    const memories = filterByTags(fetchedMemories, params);

    const memoryRows = memories.map(
      (m) => html`<tr>
        <td class="wrap">${m.content}</td>
        <td>${raw(badge(m.memory_type, "badge-accent"))}</td>
        <td>${"★".repeat(m.importance ?? 0)}</td>
        <td>${raw((m.tags ?? []).map((t) => badge(t)).join(" "))}</td>
        <td title="${fmtDate(m.created_at)}">${fmtRelative(m.created_at)}</td>
        <td class="actions">
          ${raw(btn("Edit", "memory:edit", m.id))}
          ${raw(btn("Forget", "memory:del", m.id, { cls: "btn-ghost btn-sm btn-danger" }))}
        </td>
      </tr>`
    );

    const factRows = facts.map(
      (f) => html`<tr>
        <td><code>${f.key}</code></td>
        <td class="wrap">${f.value}</td>
        <td>${f.category}</td>
        <td class="actions">${raw(btn("Delete", "fact:del", f.key, { cls: "btn-ghost btn-sm btn-danger" }))}</td>
      </tr>`
    );

    return html`
      <div class="toolbar">
        ${raw(btn("New memory", "memory:new", "", { cls: "btn-primary btn-sm" }))}
        <input type="search" data-filter="q" placeholder="Search memories…" value="${params.q ?? ""}" />
        <select data-filter="type">
          ${raw([{ value: "", label: "All types" }, ...opts(MEMORY_TYPES)]
            .map((o) => html`<option value="${o.value}" ${raw(o.value === (params.type ?? "") ? "selected" : "")}>${o.label}</option>`)
            .join(""))}
        </select>
        ${raw(groupSelect(params, ["none", "type", "tag"]))}
      </div>
      ${raw(tagChips("memory", params, facets))}
      ${raw(groupedCards("Long-term memories", ["Memory", "Type", "Importance", "Tags", "Created", ""], memories, memoryRows, params, (m, by) =>
        by === "type" ? m.memory_type : firstTag(m.tags)))}
      ${raw(
        card(
          "Facts about you",
          table(["Key", "Value", "Category", ""], factRows, "No facts stored yet."),
          { flush: true, actions: btn("Add fact", "fact:new", "", { cls: "btn-sm" }) }
        )
      )}
      <p class="muted small">
        Facts are injected into every prompt, so keep them short and durable. Memories are retrieved on
        relevance — those written here are found by keyword until the agent next re-embeds them.
      </p>
    `;
  },
};

const memoryFields = (m = {}) => [
  { name: "content", label: "Memory", type: "textarea", rows: 4, value: m.content ?? "", required: true },
  {
    type: "row",
    fields: [
      { name: "memory_type", label: "Type", type: "select", options: opts(MEMORY_TYPES), value: m.memory_type ?? "fact" },
      { name: "importance", label: "Importance (1–5)", type: "number", value: m.importance ?? 3 },
    ],
  },
  {
    type: "row",
    fields: [
      { name: "project_id", label: "Project", type: "select", options: projectOptions(), value: m.project_id ?? "" },
      { name: "tags", label: "Tags", value: (m.tags ?? []).join(", ") },
    ],
  },
];

const memoryBody = (v) => ({
  content: v.content,
  memory_type: v.memory_type,
  importance: Number(v.importance) || 3,
  project_id: v.project_id || null,
  tags: v.tags ? v.tags.split(",").map((s) => s.trim()).filter(Boolean) : [],
});

ACTIONS["memory:new"] = () =>
  openModal({ title: "New memory", fields: memoryFields(), submitLabel: "Remember", onSubmit: (v) => api("/api/memories", { method: "POST", body: memoryBody(v) }) });

ACTIONS["memory:edit"] = async (id) => {
  const { items } = await api("/api/memories?limit=200");
  const memory = items.find((m) => m.id === id);
  if (!memory) return toast("memory not found", "err");
  openModal({ title: "Edit memory", fields: memoryFields(memory), onSubmit: (v) => api(`/api/memories/${id}`, { method: "PATCH", body: memoryBody(v) }) });
};

ACTIONS["memory:del"] = (id) => {
  if (!confirm("Forget this memory?")) return;
  return act(() => api(`/api/memories/${id}`, { method: "DELETE" }), { success: "Forgotten" });
};

ACTIONS["fact:new"] = () =>
  openModal({
    title: "Add fact",
    fields: [
      { name: "key", label: "Key", value: "", required: true, help: "The key is the dedup — writing the same key again replaces the value." },
      { name: "value", label: "Value", value: "", required: true },
      { name: "category", label: "Category", value: "general" },
    ],
    submitLabel: "Save fact",
    onSubmit: (v) => api("/api/facts", { method: "PUT", body: { key: v.key, value: v.value, category: v.category || "general" } }),
  });

ACTIONS["fact:del"] = (key) => {
  if (!confirm(`Delete the fact "${key}"?`)) return;
  return act(() => api(`/api/facts/${encodeURIComponent(key)}`, { method: "DELETE" }), { success: "Fact deleted" });
};

// Links ───────────────────────────────────────────────────────────────────────

VIEWS.links = {
  title: "Links",
  async render(params) {
    const query = new URLSearchParams({ limit: "100" });
    if (params.q) query.set("q", params.q);
    const [{ items: fetched }, facets] = await Promise.all([api(`/api/links?${query}`), loadTags()]);
    const items = filterByTags(fetched, params);

    const rows = items.map(
      (l) => html`<tr>
        <td class="wrap">
          <div class="cell-title"><a href="${l.url}" target="_blank" rel="noopener noreferrer">${l.title || l.url}</a></div>
          <div class="cell-sub">${truncate(l.summary ?? l.description, 180)}</div>
        </td>
        <td>${l.site_name ?? "—"}</td>
        <td>${raw((l.tags ?? []).map((t) => badge(t)).join(" "))}</td>
        <td title="${fmtDate(l.created_at)}">${fmtRelative(l.created_at)}</td>
        <td class="actions">
          ${raw(btn("Edit", "link:edit", l.id))}
          ${raw(btn("Delete", "link:del", l.id, { cls: "btn-ghost btn-sm btn-danger" }))}
        </td>
      </tr>`
    );

    return html`
      <div class="toolbar">
        <input type="search" data-filter="q" placeholder="Search links…" value="${params.q ?? ""}" />
        ${raw(groupSelect(params, ["none", "tag", "project", "date"]))}
        <span class="spacer"></span>
        <span class="muted small">Drop a bare link to the bot in Telegram and it lands here, fetched and summarised.</span>
      </div>
      ${raw(tagChips("link", params, facets))}
      ${raw(groupedCards("Saved links", ["Link", "Site", "Tags", "Saved", ""], items, rows, params, (l, by) =>
        by === "tag" ? firstTag(l.tags) : by === "project" ? (l.project_id ? projectName(l.project_id) : "Unfiled") : dayOf(l.created_at)))}
    `;
  },
};

ACTIONS["link:edit"] = async (id) => {
  const { items } = await api("/api/links?limit=100");
  const link = items.find((l) => l.id === id);
  if (!link) return toast("link not found", "err");
  openModal({
    title: "Edit link",
    fields: [
      { name: "title", label: "Title", value: link.title ?? "" },
      { name: "summary", label: "Summary", type: "textarea", rows: 4, value: link.summary ?? "" },
      { name: "project_id", label: "Project", type: "select", options: projectOptions(), value: link.project_id ?? "" },
      { name: "tags", label: "Tags", value: (link.tags ?? []).join(", ") },
    ],
    onSubmit: (v) =>
      api(`/api/links/${id}`, {
        method: "PATCH",
        body: {
          title: v.title || null,
          summary: v.summary || null,
          project_id: v.project_id || null,
          tags: v.tags ? v.tags.split(",").map((s) => s.trim()).filter(Boolean) : [],
        },
      }),
  });
};

ACTIONS["link:del"] = (id) => {
  if (!confirm("Delete this link?")) return;
  return act(() => api(`/api/links/${id}`, { method: "DELETE" }), { success: "Link deleted" });
};

// Wallet ──────────────────────────────────────────────────────────────────────

const WALLET_PERIODS = ["today", "yesterday", "week", "month", "year", "all"];
const PERIOD_LABELS = {
  today: "Today", yesterday: "Yesterday", week: "Last 7 days",
  month: "This month", year: "This year", all: "All time",
};

VIEWS.wallet = {
  title: "Wallet",
  async render(params) {
    const period = WALLET_PERIODS.includes(params.period) ? params.period : "month";
    const query = new URLSearchParams({ period, limit: "300" });
    if (params.direction) query.set("direction", params.direction);
    if (params.category) query.set("category", params.category);
    if (params.q) query.set("q", params.q);
    if (params.project_id) query.set("project_id", params.project_id);

    const [{ items: fetched }, summary, facets] = await Promise.all([
      api(`/api/wallet?${query}`),
      api(`/api/wallet/summary?period=${period}`),
      loadTags(),
    ]);
    const items = filterByTags(fetched, params);
    state.walletCurrency = summary.currency;

    const totals = summary.totals ?? [];
    const stats = totals.length
      ? totals
          .flatMap((t) => [
            stat(fmtMoney(t.moneyOut, t.currency), `Spent · ${PERIOD_LABELS[period]}`, "alert"),
            stat(fmtMoney(t.moneyIn, t.currency), `Received · ${PERIOD_LABELS[period]}`),
            stat(fmtMoney(t.net, t.currency), `Left · ${t.currency}`, t.net < 0 ? "bad" : ""),
            stat(fmtNum(t.entries), `Entries · ${t.currency}`),
          ])
          .join("")
      : stat("0", `Entries · ${PERIOD_LABELS[period]}`);

    const rows = items.map(
      (e) => html`<tr>
        <td class="wrap">
          <div class="cell-title">${e.description}</div>
          <div class="cell-sub">
            ${e.quantity ? `${e.quantity}${e.unit ? " " + e.unit : ""} · ` : ""}${e.method ?? ""}
            ${raw((e.tags ?? []).map((t) => badge(t)).join(" "))}
          </div>
        </td>
        <td>${raw(badge(e.direction === "out" ? "expense" : "income", e.direction === "out" ? "badge-warn" : "badge-ok"))}</td>
        <td class="num">${fmtMoney(e.amount, e.currency)}</td>
        <td>${e.category ?? "—"}</td>
        <td>${projectName(e.project_id)}</td>
        <td title="${fmtDate(e.occurred_at)}">${fmtRelative(e.occurred_at)}</td>
        <td class="actions">
          ${raw(btn("Edit", "wallet:edit", e.id))}
          ${raw(btn("Delete", "wallet:del", e.id, { cls: "btn-ghost btn-sm btn-danger" }))}
        </td>
      </tr>`
    );

    const categoryRows = (summary.categories ?? []).map(
      (c) => html`<tr>
        <td>${c.category ?? "uncategorized"}</td>
        <td class="num">${fmtMoney(c.total, c.currency)}</td>
        <td>${fmtNum(c.entries)}</td>
      </tr>`
    );

    return html`
      <div class="stats">${raw(stats)}</div>

      <div class="toolbar">
        ${raw(btn("New expense", "wallet:new-out", "", { cls: "btn-primary btn-sm" }))}
        ${raw(btn("New income", "wallet:new-in", "", { cls: "btn-sm" }))}
        <select data-filter="period">
          ${raw(WALLET_PERIODS.map((v) => html`<option value="${v}" ${raw(v === period ? "selected" : "")}>${PERIOD_LABELS[v]}</option>`).join(""))}
        </select>
        <select data-filter="direction">
          ${raw([{ value: "", label: "Money in and out" }, { value: "out", label: "Expenses" }, { value: "in", label: "Income" }]
            .map((o) => html`<option value="${o.value}" ${raw(o.value === (params.direction ?? "") ? "selected" : "")}>${o.label}</option>`)
            .join(""))}
        </select>
        <input type="search" data-filter="q" placeholder="Search entries…" value="${params.q ?? ""}" />
        ${raw(groupSelect(params, ["none", "category", "direction", "date", "tag", "project"]))}
        ${raw(btn(`Currency: ${summary.currency}`, "wallet:currency", "", { cls: "btn-sm" }))}
      </div>
      ${raw(tagChips(null, params, facets))}
      ${raw(groupedCards(
        "History",
        ["Entry", "Kind", "Amount", "Category", "Project", "When", ""],
        items,
        rows,
        params,
        (e, by) =>
          by === "category" ? (e.category ?? "Uncategorized")
            : by === "direction" ? (e.direction === "out" ? "Expenses" : "Income")
            : by === "project" ? (e.project_id ? projectName(e.project_id) : "Unfiled")
            : by === "tag" ? firstTag(e.tags)
            : dayOf(e.occurred_at),
        "No entries in this period.",
      ))}
      ${raw(card("Spending by category", table(["Category", "Total", "Entries"], categoryRows, "Nothing spent in this period."), { flush: true }))}
    `;
  },
};

const walletFields = (e = {}) => [
  { name: "description", label: "What for", value: e.description ?? "", required: true, placeholder: "2 kg sugar" },
  {
    type: "row",
    fields: [
      { name: "amount", label: "Amount", type: "number", value: e.amount ?? "", required: true },
      // Blank means "use my wallet currency" — the server fills it in, so the
      // quick-add from Overview (which has not loaded it yet) stays correct.
      { name: "currency", label: "Currency", value: e.currency ?? state.walletCurrency ?? "", placeholder: "EGP" },
      { name: "category", label: "Category", value: e.category ?? "", placeholder: "groceries" },
    ],
  },
  {
    type: "row",
    fields: [
      { name: "quantity", label: "Quantity", type: "number", value: e.quantity ?? "" },
      { name: "unit", label: "Unit", value: e.unit ?? "", placeholder: "kg" },
      { name: "method", label: "Paid with", value: e.method ?? "", placeholder: "cash" },
    ],
  },
  {
    type: "row",
    fields: [
      { name: "occurred_at", label: "When", type: "datetime-local", value: toLocalInput(e.occurred_at ?? new Date().toISOString()) },
      { name: "project_id", label: "Project", type: "select", options: projectOptions(), value: e.project_id ?? "" },
      { name: "tags", label: "Tags", value: (e.tags ?? []).join(", ") },
    ],
  },
  { name: "note", label: "Note", type: "textarea", rows: 2, value: e.note ?? "" },
];

const walletBody = (v, direction) => ({
  direction,
  description: v.description,
  amount: Number(v.amount),
  currency: v.currency || undefined,
  category: v.category || null,
  quantity: v.quantity ? Number(v.quantity) : null,
  unit: v.unit || null,
  method: v.method || null,
  occurred_at: fromLocalInput(v.occurred_at),
  project_id: v.project_id || null,
  tags: v.tags ? v.tags.split(",").map((s) => s.trim()).filter(Boolean) : [],
  note: v.note || null,
});

const walletNew = (direction) => () =>
  openModal({
    title: direction === "out" ? "New expense" : "New income",
    fields: walletFields(),
    submitLabel: "Record",
    onSubmit: (v) => api("/api/wallet", { method: "POST", body: walletBody(v, direction) }),
  });

ACTIONS["wallet:new-out"] = walletNew("out");
ACTIONS["wallet:new-in"] = walletNew("in");

ACTIONS["wallet:edit"] = async (id) => {
  const { items } = await api("/api/wallet?period=all&limit=500");
  const entry = items.find((e) => e.id === id);
  if (!entry) return toast("entry not found", "err");
  openModal({
    title: "Edit entry",
    fields: walletFields(entry),
    onSubmit: (v) => api(`/api/wallet/${id}`, { method: "PATCH", body: walletBody(v, entry.direction) }),
  });
};

ACTIONS["wallet:del"] = (id) => {
  if (!confirm("Delete this entry? It disappears from the history and every total.")) return;
  return act(() => api(`/api/wallet/${id}`, { method: "DELETE" }), { success: "Entry deleted" });
};

ACTIONS["wallet:currency"] = () =>
  openModal({
    title: "Wallet currency",
    fields: [
      {
        name: "currency",
        label: "Default currency",
        value: state.walletCurrency ?? "EGP",
        required: true,
        help: "Used for new entries when none is given. Existing entries keep theirs.",
      },
    ],
    onSubmit: (v) => api("/api/wallet/currency", { method: "PUT", body: { currency: v.currency } }),
  });

// Chat & contexts ─────────────────────────────────────────────────────────────


VIEWS.chat = {
  title: "Chat",
  async render(params) {
    const { items: conversations } = await api("/api/conversations?limit=50");
    const activeId = params.id ?? conversations.find((c) => c.is_active)?.id ?? conversations[0]?.id ?? null;
    state.conversationId = activeId;

    const messages = activeId ? (await api(`/api/conversations/${activeId}/messages?limit=100`)).items : [];
    const bubbles = messages.map(
      (m) => html`<div class="msg ${m.role}">
        ${truncate(m.content ?? "", 4000)}
        <div class="msg-meta">${m.role} · ${fmtDate(m.created_at)}</div>
      </div>`
    );

    const conversationRows = conversations.map(
      (c) => html`<tr>
        <td class="wrap">
          <div class="cell-title">${c.title || "(untitled)"} ${raw(c.is_active ? badge("active", "badge-ok") : "")}</div>
          <div class="cell-sub">${projectName(c.project_id)} · updated ${fmtRelative(c.updated_at)}</div>
        </td>
        <td class="actions">
          ${raw(btn("Open", "chat:open", c.id))}
          ${raw(c.is_active ? "" : btn("Make active", "chat:activate", c.id))}
          ${raw(btn("Archive", "chat:archive", c.id, { cls: "btn-ghost btn-sm btn-danger" }))}
        </td>
      </tr>`
    );

    return html`
      ${raw(
        card(
          "Conversation",
          html`<div class="msg-list" id="msg-list">${raw(bubbles.join("") || '<div class="empty">No messages in this context yet.</div>')}</div>
            <div class="composer">
              <textarea id="composer-text" placeholder="Send a message or a /command to the assistant…" rows="2"></textarea>
              <button class="btn btn-primary" data-act="chat:send" data-id="">Send</button>
            </div>`,
          { flush: true, actions: btn("New context", "chat:new", "", { cls: "btn-sm" }) }
        )
      )}
      <p class="muted small">
        Messages are handed to the same agent the bot uses, so the reply arrives in your Telegram chat —
        this panel is the transcript, not a second inbox. Reload to see the answer once it lands.
      </p>
      ${raw(card("Contexts", table(["Context", ""], conversationRows), { flush: true }))}
    `;
  },
};

ACTIONS["chat:send"] = async () => {
  const box = $("#composer-text");
  const text = box?.value.trim();
  if (!text) return;
  box.disabled = true;
  const result = await act(() => api("/api/chat", { method: "POST", body: { text } }), {
    success: "Sent — the reply arrives in Telegram",
    refresh: false,
  });
  box.disabled = false;
  if (result) box.value = "";
};

ACTIONS["chat:open"] = (id) => {
  location.hash = `#/chat?id=${id}`;
};

ACTIONS["chat:activate"] = (id) =>
  act(() => api(`/api/conversations/${id}/activate`, { method: "POST" }), { success: "Context activated" });

ACTIONS["chat:archive"] = (id) => {
  if (!confirm("Archive this context?")) return;
  return act(() => api(`/api/conversations/${id}/archive`, { method: "POST" }), { success: "Archived" });
};

ACTIONS["chat:new"] = () =>
  openModal({
    title: "New context",
    fields: [
      { name: "title", label: "Title", value: "" },
      { name: "project_id", label: "Project", type: "select", options: projectOptions(), value: "" },
    ],
    submitLabel: "Start",
    onSubmit: (v) => api("/api/conversations", { method: "POST", body: { title: v.title || null, project_id: v.project_id || null } }),
  });

// Skills & MCP ────────────────────────────────────────────────────────────────

// A freshly issued MCP token, held only until the next navigation: the server
// returns it exactly once and never stores it.
let issuedMcpToken = null;

VIEWS.skills = {
  title: "Skills & MCP",
  async render() {
    const [{ items: skills }, { items: servers }, access] = await Promise.all([
      api("/api/skills"),
      api("/api/mcp"),
      api("/api/mcp-access"),
    ]);

    const skillRows = skills.map(
      (s) => html`<tr>
        <td class="wrap">
          <div class="cell-title">${s.name} ${raw(s.user_id ? "" : badge("global", "badge-accent"))}</div>
          <div class="cell-sub">${truncate(s.description ?? s.instructions, 160)}</div>
        </td>
        <td>${raw(badge(s.enabled ? "enabled" : "disabled", s.enabled ? "badge-ok" : ""))}</td>
        <td>${raw(badge(s.permission_level))}</td>
        <td>${(s.tools ?? []).length}</td>
        <td class="actions">
          ${raw(btn(s.enabled ? "Disable" : "Enable", "skill:toggle", s.id))}
          ${raw(btn("Edit", "skill:edit", s.id))}
          ${raw(s.user_id ? btn("Delete", "skill:del", s.id, { cls: "btn-ghost btn-sm btn-danger" }) : "")}
        </td>
      </tr>`
    );

    const serverRows = servers.map(
      (s) => html`<tr>
        <td class="cell-title">${s.name}</td>
        <td class="wrap"><code>${s.url}</code></td>
        <td>${raw(badge(s.enabled ? "enabled" : "disabled", s.enabled ? "badge-ok" : ""))}</td>
        <td>${raw(s.last_error ? badge(truncate(s.last_error, 60), "badge-bad") : s.last_connected_at ? fmtRelative(s.last_connected_at) : "never")}</td>
        <td class="actions">
          ${raw(btn(s.enabled ? "Disable" : "Enable", "mcp:toggle", s.id))}
          ${raw(btn("Delete", "mcp:del", s.name, { cls: "btn-ghost btn-sm btn-danger" }))}
        </td>
      </tr>`
    );

    const accessBody = issuedMcpToken
      ? html`<p class="muted small">
            Copy this now — it is shown once and is not stored. It replaces any token issued before it.
          </p>
          <pre class="kv">claude mcp add --transport http personxai ${issuedMcpToken.endpoint} --header "Authorization: Bearer ${issuedMcpToken.token}"</pre>
          <p class="muted small" style="margin-top:10px">Token</p>
          <pre class="kv">${issuedMcpToken.token}</pre>`
      : html`<p class="muted small" style="margin:0">
          ${access.active
            ? `Active — scope ${access.scope}, expires ${new Date(access.expiresAt).toLocaleDateString()}. The token itself is not stored; issue a new one to replace it.`
            : "No token issued. Issue one to drive this assistant from Claude Code, Codex or any MCP client."}
        </p>
        <p class="muted small" style="margin-top:8px">Endpoint <code>${access.endpoint}</code></p>`;

    return html`
      ${raw(
        card("MCP access — Claude Code / Codex", accessBody, {
          actions:
            (issuedMcpToken ? btn("Hide token", "mcpaccess:hide", "", { cls: "btn-ghost btn-sm" }) : btn("Issue token", "mcpaccess:new", "", { cls: "btn-sm" })) +
            (access.active ? btn("Revoke", "mcpaccess:revoke", "", { cls: "btn-ghost btn-sm btn-danger" }) : ""),
        })
      )}
      ${raw(
        card("Skills", table(["Skill", "State", "Permission", "Tools", ""], skillRows, "No skills yet."), {
          flush: true,
          actions: btn("New skill", "skill:new", "", { cls: "btn-sm" }),
        })
      )}
      ${raw(
        card("MCP servers", table(["Name", "URL", "State", "Last connection", ""], serverRows, "No MCP servers connected."), {
          flush: true,
          actions: btn("Add server", "mcp:new", "", { cls: "btn-sm" }),
        })
      )}
      <p class="muted small">
        MCP tools arrive permission-gated: they obey the same confirmation policy as built-in tools, at your
        current autonomy level. The card at the top is the other direction — a token that lets an MCP client
        drive this assistant.
      </p>
    `;
  },
};

const skillFields = (s = {}) => [
  { name: "name", label: "Name", value: s.name ?? "", required: true },
  { name: "description", label: "Description", value: s.description ?? "" },
  {
    name: "instructions",
    label: "Instructions",
    type: "textarea",
    rows: 10,
    value: s.instructions ?? "",
    required: true,
    help: "What the assistant should do when this skill fires.",
  },
  { name: "tools", label: "Tools", value: (s.tools ?? []).join(", "), help: "Comma-separated tool names this skill may use." },
  {
    type: "row",
    fields: [
      {
        name: "permission_level",
        label: "Permission",
        type: "select",
        options: opts(["read", "write", "destructive", "external"]),
        value: s.permission_level ?? "write",
      },
      { name: "enabled", label: "Enabled", type: "checkbox", value: s.enabled ?? true },
    ],
  },
];

const skillBody = (v) => ({
  name: v.name,
  description: v.description || null,
  instructions: v.instructions,
  tools: v.tools ? v.tools.split(",").map((s) => s.trim()).filter(Boolean) : [],
  permission_level: v.permission_level,
  enabled: Boolean(v.enabled),
});

ACTIONS["skill:new"] = () =>
  openModal({ title: "New skill", fields: skillFields(), submitLabel: "Create", onSubmit: (v) => api("/api/skills", { method: "POST", body: skillBody(v) }) });

ACTIONS["skill:edit"] = async (id) => {
  const { items } = await api("/api/skills");
  const skill = items.find((s) => s.id === id);
  if (!skill) return toast("skill not found", "err");
  openModal({ title: "Edit skill", fields: skillFields(skill), onSubmit: (v) => api(`/api/skills/${id}`, { method: "PATCH", body: skillBody(v) }) });
};

ACTIONS["skill:toggle"] = async (id) => {
  const { items } = await api("/api/skills");
  const skill = items.find((s) => s.id === id);
  if (!skill) return;
  return act(() => api(`/api/skills/${id}`, { method: "PATCH", body: { enabled: !skill.enabled } }));
};

ACTIONS["skill:del"] = (id) => {
  if (!confirm("Delete this skill?")) return;
  return act(() => api(`/api/skills/${id}`, { method: "DELETE" }), { success: "Skill deleted" });
};

ACTIONS["mcpaccess:new"] = () =>
  openModal({
    title: "Issue an MCP token",
    fields: [
      {
        name: "scope",
        label: "Scope",
        type: "select",
        value: "full",
        options: [
          { value: "full", label: "full — every tool your role allows, plus ask_assistant" },
          { value: "read", label: "read — read-only tools" },
        ],
      },
      { name: "ttlDays", label: "Valid for (days)", type: "number", value: 90 },
      { name: "label", label: "Label", value: "", help: "Optional note for you, e.g. 'laptop'." },
    ],
    submitLabel: "Issue",
    onSubmit: async (v) => {
      // Held in memory for the re-render that follows; never persisted.
      issuedMcpToken = await api("/api/mcp-access", {
        method: "POST",
        body: { scope: v.scope, ttlDays: Number(v.ttlDays) || 90, label: v.label || null },
      });
    },
  });

ACTIONS["mcpaccess:hide"] = () => {
  issuedMcpToken = null;
  return render();
};

ACTIONS["mcpaccess:revoke"] = () => {
  if (!confirm("Revoke MCP access? Every token issued so far stops working immediately.")) return;
  issuedMcpToken = null;
  return act(() => api("/api/mcp-access", { method: "DELETE" }), { success: "MCP access revoked" });
};

ACTIONS["mcp:new"] = () =>
  openModal({
    title: "Add MCP server",
    fields: [
      { name: "name", label: "Name", value: "", required: true },
      { name: "url", label: "URL", value: "https://", required: true, help: "Must be https." },
      { name: "auth_header", label: "Authorization header", value: "", help: "Optional, e.g. 'Bearer sk-…'. Stored server-side and never shown again." },
      { name: "enabled", label: "Enabled", type: "checkbox", value: true },
    ],
    submitLabel: "Connect",
    onSubmit: (v) =>
      api("/api/mcp", {
        method: "POST",
        body: { name: v.name, url: v.url, auth_header: v.auth_header || null, enabled: Boolean(v.enabled) },
      }),
  });

ACTIONS["mcp:toggle"] = async (id) => {
  const { items } = await api("/api/mcp");
  const server = items.find((s) => s.id === id);
  if (!server) return;
  return act(() => api(`/api/mcp/${id}`, { method: "PATCH", body: { enabled: !server.enabled } }));
};

ACTIONS["mcp:del"] = (name) => {
  if (!confirm(`Disconnect the MCP server "${name}"?`)) return;
  return act(() => api(`/api/mcp/${encodeURIComponent(name)}`, { method: "DELETE" }), { success: "Server removed" });
};

// Personalization ─────────────────────────────────────────────────────────────

VIEWS.prompt = {
  title: "Personalization",
  async render() {
    const { active, versions } = await api("/api/prompt");
    const versionRows = versions.map(
      (v) => html`<tr>
        <td>v${v.version} ${raw(v.is_active ? badge("active", "badge-ok") : "")}</td>
        <td class="wrap">${truncate(v.description ?? v.prompt_content, 160)}</td>
        <td>${v.created_by_role}</td>
        <td title="${fmtDate(v.created_at)}">${fmtRelative(v.created_at)}</td>
        <td class="actions">${raw(v.is_active ? "" : btn("Restore", "prompt:restore", v.id))}</td>
      </tr>`
    );

    return html`
      ${raw(
        card(
          active ? `Active instructions · v${active.version}` : "No custom instructions",
          html`<div class="field">
              <label for="prompt-content">These lines are appended to the assistant's system prompt on every turn.</label>
              <textarea id="prompt-content" rows="14" placeholder="e.g. Always answer in Egyptian Arabic unless I write in English. Never create tasks without a due date.">${active?.prompt_content ?? ""}</textarea>
            </div>
            <div class="field"><label for="prompt-note">Change note (optional)</label><input id="prompt-note" type="text" /></div>
            <div class="toolbar">
              ${raw(btn("Save new version", "prompt:save", "", { cls: "btn-primary btn-sm" }))}
              ${raw(active ? btn("Clear", "prompt:clear", "", { cls: "btn-ghost btn-sm btn-danger" }) : "")}
            </div>`
        )
      )}
      ${raw(card("Version history", table(["Version", "Note", "Author", "Created", ""], versionRows, "No versions yet."), { flush: true }))}
    `;
  },
};

ACTIONS["prompt:save"] = () => {
  const content = $("#prompt-content").value.trim();
  if (!content) return toast("Instructions cannot be empty — use Clear instead.", "err");
  return act(
    () => api("/api/prompt", { method: "PUT", body: { content, description: $("#prompt-note").value || undefined } }),
    { success: "Saved as a new version" }
  );
};

ACTIONS["prompt:clear"] = () => {
  if (!confirm("Clear your custom instructions? Past versions stay in the history.")) return;
  return act(() => api("/api/prompt", { method: "DELETE" }), { success: "Cleared" });
};

ACTIONS["prompt:restore"] = async (id) => {
  const { versions } = await api("/api/prompt");
  const version = versions.find((v) => v.id === id);
  if (!version) return;
  return act(
    () => api("/api/prompt", { method: "PUT", body: { content: version.prompt_content, description: `restored v${version.version}` } }),
    { success: `Restored v${version.version}` }
  );
};

// Activity ────────────────────────────────────────────────────────────────────

VIEWS.activity = {
  title: "Activity",
  async render(params) {
    const days = params.days ?? "7";
    const [{ items: audit }, usage] = await Promise.all([api("/api/audit?limit=150"), api(`/api/usage?days=${days}`)]);

    const runRows = usage.recent.map(
      (r) => html`<tr>
        <td title="${fmtDate(r.created_at)}">${fmtRelative(r.created_at)}</td>
        <td>${raw(badge(r.trigger, "badge-accent"))}</td>
        <td>${raw(badge(r.status, r.status === "ok" ? "badge-ok" : "badge-bad"))}</td>
        <td class="wrap"><code>${r.model ?? "—"}</code></td>
        <td>${fmtNum(r.prompt_tokens)} / ${fmtNum(r.completion_tokens)}</td>
        <td>${r.tool_call_count}</td>
        <td>${r.latency_ms ? `${fmtNum(r.latency_ms)} ms` : "—"}</td>
      </tr>`
    );

    const auditRows = audit.map(
      (a) => html`<tr>
        <td title="${fmtDate(a.created_at)}">${fmtRelative(a.created_at)}</td>
        <td><code>${a.action}</code></td>
        <td>${raw(badge(a.actor))}</td>
        <td>${a.entity_kind ?? "—"}</td>
        <td>${raw(badge(a.status, a.status === "ok" ? "badge-ok" : "badge-bad"))}</td>
        <td class="wrap"><pre class="kv">${truncate(JSON.stringify(a.details ?? {}), 180)}</pre></td>
      </tr>`
    );

    return html`
      <div class="toolbar">
        <select data-filter="days">
          ${raw([1, 7, 30, 90].map((d) => html`<option value="${d}" ${raw(String(d) === String(days) ? "selected" : "")}>Last ${d} day${raw(d === 1 ? "" : "s")}</option>`).join(""))}
        </select>
      </div>
      <div class="stats">
        ${raw(stat(fmtNum(usage.total.runs), `Runs · ${days}d`))}
        ${raw(stat(fmtNum(usage.total.promptTokens), "Prompt tokens"))}
        ${raw(stat(fmtNum(usage.total.completionTokens), "Completion tokens"))}
        ${raw(stat(fmtNum(usage.total.toolCalls), "Tool calls"))}
        ${raw(stat(usage.total.costUsd ? `$${usage.total.costUsd.toFixed(4)}` : "$0", "Reported cost"))}
      </div>
      ${raw(card("Recent agent runs", table(["When", "Trigger", "Status", "Model", "Tokens in/out", "Tools", "Latency"], runRows), { flush: true }))}
      ${raw(card("Audit log", table(["When", "Action", "Actor", "Entity", "Status", "Details"], auditRows), { flush: true }))}
    `;
  },
};

// Settings ────────────────────────────────────────────────────────────────────

const AUTONOMY = [
  "0 — confirm everything",
  "1 — confirm destructive and external actions",
  "2 — confirm destructive actions",
  "3 — fully autonomous (irreversible actions still confirm)",
];

VIEWS.settings = {
  title: "Settings",
  async render() {
    const u = state.user;
    return html`
      ${raw(
        card(
          "Your account",
          html`<div class="field-row">
              <div class="field"><label for="s-name">Display name</label><input id="s-name" type="text" value="${u.display_name ?? ""}" /></div>
              <div class="field">
                <label for="s-tz">Timezone</label>
                <input id="s-tz" type="text" value="${u.timezone}" list="tz-list" />
                <datalist id="tz-list">${raw((Intl.supportedValuesOf?.("timeZone") ?? []).map((z) => html`<option value="${z}"></option>`).join(""))}</datalist>
              </div>
            </div>
            <div class="field-row">
              <div class="field">
                <label for="s-lang">Language</label>
                <select id="s-lang">
                  ${raw([
                    { value: "en", label: "English" },
                    { value: "ar", label: "العربية" },
                    { value: "ar-EG", label: "مصري" },
                  ]
                    // Stored tags vary in case ("ar-EG" / "ar-eg"); match loosely.
                    .map((o) => html`<option value="${o.value}" ${raw(o.value.toLowerCase() === (u.language ?? "").toLowerCase() ? "selected" : "")}>${o.label}</option>`)
                    .join(""))}
                </select>
              </div>
              <div class="field">
                <label for="s-autonomy">Autonomy</label>
                <select id="s-autonomy">
                  ${raw(AUTONOMY.map((label, i) => html`<option value="${i}" ${raw(i === u.autonomy_level ? "selected" : "")}>${label}</option>`).join(""))}
                </select>
              </div>
            </div>
            <div class="toolbar">${raw(btn("Save", "settings:save", "", { cls: "btn-primary btn-sm" }))}</div>`
        )
      )}
      ${raw(
        card(
          "Identity",
          html`<pre class="kv">role: ${u.role}
allowed: ${u.is_allowed}
telegram id: ${state.identity?.external_id ?? "—"}
username: ${state.identity?.username ?? "—"}
user id: ${u.id}
member since: ${fmtDate(u.created_at)}</pre>`
        )
      )}
      <p class="muted small">
        Autonomy governs both surfaces: raising it here also stops the bot asking for confirmation in Telegram.
      </p>
    `;
  },
};

ACTIONS["settings:save"] = () =>
  act(
    async () => {
      await api("/api/user", {
        method: "PATCH",
        body: {
          display_name: $("#s-name").value || null,
          timezone: $("#s-tz").value,
          language: $("#s-lang").value,
          autonomy_level: Number($("#s-autonomy").value),
        },
      });
      await loadBootstrap();
    },
    { success: "Settings saved" }
  );

// System ──────────────────────────────────────────────────────────────────────

VIEWS.system = {
  title: "System",
  async render() {
    const sys = await api("/api/system");
    if (!sys.ok) {
      return html`${raw(card("Configuration error", html`<pre class="kv">${sys.error}</pre>`))}`;
    }
    const roleRow = (name, r) =>
      r
        ? html`<tr>
            <td class="cell-title">${name}</td>
            <td>${raw(badge(r.kind === "workers-ai" ? "Workers AI" : "OpenAI-compatible", "badge-accent"))}</td>
            <td><code>${r.model}</code></td>
            <td class="wrap"><code>${r.baseURL ?? "—"}</code></td>
          </tr>`
        : "";

    const mcpRows = sys.mcpServers.map(
      (s) => html`<tr>
        <td class="cell-title">${s.name}</td>
        <td>${raw(badge(s.enabled ? "enabled" : "disabled", s.enabled ? "badge-ok" : ""))}</td>
        <td>${s.last_connected_at ? fmtRelative(s.last_connected_at) : "never"}</td>
        <td class="wrap">${s.last_error ?? "—"}</td>
      </tr>`
    );

    return html`
      <div class="toolbar">
        ${raw(btn("Run dispatcher now", "system:dispatch", "", { cls: "btn-sm" }))}
        ${raw(btn("Send daily brief", "system:brief", "", { cls: "btn-sm" }))}
        ${raw(btn("Send heartbeat", "system:heartbeat", "", { cls: "btn-sm" }))}
        <span class="spacer"></span>
        <span class="muted small">Preset: ${sys.preset ?? "none (Workers AI defaults)"}</span>
      </div>
      ${raw(
        card(
          "Models",
          table(
            ["Role", "Provider", "Model", "Endpoint"],
            [
              roleRow("Main", sys.main),
              roleRow("Classifier", sys.classifier),
              roleRow("Embeddings", sys.embeddings),
              roleRow("Speech-to-text", sys.stt),
              roleRow("Vision", sys.vision),
            ].filter(Boolean)
          ),
          { flush: true }
        )
      )}
      ${raw(
        card(
          "Runtime",
          html`<pre class="kv">embedding dims: ${sys.embeddings.dims}
default timezone: ${sys.defaults.timezone}
default language: ${sys.defaults.language}
R2 artifacts: ${sys.r2Enabled ? "enabled" : "disabled"}
web search key: ${sys.searchConfigured ? "configured" : "not set"}
custom instructions: ${sys.promptVersion ? `v${sys.promptVersion}` : "none"}
max tool iterations: ${sys.limits.maxIterations}
tool budget / turn: ${sys.limits.toolBudgetPerTurn}
history window: ${sys.limits.historyWindow} messages
rate limit: ${sys.limits.rateLimitPerMinute}/min</pre>`
        )
      )}
      ${raw(card("MCP connections", table(["Server", "State", "Last connection", "Last error"], mcpRows, "No MCP servers configured."), { flush: true }))}
      <p class="muted small">
        API keys are worker secrets — they are never sent to this page. Change them with
        <code>wrangler secret put</code> and redeploy.
      </p>
    `;
  },
};

ACTIONS["system:dispatch"] = () =>
  act(async () => {
    const r = await api("/api/system/dispatch", { method: "POST" });
    toast(`Dispatcher ran: ${r.delivered ?? 0} delivered, ${r.failed ?? 0} failed`, "ok");
  }, { refresh: false });

ACTIONS["system:brief"] = () =>
  act(async () => {
    const r = await api("/api/system/routine", { method: "POST", body: { template: "daily_brief" } });
    toast(r.sent ? "Daily brief sent to Telegram" : "Nothing worth reporting — brief stayed quiet", "ok");
  }, { refresh: false });

ACTIONS["system:heartbeat"] = () =>
  act(async () => {
    const r = await api("/api/system/routine", { method: "POST", body: { template: "heartbeat" } });
    toast(r.sent ? "Heartbeat sent to Telegram" : "Heartbeat stayed silent — nothing needs you", "ok");
  }, { refresh: false });

// Search ──────────────────────────────────────────────────────────────────────

const SEARCH_ROUTES = {
  task: "tasks", note: "notes", project: "projects", file: "files",
  memory: "memory", link: "links", reminder: "reminders", inbox_item: "inbox",
};

VIEWS.tags = {
  title: "Tags",
  async render() {
    const facets = await loadTags();
    const KINDS = [["task", "tasks"], ["project", "projects"], ["note", "notes"], ["file", "files"], ["link", "links"], ["memory", "memory"]];
    const rows = facets.map(
      (f) => html`<tr>
        <td class="cell-title">#${f.name}</td>
        <td><strong>${f.total}</strong></td>
        ${raw(KINDS.map(([k, route]) => html`<td>${raw(f.counts[k] ? html`<a href="#/${route}?tag=${encodeURIComponent(f.name)}">${f.counts[k]}</a>` : html`<span class="muted">·</span>`)}</td>`).join(""))}
      </tr>`
    );
    return html`
      <p class="muted">Every task, project, note, file, link and memory carries tags. The assistant tags things as it saves them and reuses this vocabulary; you can add or change tags from any edit form, or by telling the bot <code>tag this with research</code>. Click a count to open that list filtered by the tag.</p>
      ${raw(card("Tags in use", table(["Tag", "Total", "Tasks", "Projects", "Notes", "Files", "Links", "Memories"], rows, "No tags yet — they appear as you save things."), { flush: true }))}
    `;
  },
};

VIEWS.search = {
  title: "Search",
  async render(params) {
    if (!params.q) return html`<div class="empty">Type a query in the search box above.</div>`;
    const { items } = await api(`/api/search?q=${encodeURIComponent(params.q)}&limit=50`);
    const rows = items.map(
      (hit) => html`<tr>
        <td>${raw(badge(hit.kind, "badge-accent"))}</td>
        <td class="wrap">
          <div class="cell-title">${hit.title || "(untitled)"}</div>
          <div class="cell-sub">${truncate(hit.snippet, 220)}</div>
        </td>
        <td>${typeof hit.score === "number" ? hit.score.toFixed(3) : "—"}</td>
        <td class="actions">${raw(SEARCH_ROUTES[hit.kind] ? btn("Open list", "search:goto", hit.kind) : "")}</td>
      </tr>`
    );
    return html`${raw(card(`Results for "${params.q}"`, table(["Kind", "Match", "Score", ""], rows, "No matches."), { flush: true }))}`;
  },
};

ACTIONS["search:goto"] = (kind) => {
  location.hash = `#/${SEARCH_ROUTES[kind] ?? "overview"}`;
};

// ── Navigation ───────────────────────────────────────────────────────────────

const NAV = [
  { group: "Today" },
  { id: "overview", label: "Overview", icon: "◈" },
  { id: "tasks", label: "Tasks", icon: "✓" },
  { id: "inbox", label: "Inbox", icon: "⇥" },
  { id: "reminders", label: "Reminders", icon: "⏰" },
  { id: "wallet", label: "Wallet", icon: "◎" },
  { group: "Knowledge" },
  { id: "projects", label: "Projects", icon: "▤" },
  { id: "notes", label: "Notes", icon: "✎" },
  { id: "files", label: "Files", icon: "🗀" },
  { id: "links", label: "Links", icon: "⚯" },
  { id: "memory", label: "Memory", icon: "◉" },
  { id: "tags", label: "Tags", icon: "#" },
  { group: "Assistant" },
  { id: "chat", label: "Chat", icon: "💬" },
  { id: "prompt", label: "Personalization", icon: "✦" },
  { id: "skills", label: "Skills & MCP", icon: "⚒" },
  { group: "Operations" },
  { id: "activity", label: "Activity", icon: "≡" },
  { id: "settings", label: "Settings", icon: "⚙" },
  { id: "system", label: "System", icon: "⚡" },
];

function renderNav(active) {
  $("#nav").innerHTML = NAV.map((entry) =>
    entry.group
      ? html`<div class="nav-group">${entry.group}</div>`
      : html`<a href="#/${entry.id}" class="${raw(entry.id === active ? "active" : "")}">
          <span aria-hidden="true">${entry.icon}</span> ${entry.label}
        </a>`
  ).join("");
}

/** `#/tasks?status=todo` → { view: "tasks", params: { status: "todo" } } */
function parseHash() {
  const hash = location.hash.replace(/^#\/?/, "") || "overview";
  const [path, queryString] = hash.split("?");
  const view = VIEWS[path] ? path : "overview";
  return { view, params: Object.fromEntries(new URLSearchParams(queryString ?? "")) };
}

let renderToken = 0;

async function render() {
  const { view, params } = parseHash();
  const token = ++renderToken;
  const container = $("#view");
  renderNav(view);
  $("#view-title").textContent = VIEWS[view].title;
  container.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const out = await VIEWS[view].render(params);
    // A newer navigation started while this one was in flight — drop the result.
    if (token !== renderToken) return;
    container.innerHTML = out;
  } catch (err) {
    if (token !== renderToken || err.status === 401) return;
    container.innerHTML = html`<div class="card"><div class="card-body"><p class="form-error">${err.message}</p></div></div>`;
  }
}

// Filter controls rewrite the hash, which re-renders through the router.
function applyFilter(name, value) {
  const { view, params } = parseHash();
  const next = { ...params };
  if (value) next[name] = value;
  else delete next[name];
  const query = new URLSearchParams(next).toString();
  location.hash = `#/${view}${query ? `?${query}` : ""}`;
}

$("#view").addEventListener("click", (e) => {
  const target = e.target.closest("[data-act]");
  if (!target) return;
  e.preventDefault();
  const handler = ACTIONS[target.dataset.act];
  if (handler) handler(target.dataset.id, target);
});

$("#view").addEventListener("click", (e) => {
  const chip = e.target.closest("[data-chip]");
  if (!chip) return;
  const { view, params } = parseHash();
  const value = chip.dataset.chip;
  const current = new Set(activeTags(params));
  if (value === "") current.clear();
  else if (current.has(value)) current.delete(value);
  else current.add(value);
  const next = { ...params };
  if (current.size > 0) next.tag = [...current].join(",");
  else delete next.tag;
  const query = new URLSearchParams(next).toString();
  location.hash = `#/${view}${query ? `?${query}` : ""}`;
});

$("#view").addEventListener("change", (e) => {
  const el = e.target.closest("[data-filter]");
  if (!el) return;
  applyFilter(el.dataset.filter, el.type === "checkbox" ? (el.checked ? el.value : "") : el.value);
});

// Free-text filters wait for Enter rather than firing per keystroke.
$("#view").addEventListener("keydown", (e) => {
  const el = e.target.closest("input[data-filter]");
  if (el && e.key === "Enter") {
    e.preventDefault();
    applyFilter(el.dataset.filter, el.value);
  }
});

$("#global-search").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const q = e.target.value.trim();
  if (q) location.hash = `#/search?q=${encodeURIComponent(q)}`;
});

$("#refresh-btn").addEventListener("click", () => render());
$("#menu-btn").addEventListener("click", () => $("#app").classList.toggle("nav-open"));
$("#nav").addEventListener("click", () => $("#app").classList.remove("nav-open"));
window.addEventListener("hashchange", () => render());

// ── Boot ─────────────────────────────────────────────────────────────────────

function showLogin(message = "") {
  $("#app").hidden = true;
  $("#login").hidden = false;
  // Inside Telegram there is nothing to click: the account is either allowed or
  // it is not, and a DM'd link would only reopen this same page.
  if (miniApp) {
    $("#login-btn").hidden = true;
    $("#login-copy").textContent = miniAppError
      ? `${miniAppError}. Send /start to the bot, then reopen the dashboard.`
      : "Telegram could not verify this session. Close the dashboard and reopen it from the menu button.";
    return;
  }
  if (message) setLoginStatus(message, "err");
}

function setLoginStatus(message, kind = "") {
  const el = $("#login-status");
  el.textContent = message;
  el.className = `login-status ${kind}`;
}

$("#login-btn").addEventListener("click", async () => {
  const button = $("#login-btn");
  button.disabled = true;
  setLoginStatus("Sending…");
  try {
    await api("/api/auth/request", { method: "POST", body: {} });
    setLoginStatus("Link sent — check your Telegram DMs.", "ok");
  } catch (err) {
    setLoginStatus(err.message, "err");
  } finally {
    button.disabled = false;
  }
});

$("#logout-btn").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST", body: {} }).catch(() => {});
  location.hash = "";
  showLogin("Signed out.");
});

async function loadBootstrap() {
  const data = await api("/api/bootstrap");
  state.user = data.user;
  state.identity = data.identity;
  state.projects = data.projects;
  state.system = data.system;
  $("#who").textContent = `${data.user.display_name ?? data.identity.username ?? "you"} · ${data.user.role}`;
  return data;
}

async function boot() {
  // A failed sign-in redirects back with ?error=…; surface it, then clean the URL.
  const params = new URLSearchParams(location.search);
  const loginError = params.get("error");
  if (loginError) history.replaceState(null, "", location.pathname + location.hash);

  initMiniApp();
  // Authenticate before the first request rather than after its 401, so a Mini
  // App launch never flashes the signed-out card on its way in.
  if (miniApp) await signInWithTelegram();

  try {
    await loadBootstrap();
  } catch (err) {
    showLogin(loginError ?? (err.status === 401 ? "" : err.message));
    return;
  }
  $("#login").hidden = true;
  $("#app").hidden = false;
  await render();
}

boot();
