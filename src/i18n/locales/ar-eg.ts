import type { en } from "./en";

/**
 * Egyptian Arabic (colloquial) overrides for the conversational strings only.
 * Any key missing here falls back to MSA (ar), then English — see t() in
 * src/i18n/index.ts. Keep this list small: status lines, usage strings, and
 * headers deliberately stay MSA.
 */
export const arEG = {
  start_welcome:
    "أهلاً بيك! أنا مساعدك الشخصي الذكي. ابعت لي رسالة أو فويس أو ملف وأنا أتصرف. جرّب /help تشوف أقدر أعمل إيه.",
  not_allowed: "معلش، ده مساعد خاص وحسابك مش في القايمة المسموح بيها.",
  rate_limited: "على مهلك شوية! طلبات كتير ورا بعض. استنّى لحظة وجرّب تاني.",
  error_generic: "حصلت مشكلة عندي. جرّب تاني كمان شوية.",
  still_processing: "لسه شغال على طلبك اللي فات — ثانية واحدة.",
  cancelled: "تمام، اتلغى. عايز إيه تاني؟",
  tz_prompt:
    "الساعة كام عندك دلوقتي بصيغة HH:MM؟ أو ابعت منطقتك الزمنية بصيغة IANA زي Africa/Cairo. هستخدمها للتذكيرات والملخص اليومي.",
  confirm_prompt: "محتاج تأكيدك: {action}",
  btn_confirm: "تمام",
  btn_cancel: "بلاش",
  btn_edit: "عدّل",
  wallet_empty: "لسه مفيش أي فلوس متسجلة. قول لي مثلاً \"اشتريت 2 كيلو سكر بـ 25 جنيه\" وأنا أمسك الدفتر.",
  wallet_totals: "داخل {in} · خارج {out} · فاضل {net}",
  wallet_no_totals: "مفيش أي فلوس اتحركت في الفترة دي.",
  wallet_currency_set: "عملة المحفظة بقت {currency}. هستخدمها في اللي جاي غير لما تقول غير كده.",
} as const satisfies Partial<Record<keyof typeof en, string>>;
