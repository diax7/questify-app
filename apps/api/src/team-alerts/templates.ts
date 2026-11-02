import type { EmailMessage } from "#src/auth/email/sender";

/** One line of the digest, as `team_alert_claim` answers it: ids, names, counts and codes, never personal data. */
export type AlertLine =
  | Readonly<{
      kind: "urgent_report";
      targetKind: string;
      targetId: string;
      reports: number;
      reasons: readonly string[];
      dueAt: string;
      event: Readonly<{ ar?: string; en?: string }> | null;
      organizer: string | null;
    }>
  | Readonly<{ kind: "email_change_dispute"; organizerId: string; organizer: string | null }>;

/** At most this many lines in one digest; the rest are counted. */
export const DIGEST_LINES = 20;

const riyadhTime = (at: Date): string =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Riyadh",
    dateStyle: "medium",
    timeStyle: "short",
    numberingSystem: "latn",
  }).format(at);

/** "due in 35 min" or "overdue by 2 h", Western digits. */
function relative(due: Date, now: Date): string {
  const minutes = Math.round((due.getTime() - now.getTime()) / 60_000);
  const size = Math.abs(minutes);
  const amount = size >= 120 ? `${Math.round(size / 60)} h` : `${size} min`;
  return minutes >= 0 ? `due in ${amount}` : `overdue by ${amount}`;
}

function lineOf(line: AlertLine, origin: string, now: Date): string {
  if (line.kind === "email_change_dispute") {
    return [
      `- Sign-in email change disputed from the old address | اعتراض على تغيير بريد الدخول`,
      `  ${line.organizer ?? "-"} | ${origin}/en/console/organizers/${line.organizerId}`,
    ].join("\n");
  }
  const due = new Date(line.dueAt);
  const event = [line.event?.ar, line.event?.en].filter(Boolean).join(" / ") || "-";
  return [
    `- ${line.targetKind}: ${line.reports} report(s) (${line.reasons.join(", ")})`,
    `  ${event} | ${line.organizer ?? "-"}`,
    `  ${riyadhTime(due)} (Riyadh), ${relative(due, now)}`,
    `  ${origin}/en/console/reports/${line.targetKind}/${line.targetId}`,
  ].join("\n");
}

/**
 * The team's digest (T-701b, ADR-494): up to 20 lines, then "and N more". It names events, organizers, kinds, counts,
 * reason codes and due times; never a reporter, a note, reported text or a username.
 */
export function teamAlertDigest(
  lines: readonly AlertLine[],
  input: Readonly<{ origin: string; now: Date }>,
): Pick<EmailMessage, "subject" | "text"> {
  const shown = lines.slice(0, DIGEST_LINES);
  const more = lines.length - shown.length;
  return {
    subject: `تنبيه عاجل للفريق (${lines.length}) | Questify team alert (${lines.length})`,
    text: [
      "بلاغات عاجلة وأمور تحتاج الفريق | Urgent reports and items for the team",
      "",
      ...shown.map((line) => lineOf(line, input.origin, input.now)),
      ...(more > 0
        ? ["", `و${more} أخرى | and ${more} more: ${input.origin}/en/console/reports`]
        : []),
    ].join("\n"),
  };
}
