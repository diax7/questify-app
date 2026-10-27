import { readScan } from "#src/event/scan.ts";
import { inviteTokenOf } from "#src/operator/station.ts";

/**
 * What the Questify home camera read (FR-831, FR-1614, ADR-324). Outside an event the center button opens operator
 * invites and join links only; a code that belongs inside an event says so.
 */
export type JoinScan =
  | Readonly<{ kind: "invite"; token: string }>
  | Readonly<{ kind: "join"; code: string }>
  | Readonly<{ kind: "event_only" }>
  | Readonly<{ kind: "other" }>;

/**
 * Classifies a scanned text. An operator invite is checked first: it is how staff join an event, and the event
 * scanner's own classifier does not know it. Then the event scanner's classifier decides: a join link opens its join
 * card, any code that works inside an event (quest, station screen, passport step, hidden category, meet) says to open
 * the event first, and the rest is not a join code. No rehearsal QR exists (a rehearsal code is typed, T-211), so none
 * is read here.
 */
export function classifyJoinScan(text: string, extraOrigin: string | null): JoinScan {
  const token = inviteTokenOf(text);
  if (token !== null) {
    return { kind: "invite", token };
  }
  const scan = readScan(text, extraOrigin);
  if (scan.kind === "join") {
    return { kind: "join", code: scan.code };
  }
  return scan.kind === "other" ? { kind: "other" } : { kind: "event_only" };
}
