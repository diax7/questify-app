import { HttpError } from "#src/http-error";

type Details = Readonly<Record<string, unknown>>;

const make =
  (status: number, code: string, ar: string, en: string) =>
  (details: Details = {}): HttpError =>
    new HttpError(status, code, { ar, en }, details);

export const invalidCredentials = make(
  401,
  "invalid_credentials",
  "البريد الإلكتروني أو كلمة المرور غير صحيحة.",
  "The email or password is not correct.",
);
export const invalidCode = make(
  401,
  "invalid_code",
  "الرمز غير صحيح.",
  "That code is not correct.",
);
export const unauthenticated = make(
  401,
  "unauthenticated",
  "يلزم تسجيل الدخول.",
  "Sign in to continue.",
);
export const sessionExpired = make(
  401,
  "session_expired",
  "انتهت جلستك. سجّل الدخول من جديد.",
  "Your session has ended. Sign in again.",
);
export const csrfRejected = make(
  403,
  "csrf_rejected",
  "الطلب مرفوض.",
  "This request was rejected.",
);
export const challengeExpired = make(
  410,
  "challenge_expired",
  "انتهت صلاحية الرمز. ابدأ تسجيل الدخول من جديد.",
  "That code has expired. Start signing in again.",
);
export const tooManyAttempts = make(
  429,
  "too_many_attempts",
  "محاولات كثيرة. حاول مرة أخرى لاحقا.",
  "Too many attempts. Try again later.",
);
export const tooManyChallenges = make(
  429,
  "too_many_challenges",
  "طلبات كثيرة لرموز الدخول. حاول مرة أخرى لاحقا.",
  "Too many sign-in codes were requested. Try again later.",
);
export const resendTooSoon = make(
  429,
  "resend_too_soon",
  "انتظر قليلا قبل طلب رمز جديد.",
  "Wait a moment before asking for a new code.",
);
export const resendLimit = make(
  429,
  "resend_limit",
  "وصلت إلى الحد الأقصى لإعادة الإرسال. ابدأ من جديد.",
  "You have used all resends. Start signing in again.",
);
export const busy = make(
  503,
  "busy",
  "الخدمة مشغولة. حاول بعد لحظات.",
  "The service is busy. Try again in a moment.",
);
export const emailUnavailable = make(
  503,
  "email_unavailable",
  "تعذر إرسال الرمز. حاول مرة أخرى بعد قليل.",
  "We could not send the code. Try again shortly.",
);
export const invalidRequest = make(
  400,
  "invalid_request",
  "الطلب غير صالح.",
  "The request is not valid.",
);
export const notFound = make(404, "not_found", "غير موجود.", "Not found.");
export const weakPassword = make(
  422,
  "weak_password",
  "اختر كلمة مرور أقوى.",
  "Choose a stronger password.",
);
export const resetLinkInvalid = make(
  410,
  "reset_link_invalid",
  "انتهت صلاحية الرابط أو استُخدم من قبل. اطلب رابطا جديدا.",
  "This link has expired or was already used. Ask for a new one.",
);
export const currentPasswordWrong = make(
  403,
  "current_password_wrong",
  "كلمة المرور الحالية غير صحيحة.",
  "Your current password is not correct.",
);
export const breachCheckUnavailable = make(
  503,
  "breach_check_unavailable",
  "تعذر فحص كلمة المرور الآن. حاول بعد قليل.",
  "We could not check the password right now. Try again shortly.",
);
export const ownerOnly = make(
  403,
  "owner_only",
  "هذا الإجراء لمالك الجهة المنظِّمة فقط.",
  "Only the organizer's owner can do this.",
);
