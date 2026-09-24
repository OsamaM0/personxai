import type { en } from "./en";

/**
 * Modern Standard Arabic catalog. Complete — the `satisfies` clause fails to
 * compile if any English key is missing. Command names, locale codes, and
 * technical formats (HH:MM, IANA, tokens) stay in English on purpose.
 */
export const ar = {
  start_welcome:
    "أهلاً بك! أنا مساعدك الشخصي الذكي. أرسل لي رسالة أو تسجيلاً صوتياً أو ملفاً وسأتولى الباقي. جرّب /help لترى ما يمكنني فعله.",
  start_owner_bootstrap:
    "مرحباً! تم تسجيلك الآن مالكاً لهذا المساعد، وكل ما هنا يبقى خاصاً بك. أرسل /help للاطلاع على الأساسيات.",
  start_channel_linked:
    "مرحباً بعودتك! تم ربط هذه القناة بحسابك — نفس المشاريع والمهام والملاحظات والملفات والذاكرة كما في أي مكان آخر. أرسل /help للاطلاع على الأساسيات.",
  help_text: `*الأوامر*
/today – المتأخر والمستحق اليوم
/tasks – المهام المفتوحة
/projects – مشاريعك
/project اسم – تفاصيل مشروع
/notes نص – بحث في الملاحظات
/inbox – الوارد غير المرتب
/files [نص] – الملفات المحفوظة (أضف #وسم أو by:tag أو kind:photo أو in:قناة)
/find نص – بحث شامل (أو /find #وسم)
/tags – وسومك؛ /tag اسم – كل ما يحمل وسماً
/vault – قنوات حفظ الملفات
/memory [نص] – ما أتذكره
/remember نص – احفظ معلومة
/links [نص] – الروابط المحفوظة
/wallet – المصاريف والدخل (today|week|month|year|all و in|out و #وسم و cat:أكل)
/brief on 08:00 | off | now – الملخص اليومي
/heartbeat on 4 | off – تنبيهات دورية
/skills – المهارات المحفوظة
/mcp – خوادم MCP المتصلة
/connect – توكن لربط Claude Code / Codex (read | off | status)
/reminders – التذكيرات القادمة
/dashboard – رابط الدخول للوحة التحكم
/status – الاستخدام والإعدادات
/settings – عرض الإعدادات أو تغييرها
/context /newchat /contexts – سياقات المحادثة
/cancel – إلغاء التأكيدات المعلقة
/help – هذه المساعدة

نادراً ما ستحتاج الأوامر — فقط أخبرني بما تريد بلغة طبيعية، مثل "فكرني بكرة الساعة ٩ أكلم أحمد" أو "ضيف مهمة مهمة أوي إني أرفع البوت".`,

  not_allowed: "عذراً، هذا مساعد خاص وحسابك ليس ضمن القائمة المسموح بها.",
  rate_limited: "طلبات كثيرة خلال وقت قصير. يرجى الانتظار قليلاً ثم المحاولة مجدداً.",
  error_generic: "حدث خطأ من جهتي. يرجى المحاولة مرة أخرى بعد قليل.",
  still_processing: "ما زلت أعمل على طلبك السابق — لحظة من فضلك.",

  status_header: "*الحالة*",
  status_line_runs: "عدد التشغيلات ({period}): {runs} — tokens: {promptTokens} إدخال / {completionTokens} إخراج",
  status_line_context: "السياق: {title}",
  status_line_autonomy: "مستوى الاستقلالية: {level}",
  status_line_timezone: "المنطقة الزمنية: {timezone}",
  status_line_language: "اللغة: {language}",
  status_line_model: "النموذج: {model}",

  cancelled: "تم الإلغاء. ما التالي؟",
  nothing_to_cancel: "لا توجد مهمة قيد التنفيذ الآن.",

  tz_prompt:
    "كم الساعة لديك الآن بصيغة HH:MM؟ أو أرسل منطقتك الزمنية بصيغة IANA مثل Africa/Cairo. سأستخدمها للتذكيرات والملخص اليومي.",
  tz_saved: "تم حفظ المنطقة الزمنية: {timezone}",
  tz_invalid:
    "لم أتمكن من فهم ذلك. أرسل وقتك المحلي بصيغة HH:MM (مثل 14:30) أو منطقة IANA مثل Europe/Berlin.",

  context_switched: "تم التبديل إلى: {title}",
  context_not_found: "لم أجد محادثة تطابق \"{query}\". استخدم /contexts لعرض المحادثات.",
  contexts_header: "*محادثاتك*",
  contexts_empty: "لا توجد محادثات بعد. أرسل رسالة أو استخدم /newchat لبدء واحدة.",
  newchat_created: "بدأت محادثة جديدة: {title}",
  conversation_default_title: "محادثة جديدة",

  settings_header: "*الإعدادات*",
  settings_line: "{key}: {value}",
  setting_updated: "تم تحديث {key}.",
  setting_unknown: "إعداد غير معروف: {key}",
  settings_usage:
    "الاستخدام: /settings للعرض، أو /settings key value لتغيير إعداد (مثال: /settings language ar).",

  confirm_prompt: "يرجى التأكيد: {action}",
  btn_confirm: "تأكيد",
  btn_cancel: "إلغاء",
  btn_edit: "تعديل",
  confirm_expired: "انتهت صلاحية هذا التأكيد. اطلب مجدداً إذا كنت لا تزال تريده.",
  confirm_executed: "تم التنفيذ.",
  confirm_cancelled: "حسناً، تم الإلغاء.",

  language_set: "تم ضبط اللغة على {language}.",
  language_usage: "الاستخدام: /language متبوعاً بـ en أو ar أو ar-EG.",

  voice_unsupported_yet:
    "لم أتمكن من تفريغ هذه الرسالة الصوتية. حاول مرة أخرى أو اكتبها نصياً.",
  media_saved_inbox: "تم الحفظ في صندوق الوارد. اسألني عنه في أي وقت.",

  reminder_delivery_prefix: "*تذكير*:",
  daily_brief_header: "*الملخص اليومي*",
  heartbeat_header: "*تحديث دوري*",

  unknown_command: "أمر غير معروف: {command}. جرّب /help أو أخبرني بما تحتاجه مباشرة.",

  tasks_header: "*مهامك*",
  tasks_empty: "لا توجد مهام مفتوحة. أخبرني بمهمة وسأتابعها لك.",
  today_header: "*اليوم*",
  today_overdue_header: "متأخرة:",
  today_due_header: "مستحقة اليوم:",
  today_all_clear: "لا مهام مستحقة اليوم ولا متأخرات. يومك صافٍ!",
  projects_header: "*مشاريعك*",
  projects_empty: "لا توجد مشاريع بعد. قل مثلاً \"ابدأ مشروع لكذا\" وسأجهزه.",
  project_not_found: "لا يوجد مشروع يطابق \"{query}\". استخدم /projects لعرض القائمة.",
  notes_header: "*الملاحظات*",
  notes_empty: "لا توجد ملاحظات.",
  inbox_header: "*صندوق الوارد* — {count} بانتظار الترتيب",
  inbox_empty: "صندوق الوارد فارغ. لا شيء ينتظر الترتيب.",
  inbox_suggestion: "اقتراح: {kind} — {title}",
  inbox_item_to_task: "تحوّلت إلى مهمة: {title}",
  inbox_item_to_note: "حُفظت كملاحظة: {title}",
  inbox_item_dismissed: "تم التجاهل.",
  btn_make_task: "✅ مهمة",
  btn_make_note: "📝 ملاحظة",
  btn_dismiss: "🗑 تجاهل",

  files_header: "*ملفاتك*",
  files_empty: "لا توجد ملفات محفوظة بعد. أرسل لي مستنداً أو صورة أو PDF وسأحتفظ به.",
  file_saved: "تم الحفظ: {name}",
  file_duplicate: "هذا الملف محفوظ عندي بالفعل: {name}",
  file_suggestion: "تم الحفظ: {name}\nيبدو أنه يخص *{project}*. أحفظه هناك؟",
  file_assigned: "{name} ← {project}",
  file_kept: "تم الاحتفاظ بـ {name} بدون تصنيف.",
  file_ignored: "تمت الإزالة من الفهرس.",
  file_no_text: "لم أتمكن من قراءة نص من هذا الملف.",
  btn_save_project: "📁 {project}",
  btn_keep_inbox: "📥 احتفظ",
  btn_ignore: "🗑 تجاهل",
  find_header: "*نتائج البحث عن* {query}",
  find_usage: "الاستخدام: /find متبوعاً بما تبحث عنه.",
  find_empty: "لم أجد شيئاً بخصوص \"{query}\".",
  memory_header: "*الذاكرة*",
  memory_facts_header: "معلومات عنك:",
  memory_stored_header: "ذكريات محفوظة:",
  memory_empty: "لا يوجد شيء محفوظ بعد. قل \"افتكر إن ...\" وسأحتفظ به.",
  memory_saved: "تمام، هفتكر: {content}",
  remember_usage: "الاستخدام: /remember متبوعاً بما تريدني أن أتذكره.",
  links_header: "*الروابط المحفوظة*",
  links_empty: "لا توجد روابط محفوظة. أرسل لي رابطاً وسألخصه وأحفظه.",
  link_saved: "تم الحفظ: {title}",
  brief_waiting_header: "في انتظار:",
  brief_reminders_header: "تذكيرات:",
  brief_stale_header: "مشاريع متوقفة:",
  brief_inbox: "الوارد: {count} عنصراً بانتظار الترتيب.",
  brief_focus_header: "اقتراح للتركيز:",
  brief_all_clear: "لا شيء يحتاج انتباهك اليوم. يومك صافٍ.",
  brief_enabled: "الملخص اليومي مفعّل الساعة {time}.",
  brief_disabled: "تم إيقاف الملخص اليومي.",
  brief_usage: "الاستخدام: /brief on 08:00 أو /brief off أو /brief now.",
  heartbeat_enabled: "التحديث الدوري مفعّل كل {hours} ساعات.",
  heartbeat_disabled: "تم إيقاف التحديث الدوري.",
  heartbeat_usage: "الاستخدام: /heartbeat on 4 أو /heartbeat off.",
  skills_header: "*المهارات*",
  skills_empty: "لا توجد مهارات محفوظة. صِف لي طريقة عمل متكررة وسأحفظها كمهارة.",
  wallet_header: "*المحفظة*",
  wallet_empty: "لا يوجد تسجيل للمال بعد. قل لي مثلاً \"اشتريت 2 كيلو سكر بـ 25 جنيه\" وسأتولى الدفتر.",
  wallet_totals: "داخل {in} · خارج {out} · المتبقي {net}",
  wallet_no_totals: "لم تتحرك أي مبالغ في هذه الفترة.",
  wallet_currency_set: "عملة المحفظة الآن {currency}. ستُستخدم للتسجيلات الجديدة ما لم تحدد غيرها.",
  wallet_usage:
    "الاستخدام: /wallet [today|yesterday|week|month|year|all] [in|out] [#وسم] [cat:أكل] [نص] · /wallet currency EGP",
  wallet_period_today: "اليوم",
  wallet_period_yesterday: "أمس",
  wallet_period_week: "آخر 7 أيام",
  wallet_period_month: "هذا الشهر",
  wallet_period_year: "هذه السنة",
  wallet_period_all: "كل الفترات",
  wallet_direction_in: "دخل",
  wallet_direction_out: "مصروف",
  mcp_header: "*خوادم MCP*",
  mcp_empty: "لا توجد خوادم MCP متصلة. اطلب مني إضافة واحد مع رابطه.",

  // ── القوائم وبطاقات التفاصيل والوسوم وقنوات الحفظ ────────────────────────
  list_page: "صفحة {page}/{pages}",
  list_empty: "لا يوجد شيء هنا.",
  list_grouped_by: "حسب {by}",
  btn_back: "◀ رجوع",
  btn_group: "⊞ {by}",
  group_none: "بدون تجميع",
  group_project: "المشروع",
  group_tag: "الوسم",
  group_status: "الحالة",
  group_priority: "الأولوية",
  group_kind: "النوع",
  group_type: "النوع",
  group_channel: "القناة",
  group_category: "التصنيف",
  group_date: "التاريخ",
  group_unfiled: "بدون مشروع",
  group_untagged: "بدون وسوم",
  group_no_date: "بدون تاريخ",
  group_no_channel: "ليس في قناة",
  group_uncategorized: "بدون تصنيف",
  reminders_header: "*التذكيرات*",
  reminders_empty: "لا توجد تذكيرات بعد. قل \"فكرني بكرة الساعة 9 …\".",
  inbox_title: "الوارد",
  tags_header: "*الوسوم*",
  tags_empty: "لا توجد وسوم بعد. أضيف الوسوم تلقائياً عند الحفظ — أو قل \"ضع وسم research على هذا\".",
  tags_hint: "اضغط على وسم لترى كل ما يحمله. صفِّ أي قائمة بـ #وسم، وجمّع بـ by:tag.",
  tag_results_header: "*الموسوم بـ* #{tag}",
  lbl_project: "المشروع",
  lbl_status: "الحالة",
  lbl_priority: "الأولوية",
  lbl_due: "الاستحقاق",
  lbl_tags: "الوسوم",
  lbl_created: "أُضيف",
  lbl_updated: "آخر تحديث",
  lbl_kind: "النوع",
  lbl_channel: "القناة",
  lbl_text: "النص",
  lbl_summary: "الملخص",
  lbl_next: "التالي",
  lbl_repeats: "يتكرر",
  lbl_open_done: "مفتوح / منجز",
  lbl_suggested: "مقترح",
  lbl_category: "التصنيف",
  lbl_direction: "النوع",
  lbl_when: "التاريخ",
  lbl_quantity: "الكمية",
  lbl_method: "طريقة الدفع",
  lbl_note: "ملاحظة",
  btn_done: "✅ تم",
  btn_reopen: "↩ إعادة فتح",
  btn_snooze: "⏭ +يوم",
  btn_delete: "🗑 حذف",
  btn_confirm_delete: "⚠️ تأكيد الحذف",
  btn_pin: "📌 تثبيت",
  btn_unpin: "📌 إلغاء التثبيت",
  btn_send_file: "📤 أرسله هنا",
  btn_open_vault: "🔗 افتح في القناة",
  btn_open_channel: "🔗 افتح القناة",
  btn_move_to: "→ {channel}",
  btn_forget: "🗑 انسَ",
  btn_pause: "⏸ إيقاف مؤقت",
  btn_resume: "▶ استئناف",
  btn_cancel_reminder: "✖ إلغاء",
  btn_archive: "📦 أرشفة",
  btn_project_tasks: "☑️ المهام",
  btn_project_notes: "📝 الملاحظات",
  btn_project_files: "📁 الملفات",
  btn_open_link: "🔗 فتح",
  btn_set_default: "⭐ اجعلها الافتراضية",
  btn_sync: "🔄 مزامنة",
  btn_remove: "🗑 إزالة",
  detail_confirm_hint: "اضغط مرة أخرى للتأكيد.",
  detail_done: "✅ تم إنجازها.",
  detail_reopened: "↩ أُعيد فتحها.",
  detail_snoozed: "⏭ نُقلت إلى {when}.",
  detail_deleted: "🗑 حُذف.",
  detail_pinned: "📌 ثُبّتت.",
  detail_unpinned: "أُلغي التثبيت.",
  detail_sent: "📤 أُرسل إلى هذه المحادثة.",
  detail_moved: "نُقل إلى {channel}.",
  detail_forgotten: "نُسي.",
  detail_paused: "⏸ أُوقف مؤقتاً.",
  detail_resumed: "▶ استُؤنف.",
  detail_cancelled: "✖ أُلغي.",
  detail_archived: "📦 أُرشف.",
  detail_not_found: "هذا العنصر لم يعد موجوداً.",
  vault_header: "*قنوات الحفظ*",
  vault_empty: "لا توجد قنوات حفظ بعد.",
  vault_is_default: "الافتراضية",
  vault_description_hint:
    "نصيحة: اكتب في وصف القناة \"Category: research\" و\"Tags: papers, pdf\" (أو #هاشتاجات) ثم اضغط مزامنة — أستخدمها لتقرير أين تُحفظ الملفات.",
  vault_connect_prompt: "أوصل *{title}* كقناة حفظ؟ سأقرأ وصفها لأستخرج التصنيف والوسوم.",
  btn_connect: "🔗 توصيل",
  btn_not_now: "ليس الآن",
  vault_connected: "تم توصيل *{title}* — التصنيف: {category} · الوسوم: {tags}.",
  vault_connect_failed: "تعذر توصيل القناة: {reason}",
  vault_already: "*{title}* متصلة بالفعل.",
  vault_default_set: "⭐ قناة الحفظ الافتراضية الآن هي {title}.",
  vault_synced: "🔄 {title}: {category} · {tags}",
  vault_removed: "أُزيلت {title}. الملفات المحفوظة فيها تبقى متاحة.",
  vault_usage: "الاستخدام: /vault (القائمة) · /vault add -1001234567890 [تصنيف] #وسم1 #وسم2 · /vault sync",
  file_saved_to: "حُفظ في *{channel}*: {name}",
  file_where: "حُفظ: {name}\nأين ينتمي؟",
  btn_move: "📁 {channel}",
  list_stale: "هذه الصفحة قديمة — أرسل الأمر مرة أخرى.",
} as const satisfies Record<keyof typeof en, string>;
