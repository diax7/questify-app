import type { EmailMessage } from "#src/auth/email/sender";

type Content = Pick<EmailMessage, "subject" | "text">;

const riyadhTime = (at: Date): string =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Riyadh",
    dateStyle: "medium",
    timeStyle: "short",
    numberingSystem: "latn",
  }).format(at);

/** "jane@example.com" as "j•••@e•••.com": enough to recognise, not enough to copy. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  const local = email.slice(0, Math.max(at, 0));
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : "";
  return `${local.slice(0, 1)}•••@${host.slice(0, 1)}•••${tld}`;
}

/** The code and link to the new address (T-701b). The link holds its secret in the fragment; the text never repeats it. */
export function ownerEmailCodeEmail(
  input: Readonly<{ code: string; link: string; organizerName: string; expiresInMinutes: number }>,
): Content {
  const { code, link, organizerName, expiresInMinutes } = input;
  return {
    subject: "تأكيد بريد الدخول الجديد | Confirm your new Questify sign-in email",
    text: [
      `طلب دعم كويستفاي تغيير بريد الدخول لحساب «${organizerName}» إلى هذا البريد.`,
      `رمز التأكيد: ${code}`,
      `افتح هذا الرابط واكتب الرمز وكلمة المرور الحالية: ${link}`,
      `الرمز صالح لمدة ${expiresInMinutes} دقيقة. لا تشاركه مع أحد، ولن يطلبه منك فريق الدعم أبدا.`,
      "",
      `Questify support asked to change the sign-in email of the "${organizerName}" account to this address.`,
      `Confirmation code: ${code}`,
      `Open this link and type the code and your current password: ${link}`,
      `The code is valid for ${expiresInMinutes} minutes. Never share it; Questify support will never ask for it.`,
    ].join("\n"),
  };
}

/** To the old address as soon as a change starts, with the Stop link. */
export function ownerEmailStartedEmail(
  input: Readonly<{ newMasked: string; stopLink: string }>,
): Content {
  return {
    subject: "طلب تغيير بريد الدخول | A change of your Questify sign-in email was started",
    text: [
      `بدأ دعم كويستفاي تغيير بريد الدخول لحسابك إلى ${input.newMasked}.`,
      `إذا لم تطلب ذلك، أوقف التغيير من هنا: ${input.stopLink}`,
      "ثم تواصل مع دعم كويستفاي.",
      "",
      `Questify support started changing your sign-in email to ${input.newMasked}.`,
      `If you did not ask for this, stop the change here: ${input.stopLink}`,
      "Then contact Questify support.",
    ].join("\n"),
  };
}

/** To the old address when the owner confirmed without the password: the change waits until `appliesAt`. */
export function ownerEmailHeldEmail(
  input: Readonly<{ newMasked: string; appliesAt: Date; stopLink: string }>,
): Content {
  const when = `${riyadhTime(input.appliesAt)} (Riyadh)`;
  return {
    subject: "سيتغير بريد الدخول بعد 24 ساعة | Your Questify sign-in email changes in 24 hours",
    text: [
      `سيتغير بريد الدخول لحسابك إلى ${input.newMasked} في ${when}.`,
      `إذا لم تطلب ذلك، أوقف التغيير قبل هذا الموعد: ${input.stopLink}`,
      "",
      `Your sign-in email will change to ${input.newMasked} at ${when}.`,
      `If you did not ask for this, stop the change before then: ${input.stopLink}`,
    ].join("\n"),
  };
}

/** To the new address once the change applied. */
export function ownerEmailChangedNewEmail(
  input: Readonly<{ email: string; dashboardOrigin: string }>,
): Content {
  return {
    subject: "تغيّر بريد الدخول | Your Questify sign-in email was changed",
    text: [
      `أصبح بريد الدخول لحسابك في كويستفاي: ${input.email}`,
      `سجّل الدخول من ${input.dashboardOrigin}/ar/sign-in بكلمة مرورك. إن نسيتها فاختر «نسيت كلمة المرور».`,
      "",
      `Your Questify sign-in email is now ${input.email}.`,
      `Sign in at ${input.dashboardOrigin}/en/sign-in with your password, or use "Forgot password".`,
    ].join("\n"),
  };
}

/** To the old address once the change applied: the account was signed out everywhere; Stop now alerts support. */
export function ownerEmailChangedOldEmail(
  input: Readonly<{ newMasked: string; stopLink: string }>,
): Content {
  return {
    subject: "تغيّر بريد الدخول | Your Questify sign-in email was changed",
    text: [
      `تغيّر بريد الدخول لحسابك إلى ${input.newMasked}، وخرج الحساب من كل الأجهزة.`,
      `إذا لم يكن هذا أنت، أبلغ دعم كويستفاي من هنا خلال 7 أيام: ${input.stopLink}`,
      "",
      `Your sign-in email was changed to ${input.newMasked} and you were signed out everywhere.`,
      `If this was not you, tell Questify support here within 7 days: ${input.stopLink}`,
    ].join("\n"),
  };
}
