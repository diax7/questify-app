import type { Language } from "./digits";

export type Messages = Readonly<Record<string, Readonly<Record<Language, string>>>>;

/**
 * Every text the app and the dashboard show, in both languages. These are the shipped defaults: the app uses them
 * whenever the translation store has no value for a key or cannot be reached (FR-1768). Add a key in the same
 * change that uses it, with both languages and the same {placeholders} in each.
 */
export const MESSAGES = {
  "nav.home": { ar: "الرئيسية", en: "Home" },
  "nav.quests": { ar: "المهام", en: "Quests" },
  "nav.ranking": { ar: "الترتيب", en: "Ranking" },
  "nav.shop": { ar: "المتجر", en: "Shop" },
  "nav.profile": { ar: "حسابي", en: "Profile" },
  "common.loading": { ar: "جارٍ التحميل…", en: "Loading…" },
  "common.retry": { ar: "إعادة المحاولة", en: "Try again" },
  "error.generic": {
    ar: "حدث خطأ غير متوقع. حاول مرة أخرى.",
    en: "Something went wrong. Try again.",
  },
  "error.updateRequired": {
    ar: "يرجى تحديث التطبيق للمتابعة.",
    en: "Please update the app to continue.",
  },
  "points.balance": {
    ar: "لديك {points} {currency}",
    en: "You have {points} {currency}",
  },
} as const satisfies Messages;

export type MessageKey = keyof typeof MESSAGES;
