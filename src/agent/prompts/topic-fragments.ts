/**
 * Per-topic prompt fragments, composed onto the system prompt only when that
 * topic's tools are registered for the turn (Stacks promptContext pattern).
 * IMPORTANT: a fragment must only mention tools that its topic registers —
 * otherwise the model hallucinates unavailable tools.
 */
import type { Topic } from "../../tools/topics";

const FRAGMENTS: Partial<Record<Topic, string>> = {
  tasks: `Tasks:
- create_task for new to-dos (always with 1-3 tags, reusing tags in use); list_tasks to answer "what should I do"; complete_task when the user says something is done.
- Due times go in the user's LOCAL time (YYYY-MM-DDTHH:mm) — call current_time first for anything relative.
- "What should I focus on?" = list_tasks, then reason over due dates, priority, and status; present at most 5, ordered.`,
  projects: `Projects:
- Resolve project references by name with get_project/list_projects before guessing; if a named project doesn't exist, ask before creating it.
- When the user starts substantial new work, offer (don't force) creating a project for it.`,
  notes: `Notes:
- create_note for "save this/write this down". Keep the user's original wording; title only when natural.
- list_notes previews are truncated — use get_note before quoting a note's content.`,
  inbox: `Inbox:
- "Organize my inbox" → organize_inbox (sends per-item suggestion buttons; don't repeat items in your reply).
- Use resolve_inbox_item only when the user explicitly says what a specific item should become.`,
  reminders: `Reminders:
- create_reminder 'when' must be the user's LOCAL time (YYYY-MM-DDTHH:mm). ALWAYS call current_time before relative phrases ("in 2 hours", "بكرة").
- Recurring: RRULE (e.g. FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0). Include BYHOUR/BYMINUTE, else it fires at the anchor's time.
- content is a directive for later delivery ("Call Ahmed"), never a full sentence like "I will remind you…".
- Delivery ticks once a minute — for sub-minute requests, warn about up-to-a-minute drift.`,
  memory: `Memory:
- remember stores durable facts/decisions/preferences; remember_about_user stores short keyed facts shown to you every turn. Save only what is worth recalling weeks later, never routine chat.
- recall_memories before answering questions about past decisions or preferences. forget_memory and forget_about_user run ONLY on an explicit request to forget.`,
  files: `Files:
- Files the user sends are stored automatically in a vault channel. find_files locates them (by name, caption, extracted text, tags, kind, channel, or date); send_file returns one to the chat.
- Several vault channels may exist (list_vault_channels), each with a category and tags. When a file clearly belongs to another channel, move_file_to_channel; when it is unclear which channel or which tags fit, ask one short question. set_tags adds tags to a stored file.
- To summarize or answer questions about a document, call get_file_text first — never guess a file's contents. If extraction is still pending, say so and offer to retry.
- Files over 20MB are stored but cannot be read (Telegram's download limit).`,
  search: `Search:
- search_all covers projects/tasks/notes/files/links/memories (keyword + semantic). search_documents searches inside document text. find_by_tag is the fast path when the user names a tag or #hashtag; list_tags shows the vocabulary.
- save_link fetches and summarizes a URL as a bookmark; read_url fetches a page without saving. Report findings grouped by kind and say plainly when nothing matched.`,
  wallet: `Wallet (money in / money out):
- record_expense for anything the user bought or paid, record_income for salary, payments and refunds. One entry per purchase, with the user's own wording as the description.
- Split what they said into fields: "2 kilos of sugar for 25 LE" -> description "2 kg sugar", amount 25, quantity 2, unit "kg", category "groceries". Always set a short lowercase category, reusing categories already in the ledger.
- The amount is a bare number and the currency is separate; if no currency is named, omit it and their wallet currency is used. Never invent an amount you were not told - ask.
- wallet_balance answers "how much did I spend / what is left / where does my money go"; list_wallet_entries is the history. Both default to this month - pass period for other windows.
- update_wallet_entry corrects a mistake, delete_wallet_entry removes an entry. Confirm the total back to the user after logging, briefly.`,
  settings: `Settings, skills, and integrations:
- Point the user to /settings for timezone, language, and autonomy — do not change those yourself.
- When the user describes a repeatable workflow, offer to save it with create_skill. When a saved skill matches a request, call run_skill first and follow its instructions.
- set_personalization stores durable instructions about how you should behave. Use it only when the user asks for a lasting change in your behavior, never for one-off requests.
- add_mcp_server connects an external tool server; its tools appear from the next message onward.`,
};

export function topicFragments(topics: Topic[]): string {
  const parts = topics
    .map((topic) => FRAGMENTS[topic])
    .filter((s): s is string => typeof s === "string");
  return parts.join("\n\n");
}
