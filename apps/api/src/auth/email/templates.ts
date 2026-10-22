import type { EmailMessage } from "#src/auth/email/sender";

type Content = Pick<EmailMessage, "subject" | "text">;

/** The sign-in code email: Arabic first, then English, digits always 0-9. */
export function signInCodeEmail(input: { code: string; expiresInMinutes: number }): Content {
  const { code, expiresInMinutes } = input;
  return {
    subject: "رمز الدخول إلى كويستفاي | Your Questify sign-in code",
    text: [
      `رمز الدخول الخاص بك: ${code}`,
      `الرمز صالح لمدة ${expiresInMinutes} دقائق. إذا لم تحاول تسجيل الدخول، تجاهل هذه الرسالة ولا تشارك الرمز مع أحد.`,
      "",
      `Your sign-in code: ${code}`,
      `It is valid for ${expiresInMinutes} minutes. If you did not try to sign in, ignore this email and never share the code.`,
    ].join("\n"),
  };
}

const riyadhTime = (at: Date): string =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Riyadh",
    dateStyle: "medium",
    timeStyle: "short",
    numberingSystem: "latn",
  }).format(at);

/** The alert sent when a platform admin opens a new session. */
export function newSignInAlertEmail(input: { at: Date; userAgent: string | null }): Content {
  const when = `${riyadhTime(input.at)} (Riyadh)`;
  const device = input.userAgent ?? "unknown";
  return {
    subject: "تسجيل دخول جديد إلى حسابك | New sign-in to your Questify account",
    text: [
      `تم تسجيل دخول جديد إلى حسابك في ${when}.`,
      `الجهاز: ${device}`,
      "إذا لم تكن أنت، تواصل مع فريق كويستفاي فورا.",
      "",
      `A new sign-in to your account happened at ${when}.`,
      `Device: ${device}`,
      "If this was not you, contact the Questify team immediately.",
    ].join("\n"),
  };
}

/** "N minutes" after "لمدة": one and two have their own forms; the noun is plural from 3 to 10, singular from 11. */
function minutesAr(count: number): string {
  if (count === 1) {
    return "دقيقة واحدة";
  }
  if (count === 2) {
    return "دقيقتين";
  }
  return count >= 3 && count <= 10 ? `${count} دقائق` : `${count} دقيقة`;
}

/** The password reset link (T-020). The link holds the secret in its fragment; the text never repeats it. */
export function passwordResetEmail(input: { link: string; expiresInMinutes: number }): Content {
  const { link, expiresInMinutes } = input;
  return {
    subject: "إعادة تعيين كلمة المرور | Reset your Questify password",
    text: [
      "وصلنا طلب لإعادة تعيين كلمة مرور حسابك في كويستفاي.",
      `افتح هذا الرابط لاختيار كلمة مرور جديدة: ${link}`,
      `يعمل الرابط مرة واحدة لمدة ${minutesAr(expiresInMinutes)}. إذا لم تطلب ذلك، تجاهل هذه الرسالة، فكلمة مرورك لم تتغير.`,
      "",
      "We received a request to reset the password of your Questify account.",
      `Open this link to choose a new password: ${link}`,
      `The link works once, for ${expiresInMinutes} minutes. If you did not ask for this, ignore this email; your password has not changed.`,
    ].join("\n"),
  };
}

/** Sent after every password change or reset, so a person learns at once if it was not them. */
export function passwordChangedEmail(input: { at: Date; dashboardOrigin: string }): Content {
  const when = `${riyadhTime(input.at)} (Riyadh)`;
  return {
    subject: "تغيّرت كلمة المرور | Your Questify password was changed",
    text: [
      `تغيّرت كلمة مرور حسابك في كويستفاي في ${when}.`,
      `إذا لم تغيّرها أنت، أعد تعيينها فورا من ${input.dashboardOrigin}/ar/forgot-password وتواصل مع فريق كويستفاي.`,
      "",
      `The password of your Questify account was changed at ${when}.`,
      `If this was not you, reset it now at ${input.dashboardOrigin}/en/forgot-password and contact the Questify team.`,
    ].join("\n"),
  };
}

/** The organizer sign-up code (T-101). It carries nothing the person typed, so it cannot carry someone's message. */
export function signUpCodeEmail(input: { code: string; expiresInMinutes: number }): Content {
  const { code, expiresInMinutes } = input;
  return {
    subject: "رمز إنشاء حسابك في كويستفاي | Your Questify sign-up code",
    text: [
      `رمز إنشاء حسابك: ${code}`,
      `الرمز صالح لمدة ${minutesAr(expiresInMinutes)}. إذا لم تحاول إنشاء حساب في كويستفاي، تجاهل هذه الرسالة ولا تشارك الرمز مع أحد.`,
      "",
      `Your sign-up code: ${code}`,
      `It is valid for ${expiresInMinutes} minutes. If you did not try to create a Questify account, ignore this email and never share the code.`,
    ].join("\n"),
  };
}

