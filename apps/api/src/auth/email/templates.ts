import type { EmailMessage } from "#src/auth/email/sender";

type Content = Pick<EmailMessage, "subject" | "text">;

/** The sign-in code email: Arabic first, then English, digits always 0-9. */
export function signInCodeEmail(input: { code: string; expiresInMinutes: number }): Content {
  const { code, expiresInMinutes } = input;
  return {
    subject: "رمز الدخول إلى كويستيفاي | Your Questify sign-in code",
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
      "إذا لم تكن أنت، تواصل مع فريق كويستيفاي فورا.",
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
      "وصلنا طلب لإعادة تعيين كلمة مرور حسابك في كويستيفاي.",
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
      `تغيّرت كلمة مرور حسابك في كويستيفاي في ${when}.`,
      `إذا لم تغيّرها أنت، أعد تعيينها فورا من ${input.dashboardOrigin}/ar/forgot-password وتواصل مع فريق كويستيفاي.`,
      "",
      `The password of your Questify account was changed at ${when}.`,
      `If this was not you, reset it now at ${input.dashboardOrigin}/en/forgot-password and contact the Questify team.`,
    ].join("\n"),
  };
}
