/**
 * Topic-based tool/prompt selection — port of the Stacks promptContext idea
 * (getstacksapp.com, used with the author's knowledge): pick topic sets from
 * cheap deterministic signals so each turn registers only the tools (and prompt
 * fragments) it plausibly needs. Favor recall over precision: a false positive
 * adds a few unused tools; a false negative makes the model unable to act.
 */

export type Topic =
  | "tasks"
  | "projects"
  | "notes"
  | "inbox"
  | "reminders"
  | "search"
  | "memory"
  | "files"
  | "wallet"
  | "settings";

export const ALL_TOPICS: Topic[] = [
  "tasks",
  "projects",
  "notes",
  "inbox",
  "reminders",
  "search",
  "memory",
  "files",
  "wallet",
  "settings",
];

/** Tools in these topics are ALWAYS registered (keep this list tiny). */
export const CORE_TOPICS: Topic[] = [];

const TOPIC_PATTERNS: Record<Topic, RegExp> = {
  tasks:
    /task|todo|to-do|checklist|done|finish|complete|overdue|deadline|due|priorit|مهمة|مهام|مهمه|انجز|أنجز|خلصت|اعمل|شغل/i,
  projects: /project|مشروع|مشاريع|بروجكت|بروجيكت/i,
  notes: /note|write down|jot|سجل|ملاحظة|ملاحظات|ملحوظة|اكتب|دوّن|دون/i,
  inbox: /inbox|organize|triage|sort|وارد|رتب|نظم|صنف/i,
  reminders:
    /remind|reminder|alarm|every (day|week|morning|sunday|monday|tuesday|wednesday|thursday|friday|saturday)|tomorrow|tonight|فكرني|ذكرني|ذكّرني|تذكير|منبه|بكرة|بكره|غدا|غداً|كل يوم|كل اسبوع|الساعة/i,
  search: /search|find|look for|where|ابحث|دور|دوّر|فين|أين|اعثر/i,
  memory: /remember|forget|memory|افتكر|تذكر|تتذكر|انسى|إنسى|احفظ في ذاكرت/i,
  files: /file|pdf|document|docx|attachment|photo|image|صورة|ملف|ملفات|مستند|مرفق/i,
  wallet:
    /wallet|expense|expenses|spend|spent|spending|paid|pay|bought|buy|purchase|income|salary|earn|earned|budget|cost|price|balance|money|cash|invoice|receipt|refund|جنيه|جنية|ج\.م|فلوس|فلوسي|مصروف|مصاريف|صرفت|اصرف|أصرف|دفعت|ادفع|اشتريت|شريت|اشتري|بشتري|دخل|مرتب|راتب|كسبت|رصيد|ميزانية|حساب المصاريف|سعر|تمن|بكام/i,
  settings: /setting|language|timezone|autonomy|اعدادات|إعدادات|اللغة|المنطقة الزمنية/i,
};

export function selectTopics(text: string): Topic[] {
  const matched = ALL_TOPICS.filter((topic) => TOPIC_PATTERNS[topic].test(text));
  const set = new Set<Topic>([...CORE_TOPICS, ...matched]);
  if (set.size === CORE_TOPICS.length) {
    // No signal — broad-but-cheap default so the model can still act.
    for (const topic of ["tasks", "projects", "notes", "reminders"] as Topic[]) set.add(topic);
  }
  // Anything that can reference a project needs project lookup available.
  if (set.has("tasks") || set.has("notes") || set.has("inbox") || set.has("files")) {
    set.add("projects");
  }
  return [...set];
}
