import type { OrganizerAlertType } from "@questify/shared";
import type { EmailMessage } from "#src/auth/email/sender";

type Content = Pick<EmailMessage, "subject" | "text">;

type Wording = Readonly<{ subject: string; ar: string; en: string }>;

/**
 * What each alert says (T-503, FR-1727, ADR-360): fixed Arabic then English, naming nothing but the kind of thing that
 * happened. No event name, amount, code, player or ticket text: the email goes outside the Kingdom, and the dashboard
 * link it carries shows the detail to someone who is signed in.
 */
const WORDING: Readonly<Record<OrganizerAlertType, Wording>> = {
  activated: {
    subject: "تفعيل فعالية | An event was activated",
    ar: "تم تفعيل إحدى فعالياتك.",
    en: "One of your events was activated.",
  },
  stock_low: {
    subject: "المخزون على وشك النفاد | Stock is running low",
    ar: "اقترب مخزون إحدى جوائزك من النفاد.",
    en: "The stock of one of your rewards is running low.",
  },
  codes_low: {
    subject: "الأكواد على وشك النفاد | Codes are running low",
    ar: "اقتربت الأكواد المتاحة لإحدى جوائزك الرقمية من النفاد.",
    en: "The available codes of one of your digital rewards are running low.",
  },
  new_flags: {
    subject: "علامة جديدة تحتاج مراجعة | A new flag to review",
    ar: "ظهرت علامة جديدة على لاعب في إحدى فعالياتك.",
    en: "A new flag was raised on a player in one of your events.",
  },
  content_unpublished: {
    subject: "إلغاء نشر محتوى | Content was unpublished",
    ar: "أُلغي نشر محتوى في إحدى فعالياتك.",
    en: "Some content in one of your events was unpublished.",
  },
  support_access: {
    subject: "اطّلع فريق الدعم على فعاليتك | Support looked at your event",
    ar: "اطّلع فريق دعم كويستفاي على تذاكر إحدى فعالياتك.",
    en: "Questify support looked at the tickets of one of your events.",
  },
  size_limit: {
    subject: "حد اللاعبين | Player limit",
    ar: "اقترب عدد اللاعبين في إحدى فعالياتك من الحد المسموح أو بلغه.",
    en: "The number of players in one of your events is near its limit or has reached it.",
  },
};

export type AlertLinks = Readonly<{ origin: string; organizerId: string; eventId: string | null }>;

/** The alert email for one type, with the dashboard link to the event (or the organizer) and to the alert settings. */
export function organizerAlertEmail(type: OrganizerAlertType, links: AlertLinks): Content {
  const wording = WORDING[type];
  const page = (lang: "ar" | "en", path: string): string =>
    `${links.origin}/${lang}/organizers/${links.organizerId}${path}`;
  const eventPath = links.eventId === null ? "" : `/events/${links.eventId}`;
  return {
    subject: wording.subject,
    text: [
      wording.ar,
      `افتح لوحة التحكم: ${page("ar", eventPath)}`,
      `لتغيير التنبيهات التي تصلك: ${page("ar", "/team")}`,
      "",
      wording.en,
      `Open the dashboard: ${page("en", eventPath)}`,
      `To change which alerts you get: ${page("en", "/team")}`,
    ].join("\n"),
  };
}
