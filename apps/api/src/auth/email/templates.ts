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
