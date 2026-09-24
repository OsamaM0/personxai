/**
 * English (base) message catalog. This file defines the complete key set:
 * `MessageKey = keyof typeof en`, and every other locale falls back to it.
 *
 * Strings are Telegram-Markdown-safe: `*` only appears in matched pairs and
 * `_`, backticks and `[` are avoided. `{param}` placeholders are interpolated
 * by t() in src/i18n/index.ts.
 */
export const en = {
  start_welcome:
    "Hi! I'm your personal AI assistant. Send me a message, a voice note, or a file and I'll take it from there. Try /help to see what I can do.",
  start_owner_bootstrap:
    "Welcome! You're now registered as the owner of this assistant, and everything here stays private to you. Send /help for the basics.",
  start_channel_linked:
    "Welcome back! This channel is now linked to your account — same projects, tasks, notes, files and memory as everywhere else. Send /help for the basics.",
  help_text: `*Commands*
/today – overdue + due today
/tasks – open tasks
/projects – your projects
/project name – one project's details
/notes text – search notes
/inbox – unorganized captures
/files [text] – stored files (add #tag, by:tag, kind:photo, in:channel)
/find text – search everything (or /find #tag)
/tags – your tags; /tag name – everything with a tag
/vault – vault channels for files
/memory [text] – what I remember
/remember text – keep a fact
/links [text] – saved links
/wallet – money in and out (add today|week|month|year|all, in|out, #tag, cat:food)
/brief on 08:00 | off | now – daily brief
/heartbeat on 4 | off – periodic nudges
/skills – saved skills
/mcp – connected MCP servers
/connect – token for Claude Code / Codex (read | off | status)
/reminders – upcoming reminders
/dashboard – sign-in link for the web dashboard
/status – usage and settings
/settings – view or change settings
/context /newchat /contexts – conversation contexts
/cancel – clear pending confirmations
/help – this help

You rarely need commands though — just tell me what you want in plain language (English or Arabic), e.g. "remind me tomorrow at 9 to call Ahmed" or "add a high-priority task to deploy the bot".`,

  not_allowed: "Sorry, this is a private assistant and your account isn't on its allow list.",
  rate_limited: "Too many requests in a short time. Please wait a moment and try again.",
  error_generic: "Something went wrong on my side. Please try again in a moment.",
  still_processing: "Still working on your previous request — hang tight.",

  status_header: "*Status*",
  status_line_runs: "Runs ({period}): {runs} — tokens: {promptTokens} in / {completionTokens} out",
  status_line_context: "Context: {title}",
  status_line_autonomy: "Autonomy: {level}",
  status_line_timezone: "Timezone: {timezone}",
  status_line_language: "Language: {language}",
  status_line_model: "Model: {model}",

  cancelled: "Cancelled. What's next?",
  nothing_to_cancel: "Nothing is running right now.",

  tz_prompt:
    "What's your local time right now (HH:MM)? Or send your IANA timezone, e.g. Africa/Cairo. I'll use it for reminders and daily briefs.",
  tz_saved: "Timezone saved: {timezone}",
  tz_invalid:
    "I couldn't make sense of that. Send your local time as HH:MM (e.g. 14:30) or an IANA zone like Europe/Berlin.",

  context_switched: "Switched to: {title}",
  context_not_found: "No conversation matching \"{query}\". Use /contexts to list them.",
  contexts_header: "*Your conversations*",
  contexts_empty: "No conversations yet. Send a message or use /newchat to start one.",
  newchat_created: "Started a new conversation: {title}",
  conversation_default_title: "New chat",

  settings_header: "*Settings*",
  settings_line: "{key}: {value}",
  setting_updated: "Updated {key}.",
  setting_unknown: "Unknown setting: {key}",
  settings_usage:
    "Usage: /settings to view everything, or /settings key value to change one (e.g. /settings language ar).",

  confirm_prompt: "Please confirm: {action}",
  btn_confirm: "Confirm",
  btn_cancel: "Cancel",
  btn_edit: "Edit",
  confirm_expired: "That confirmation expired. Ask me again if you still want it.",
  confirm_executed: "Done.",
  confirm_cancelled: "Okay, cancelled.",

  language_set: "Language set to {language}.",
  language_usage: "Usage: /language followed by en, ar, or ar-EG.",

  voice_unsupported_yet:
    "I couldn't transcribe that voice note. Please try again or type it instead.",
  media_saved_inbox: "Got it — saved to your inbox. Ask me about it any time.",

  reminder_delivery_prefix: "*Reminder*:",
  daily_brief_header: "*Daily brief*",
  heartbeat_header: "*Heartbeat*",

  unknown_command: "Unknown command: {command}. Try /help, or just say what you need.",

  tasks_header: "*Your tasks*",
  tasks_empty: "No open tasks. Tell me about one and I'll track it.",
  today_header: "*Today*",
  today_overdue_header: "Overdue:",
  today_due_header: "Due today:",
  today_all_clear: "Nothing due today and nothing overdue. Enjoy the clear runway!",
  projects_header: "*Your projects*",
  projects_empty: "No projects yet. Say something like \"start a project for X\" and I'll set it up.",
  project_not_found: "No project matching \"{query}\". Use /projects to list them.",
  notes_header: "*Notes*",
  notes_empty: "No notes found.",
  inbox_header: "*Inbox* — {count} pending",
  inbox_empty: "Inbox zero. Nothing waiting to be organized.",
  inbox_suggestion: "suggestion: {kind} — {title}",
  inbox_item_to_task: "Turned into a task: {title}",
  inbox_item_to_note: "Saved as a note: {title}",
  inbox_item_dismissed: "Dismissed.",
  btn_make_task: "✅ Task",
  btn_make_note: "📝 Note",
  btn_dismiss: "🗑 Dismiss",

  files_header: "*Your files*",
  files_empty: "No files stored yet. Send me a document, photo, or PDF and I'll keep it safe.",
  file_saved: "Saved: {name}",
  file_duplicate: "I already have that one: {name}",
  file_suggestion: "Saved: {name}\nLooks like it belongs to *{project}*. Save it there?",
  file_assigned: "{name} → {project}",
  file_kept: "Kept {name} unfiled.",
  file_ignored: "Removed from the index.",
  file_no_text: "I couldn't read text from that file.",
  btn_save_project: "📁 {project}",
  btn_keep_inbox: "📥 Keep",
  btn_ignore: "🗑 Ignore",
  find_header: "*Results for* {query}",
  find_usage: "Usage: /find followed by what you are looking for.",
  find_empty: "Nothing found for \"{query}\".",
  memory_header: "*Memory*",
  memory_facts_header: "About you:",
  memory_stored_header: "Stored memories:",
  memory_empty: "Nothing stored yet. Say \"remember that ...\" and I will keep it.",
  memory_saved: "Got it, I will remember: {content}",
  remember_usage: "Usage: /remember followed by what I should keep in mind.",
  links_header: "*Saved links*",
  links_empty: "No saved links yet. Send me a URL and I will summarize and file it.",
  link_saved: "Saved: {title}",
  brief_waiting_header: "Waiting on:",
  brief_reminders_header: "Reminders:",
  brief_stale_header: "Projects going quiet:",
  brief_inbox: "Inbox: {count} items waiting to be organized.",
  brief_focus_header: "Suggested focus:",
  brief_all_clear: "Nothing needs your attention today. Clear runway.",
  brief_enabled: "Daily brief on at {time}.",
  brief_disabled: "Daily brief off.",
  brief_usage: "Usage: /brief on 08:00, /brief off, or /brief now.",
  heartbeat_enabled: "Heartbeat on, every {hours}h.",
  heartbeat_disabled: "Heartbeat off.",
  heartbeat_usage: "Usage: /heartbeat on 4, or /heartbeat off.",
  skills_header: "*Skills*",
  skills_empty: "No skills saved yet. Describe a workflow and I will save it as one.",
  wallet_header: "*Wallet*",
  wallet_empty: "Nothing tracked yet. Tell me things like \"I bought 2 kg of sugar for 25 LE\" and I'll keep the ledger.",
  wallet_totals: "in {in} · out {out} · left {net}",
  wallet_no_totals: "No money moved in this period.",
  wallet_currency_set: "Wallet currency set to {currency}. New entries use it unless you say otherwise.",
  wallet_usage:
    "Usage: /wallet [today|yesterday|week|month|year|all] [in|out] [#tag] [cat:groceries] [text] · /wallet currency EGP",
  wallet_period_today: "today",
  wallet_period_yesterday: "yesterday",
  wallet_period_week: "last 7 days",
  wallet_period_month: "this month",
  wallet_period_year: "this year",
  wallet_period_all: "all time",
  wallet_direction_in: "income",
  wallet_direction_out: "expense",
  mcp_header: "*MCP servers*",
  mcp_empty: "No MCP servers connected. Ask me to add one with its URL.",

  // ── Lists, detail cards, tags, vault channels ─────────────────────────────
  list_page: "page {page}/{pages}",
  list_empty: "Nothing here.",
  list_grouped_by: "by {by}",
  btn_back: "◀ Back",
  btn_group: "⊞ {by}",
  group_none: "no groups",
  group_project: "project",
  group_tag: "tag",
  group_status: "status",
  group_priority: "priority",
  group_kind: "kind",
  group_type: "type",
  group_channel: "channel",
  group_category: "category",
  group_date: "date",
  group_unfiled: "Unfiled",
  group_untagged: "Untagged",
  group_no_date: "No date",
  group_no_channel: "Not in a channel",
  group_uncategorized: "Uncategorized",
  reminders_header: "*Reminders*",
  reminders_empty: "No reminders yet. Say \"remind me tomorrow at 9 to …\".",
  inbox_title: "Inbox",
  tags_header: "*Tags*",
  tags_empty: "No tags yet. I tag things as you save them — or say \"tag this with research\".",
  tags_hint: "Tap a tag to see everything carrying it. Filter any list with #tag, group with by:tag.",
  tag_results_header: "*Tagged* #{tag}",
  lbl_project: "Project",
  lbl_status: "Status",
  lbl_priority: "Priority",
  lbl_due: "Due",
  lbl_tags: "Tags",
  lbl_created: "Added",
  lbl_updated: "Updated",
  lbl_kind: "Kind",
  lbl_channel: "Channel",
  lbl_text: "Text",
  lbl_summary: "Summary",
  lbl_next: "Next",
  lbl_repeats: "Repeats",
  lbl_open_done: "Open / done",
  lbl_suggested: "Suggested",
  lbl_category: "Category",
  lbl_direction: "Kind",
  lbl_when: "When",
  lbl_quantity: "Quantity",
  lbl_method: "Paid with",
  lbl_note: "Note",
  btn_done: "✅ Done",
  btn_reopen: "↩ Reopen",
  btn_snooze: "⏭ +1 day",
  btn_delete: "🗑 Delete",
  btn_confirm_delete: "⚠️ Confirm delete",
  btn_pin: "📌 Pin",
  btn_unpin: "📌 Unpin",
  btn_send_file: "📤 Send here",
  btn_open_vault: "🔗 Open in channel",
  btn_open_channel: "🔗 Open channel",
  btn_move_to: "→ {channel}",
  btn_forget: "🗑 Forget",
  btn_pause: "⏸ Pause",
  btn_resume: "▶ Resume",
  btn_cancel_reminder: "✖ Cancel",
  btn_archive: "📦 Archive",
  btn_project_tasks: "☑️ Tasks",
  btn_project_notes: "📝 Notes",
  btn_project_files: "📁 Files",
  btn_open_link: "🔗 Open",
  btn_set_default: "⭐ Make default",
  btn_sync: "🔄 Sync",
  btn_remove: "🗑 Remove",
  detail_confirm_hint: "Press again to confirm.",
  detail_done: "✅ Marked done.",
  detail_reopened: "↩ Reopened.",
  detail_snoozed: "⏭ Moved to {when}.",
  detail_deleted: "🗑 Deleted.",
  detail_pinned: "📌 Pinned.",
  detail_unpinned: "Unpinned.",
  detail_sent: "📤 Sent to this chat.",
  detail_moved: "Moved to {channel}.",
  detail_forgotten: "Forgotten.",
  detail_paused: "⏸ Paused.",
  detail_resumed: "▶ Resumed.",
  detail_cancelled: "✖ Cancelled.",
  detail_archived: "📦 Archived.",
  detail_not_found: "That item no longer exists.",
  vault_header: "*Vault channels*",
  vault_empty: "No vault channels yet.",
  vault_is_default: "default",
  vault_description_hint:
    "Tip: put \"Category: research\" and \"Tags: papers, pdf\" (or #hashtags) in the channel description, then Sync — I use them to decide where files go.",
  vault_connect_prompt: "Connect *{title}* as a vault channel? I'll read its description for a category and tags.",
  btn_connect: "🔗 Connect",
  btn_not_now: "Not now",
  vault_connected: "Connected *{title}* — category: {category} · tags: {tags}.",
  vault_connect_failed: "Couldn't connect that channel: {reason}",
  vault_already: "*{title}* is already connected.",
  vault_default_set: "⭐ Default vault is now {title}.",
  vault_synced: "🔄 {title}: {category} · {tags}",
  vault_removed: "Removed {title}. Files already stored there stay reachable.",
  vault_usage: "Usage: /vault (list) · /vault add -1001234567890 [category] #tag1 #tag2 · /vault sync",
  file_saved_to: "Saved to *{channel}*: {name}",
  file_where: "Saved: {name}\nWhere does it belong?",
  btn_move: "📁 {channel}",
  list_stale: "That page is out of date — send the command again.",
} as const;