/** Sent instead of a sign-up code when the email already has an account; it holds no code. */
export function alreadyHaveAccountEmail(input: { dashboardOrigin: string }): Content {
  const origin = input.dashboardOrigin;
  return {
    subject: "لديك حساب في كويستفاي | You already have a Questify account",
    text: [
      "طُلب إنشاء حساب جديد في كويستفاي بهذا البريد، وله حساب لدينا من قبل.",
      `سجّل الدخول من ${origin}/ar/sign-in ثم أنشئ جهة منظِّمة جديدة من حسابك.`,
      `إذا نسيت كلمة المرور، فأعد تعيينها من ${origin}/ar/forgot-password.`,
      "إذا لم تطلب ذلك، تجاهل هذه الرسالة.",
      "",
      "Someone asked to create a new Questify account with this email, which already has one.",
      `Sign in at ${origin}/en/sign-in, then create a new organizer from your account.`,
      `If you forgot your password, reset it at ${origin}/en/forgot-password.`,
      "If this was not you, ignore this email.",
    ].join("\n"),
  };
}

/**
 * A team invite (T-101). The organizer's name is the only text an organizer wrote, and names that read as addresses
 * are refused when the organizer is created (organizers/naming.ts).
 */
export function inviteEmail(input: {
  organizerName: string;
  role: "editor" | "owner";
  link: string;
  validForDays: number;
}): Content {
  const { organizerName, link, validForDays } = input;
  const ar =
    input.role === "owner"
      ? `دُعيت لتصبح مالك «${organizerName}» في كويستفاي.`
      : `دُعيت إلى فريق «${organizerName}» في كويستفاي محررًا للفعاليات.`;
  const en =
    input.role === "owner"
      ? `You are invited to become the owner of "${organizerName}" on Questify.`
      : `You are invited to join the "${organizerName}" team on Questify as an editor.`;
  return {
    subject:
      input.role === "owner"
        ? "دعوة لملكية جهة منظِّمة | Become an organizer's owner on Questify"
        : "دعوة إلى فريق في كويستفاي | You are invited to a Questify team",
    text: [
      ar,
      `افتح الرابط لقبول الدعوة: ${link}`,
      `الرابط صالح لمدة ${validForDays} أيام. إذا لم تتوقع هذه الدعوة، تجاهل الرسالة.`,
      "",
      en,
      `Open this link to accept: ${link}`,
      `The link works for ${validForDays} days. If you did not expect this invite, ignore this email.`,
    ].join("\n"),
  };
}

/** The code that adds or changes a player's email (T-108): it says what it is for, never "sign-in". */
export function contactCodeEmail(input: { code: string; expiresInMinutes: number }): Content {
  const { code, expiresInMinutes } = input;
  return {
    subject: "رمز إضافة بريدك إلى كويستفاي | Your code to add this email to Questify",
    text: [
      `رمز إضافة هذا البريد إلى حسابك في كويستفاي: ${code}`,
      `الرمز صالح لمدة ${expiresInMinutes} دقائق. إذا لم تطلبه، تجاهل هذه الرسالة ولا تشاركه مع أحد.`,
      "",
      `Your code to add this email to a Questify account: ${code}`,
      `It is valid for ${expiresInMinutes} minutes. If you did not ask for it, ignore this email and never share the code.`,
    ].join("\n"),
  };
}

/**
 * Tells a player that a phone or email on their account was added or changed (T-108): to the old value and to the
 * other one, so a change made from someone else's hands is seen. It never names the new value.
 */
export function contactChangedEmail(input: {
  channel: "phone" | "email";
  kind: "added" | "replaced";
}): Content {
  const [ar, en] = CHANGE_LINES[input.channel][input.kind];
  return {
    subject: "تغيّرت بيانات دخولك في كويستفاي | Your Questify sign-in details changed",
    text: [
      ar,
      "إذا كان هذا أنت، فلا داعي لأي إجراء. إن لم تكن أنت، تواصل معنا من الإعدادات في التطبيق.",
      "",
      en,
      "If this was you, there is nothing to do. If it was not, contact us from Settings in the app.",
    ].join("\n"),
  };
}

const CHANGE_LINES = {
  phone: {
    added: [
      "أُضيف رقم جوال إلى حسابك في كويستفاي.",
      "A phone number was added to your Questify account.",
    ],
    replaced: [
      "تغيّر رقم الجوال في حسابك في كويستفاي.",
      "The phone number on your Questify account was changed.",
    ],
  },
  email: {
    added: [
      "أُضيف بريد إلكتروني إلى حسابك في كويستفاي.",
      "An email address was added to your Questify account.",
    ],
    replaced: [
      "تغيّر البريد الإلكتروني في حسابك في كويستفاي.",
      "The email address on your Questify account was changed.",
    ],
  },
} as const;

/**
 * An operator invite (T-204, email only). No organizer-written text: the app shows the event's name on the claim
 * screen, after sign-in, so this email carries nothing a stranger could dress up.
 */
export function operatorInviteEmail(input: { link: string; validForDays: number }): Content {
  const { link, validForDays } = input;
  return {
    subject: "دعوة لتكون مشغّلًا في فعالية | You are invited to staff an event on Questify",
    text: [
      "دُعيت لتعمل مشغّلًا في فعالية على كويستفاي.",
      `افتح الرابط على جوالك وأكّد في تطبيق كويستفاي: ${link}`,
      `سجّل الدخول بهذا البريد نفسه. الرابط صالح لمدة ${validForDays} أيام، أو حتى نهاية الفعالية. إذا لم تتوقع هذه الدعوة، تجاهل الرسالة.`,
      "",
      "You are invited to work as an operator at an event on Questify.",
      `Open this link on your phone and confirm in the Questify app: ${link}`,
      `Sign in with this same email. The link works for ${validForDays} days, or until the event ends. If you did not expect this invite, ignore this email.`,
    ].join("\n"),
  };
}
