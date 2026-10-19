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
  "common.cancel": { ar: "إلغاء", en: "Cancel" },
  "common.continue": { ar: "متابعة", en: "Continue" },
  "common.comingSoon": { ar: "قريبا", en: "Coming soon" },
  "settings.language": { ar: "اللغة", en: "Language" },
  "settings.restartTitle": { ar: "تغيير اللغة", en: "Change language" },
  "settings.restartBody": {
    ar: "سيُعاد تشغيل التطبيق ليظهر بالكامل باللغة الجديدة.",
    en: "The app will restart to show everything in the new language.",
  },
  "error.network": {
    ar: "تعذّر الاتصال. تحقق من اتصالك بالإنترنت ثم حاول مرة أخرى.",
    en: "Could not connect. Check your connection and try again.",
  },
  "staff.dashboard": { ar: "لوحة تحكم Questify", en: "Questify dashboard" },
  "staff.signIn": { ar: "تسجيل الدخول", en: "Sign in" },
  "staff.email": { ar: "البريد الإلكتروني", en: "Email" },
  "staff.password": { ar: "كلمة المرور", en: "Password" },
  "staff.codeTitle": { ar: "أدخل رمز الدخول", en: "Enter your sign-in code" },
  "staff.codeSent": {
    ar: "أرسلنا رمزًا من 6 أرقام إلى {email}.",
    en: "We sent a 6-digit code to {email}.",
  },
  "staff.code": { ar: "رمز الدخول", en: "Sign-in code" },
  "staff.resend": { ar: "إرسال رمز جديد", en: "Send a new code" },
  "staff.resendIn": { ar: "إرسال رمز جديد ({time})", en: "Send a new code ({time})" },
  "staff.resent": { ar: "أرسلنا رمزًا جديدًا.", en: "We sent a new code." },
  "staff.otherAccount": { ar: "استخدام حساب آخر", en: "Use a different account" },
  "staff.attemptsLeft": { ar: "المحاولات المتبقية: {count}", en: "Attempts left: {count}" },
  "staff.tryAgainIn": { ar: "حاول مرة أخرى بعد {time}.", en: "Try again in {time}." },
  "staff.sessionEnded": {
    ar: "انتهت جلستك. سجّل الدخول من جديد.",
    en: "Your session has ended. Sign in again.",
  },
  "staff.signedInAs": { ar: "دخلت بحساب {email}", en: "Signed in as {email}" },
  "staff.organizers": { ar: "الجهات المنظِّمة", en: "Your organizers" },
  "staff.noOrganizers": {
    ar: "لست عضوًا في أي جهة منظِّمة بعد. اطلب من مالكها دعوتك.",
    en: "You are not part of an organizer yet. Ask its owner to invite you.",
  },
  "staff.role.owner": { ar: "مالك", en: "Owner" },
  "staff.role.editor": { ar: "محرر", en: "Editor" },
  "staff.signOut": { ar: "تسجيل الخروج", en: "Sign out" },
  "points.balance": {
    ar: "لديك {points} {currency}",
    en: "You have {points} {currency}",
  },
} as const satisfies Messages;

export type MessageKey = keyof typeof MESSAGES;
