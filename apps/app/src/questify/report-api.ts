import type { ReportKind, ReportReason } from "@questify/shared";
import type { Session } from "#src/api/session.ts";
import { randomUuid } from "#src/api/uuid.ts";

/** What a report names: a row of an event by id, or a player by username (and the event the name was seen in). */
export type ReportSubject =
  | Readonly<{ kind: Exclude<ReportKind, "username">; targetId: string }>
  | Readonly<{ kind: "username"; username: string; eventId?: string | undefined }>;

export type ReportOutcome = "sent" | "limit" | "failed";

/** The request body: only the fields the kind takes, and a note only when the player wrote one. */
export function reportBody(
  subject: ReportSubject,
  reason: ReportReason,
  note: string,
): Record<string, string> {
  const written = note.trim();
  const target: Record<string, string> =
    subject.kind === "username"
      ? {
          username: subject.username,
          ...(subject.eventId === undefined ? {} : { eventId: subject.eventId }),
        }
      : { targetId: subject.targetId };
  return {
    kind: subject.kind,
    ...target,
    reason,
    ...(written === "" ? {} : { note: written }),
  };
}

/**
 * Sends a report to Questify (FR-1411, T-705b). The answer is the same for a new report and a repeat, so the player
 * is always thanked; only the caps (429) and a failure are told apart.
 */
export async function sendReport(
  session: Pick<Session, "request">,
  subject: ReportSubject,
  reason: ReportReason,
  note: string,
): Promise<ReportOutcome> {
  const answer = await session.request({
    method: "POST",
    path: "/v1/reports",
    body: reportBody(subject, reason, note),
    headers: { "idempotency-key": randomUuid() },
  });
  if (answer.kind === "ok") {
    return "sent";
  }
  return answer.kind === "error" && answer.status === 429 ? "limit" : "failed";
}
