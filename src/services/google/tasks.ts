/**
 * Google Tasks and Google People (contacts).
 *
 * Tasks are deliberately kept separate from PersonXAI's own `tasks` table: this
 * is the user's Google list as it exists in their phone's Tasks app, not a
 * mirror. The assistant reads and writes it on request; nothing syncs behind
 * the user's back.
 *
 * Contacts are read-only, and exist so "invite Sara" can become an address.
 */
import { googleFetch } from "./api";

const TASKS_BASE = "https://tasks.googleapis.com/tasks/v1";
const PEOPLE_BASE = "https://people.googleapis.com/v1";

export interface GoogleTaskList {
  id: string;
  title: string;
}

export interface GoogleTask {
  id: string;
  title: string;
  notes?: string;
  /** RFC 3339 date; Google Tasks stores due dates at day granularity. */
  due?: string;
  status: "needsAction" | "completed";
  completedAt?: string;
}

interface RawTaskList {
  id?: string;
  title?: string;
}

interface RawTask {
  id?: string;
  title?: string;
  notes?: string;
  due?: string;
  status?: string;
  completed?: string;
}

const toTask = (raw: RawTask): GoogleTask => {
  const task: GoogleTask = {
    id: raw.id ?? "",
    title: raw.title ?? "(untitled)",
    status: raw.status === "completed" ? "completed" : "needsAction",
  };
  if (raw.notes) task.notes = raw.notes;
  if (raw.due) task.due = raw.due;
  if (raw.completed) task.completedAt = raw.completed;
  return task;
};

export async function listTaskLists(accessToken: string): Promise<GoogleTaskList[]> {
  const result = await googleFetch<{ items?: RawTaskList[] }>(
    accessToken,
    "tasks.tasklists.list",
    `${TASKS_BASE}/users/@me/lists`,
    { query: { maxResults: 50 } }
  );
  return (result.items ?? []).map((l) => ({ id: l.id ?? "", title: l.title ?? "(untitled)" }));
}

/** The list Google itself calls "My Tasks" — the default target for a bare add. */
export async function defaultTaskListId(accessToken: string): Promise<string> {
  const lists = await listTaskLists(accessToken);
  const first = lists[0];
  if (!first) throw new Error("this Google account has no task lists");
  return first.id;
}

export async function listGoogleTasks(
  accessToken: string,
  opts: { listId?: string; includeCompleted?: boolean; limit?: number } = {}
): Promise<GoogleTask[]> {
  const listId = opts.listId ?? (await defaultTaskListId(accessToken));
  const result = await googleFetch<{ items?: RawTask[] }>(
    accessToken,
    "tasks.tasks.list",
    `${TASKS_BASE}/lists/${encodeURIComponent(listId)}/tasks`,
    {
      query: {
        maxResults: Math.min(Math.max(opts.limit ?? 25, 1), 100),
        showCompleted: Boolean(opts.includeCompleted),
        showHidden: Boolean(opts.includeCompleted),
      },
    }
  );
  return (result.items ?? []).map(toTask);
}

export async function addGoogleTask(
  accessToken: string,
  input: { title: string; notes?: string; due?: string; listId?: string }
): Promise<GoogleTask> {
  const listId = input.listId ?? (await defaultTaskListId(accessToken));
  const body: Record<string, unknown> = { title: input.title };
  if (input.notes) body.notes = input.notes;
  // Google Tasks ignores the time part but still requires a full RFC 3339 value.
  if (input.due) body.due = new Date(input.due).toISOString();

  const raw = await googleFetch<RawTask>(
    accessToken,
    "tasks.tasks.insert",
    `${TASKS_BASE}/lists/${encodeURIComponent(listId)}/tasks`,
    { method: "POST", body }
  );
  return toTask(raw);
}

export async function completeGoogleTask(
  accessToken: string,
  taskId: string,
  listId?: string
): Promise<GoogleTask> {
  const list = listId ?? (await defaultTaskListId(accessToken));
  const raw = await googleFetch<RawTask>(
    accessToken,
    "tasks.tasks.patch",
    `${TASKS_BASE}/lists/${encodeURIComponent(list)}/tasks/${encodeURIComponent(taskId)}`,
    { method: "PATCH", body: { status: "completed" } }
  );
  return toTask(raw);
}

export interface Contact {
  name: string;
  emails: string[];
  phones: string[];
}

interface RawPerson {
  names?: { displayName?: string }[];
  emailAddresses?: { value?: string }[];
  phoneNumbers?: { value?: string }[];
}

const toContact = (person: RawPerson | undefined): Contact => ({
  name: person?.names?.[0]?.displayName ?? "(no name)",
  emails: (person?.emailAddresses ?? []).map((e) => e.value ?? "").filter(Boolean),
  phones: (person?.phoneNumbers ?? []).map((p) => p.value ?? "").filter(Boolean),
});

/**
 * Search the user's own contacts by name, email or phone.
 *
 * People's searchContacts endpoint reads a server-side cache that is only built
 * after a warmup request, so a cold first search legitimately returns nothing.
 * Sending the warmup (an empty query) first costs one cheap call and makes the
 * first real search work, which matters because the first search is usually the
 * only one a user ever tries.
 */
export async function searchContacts(
  accessToken: string,
  query: string,
  limit = 10
): Promise<Contact[]> {
  const readMask = "names,emailAddresses,phoneNumbers";
  await googleFetch(accessToken, "people.searchContacts.warmup", `${PEOPLE_BASE}/people:searchContacts`, {
    query: { query: "", readMask },
  }).catch(() => undefined);

  const result = await googleFetch<{ results?: { person?: RawPerson }[] }>(
    accessToken,
    "people.searchContacts",
    `${PEOPLE_BASE}/people:searchContacts`,
    { query: { query, readMask, pageSize: Math.min(Math.max(limit, 1), 30) } }
  );
  return (result.results ?? []).map((r) => toContact(r.person));
}
