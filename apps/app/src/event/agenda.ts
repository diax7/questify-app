import {
  memberSessionListSchema,
  sessionRegisterSchema,
  type LocalizedText,
  type MemberSession,
} from "@questify/shared";
import type { AuthedResult, Session } from "#src/api/session.ts";
import { textIn } from "#src/i18n/text.ts";

type Requester = Pick<Session, "request">;

export type AgendaRead =
  | Readonly<{ kind: "agenda"; sessions: readonly MemberSession[] }>
  | Readonly<{ kind: "signed_out" | "network" }>;

/** The agenda with the player's own state on each session, earliest first (`GET /v1/events/{id}/sessions`). */
export async function fetchAgenda(session: Requester, eventId: string): Promise<AgendaRead> {
  const answer = await session.request({
    method: "GET",
    path: `/v1/events/${encodeURIComponent(eventId)}/sessions`,
  });
  if (answer.kind === "signed_out") return { kind: "signed_out" };
  const parsed = answer.kind === "ok" ? memberSessionListSchema.safeParse(answer.body) : null;
  return parsed?.success === true
    ? { kind: "agenda", sessions: parsed.data.sessions }
    : { kind: "network" };
}

export type AgendaAct =
  | Readonly<{ kind: "registered" }>
  | Readonly<{ kind: "overlap"; titles: readonly LocalizedText[] }>
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "refused"; message: LocalizedText | null }>
  | Readonly<{ kind: "signed_out" | "network" }>;

const refusedOf = (answer: AuthedResult): AgendaAct => {
  if (answer.kind === "error") return { kind: "refused", message: answer.message };
  return { kind: answer.kind === "signed_out" ? "signed_out" : "network" };
};

/**
 * Registers for a session. The first call writes nothing when the session overlaps one the player already holds: the
 * answer lists them and the app asks, then calls again with `confirmOverlap` (FR-1790).
 */
export async function registerFor(
  session: Requester,
  eventId: string,
  sessionId: string,
  options: Readonly<{ confirmOverlap: boolean; idempotencyKey: string }>,
): Promise<AgendaAct> {
  const answer = await session.request({
    method: "POST",
    path: `/v1/events/${encodeURIComponent(eventId)}/sessions/${encodeURIComponent(sessionId)}/register`,
    body: options.confirmOverlap ? { confirmOverlap: true } : {},
    headers: { "idempotency-key": options.idempotencyKey },
  });
  if (answer.kind !== "ok") return refusedOf(answer);
  const parsed = sessionRegisterSchema.safeParse(answer.body);
  if (!parsed.success) return { kind: "network" };
  if (parsed.data.outcome === "registered") return { kind: "registered" };
  return {
    kind: "overlap",
    titles: parsed.data.overlaps.map((row) => ({
      ar: textIn(row.title, "ar"),
      en: textIn(row.title, "en"),
    })),
  };
}

/** Gives up a registration; the seat is free at once. */
export async function cancelRegistration(
  session: Requester,
  eventId: string,
  sessionId: string,
  idempotencyKey: string,
): Promise<AgendaAct> {
  const answer = await session.request({
    method: "POST",
    path: `/v1/events/${encodeURIComponent(eventId)}/sessions/${encodeURIComponent(sessionId)}/cancel`,
    body: {},
    headers: { "idempotency-key": idempotencyKey },
  });
  return answer.kind === "ok" ? { kind: "cancelled" } : refusedOf(answer);
}

/** The sessions on the tab: all of them, or only those the player registered for. */
export function shownSessions(
  sessions: readonly MemberSession[] | undefined,
  mine: boolean,
): readonly MemberSession[] {
  const all = sessions ?? [];
  return mine ? all.filter((row) => row.registered) : all;
}

/** What a session offers the player: the action, or the reason there is none. */
export type SessionOffer = "register" | "cancel" | "full" | "closed" | "started" | "none";

export function offerOf(session: MemberSession): SessionOffer {
  if (session.access === "open") return "none";
  if (session.registered) return session.cancellable ? "cancel" : "none";
  if (session.started) return "started";
  if (session.status === "full") return "full";
  return session.status === "closed" ? "closed" : "register";
}

/** The line that says where the player stands with a session, or null when there is nothing to say. */
export function statusKeyOf(
  session: MemberSession,
): "agenda.checkedIn" | "agenda.registered" | "agenda.open" | null {
  if (session.checkedIn) return "agenda.checkedIn";
  if (session.registered) return "agenda.registered";
  return session.access === "open" ? "agenda.open" : null;
}

/** Why a session offers no button: it is full, closed, or has started (the words' keys). */
export function noteKeyOf(
  session: MemberSession,
): "agenda.full" | "agenda.closed" | "agenda.started" | null {
  const offer = offerOf(session);
  if (offer === "full") return "agenda.full";
  if (offer === "closed") return "agenda.closed";
  return offer === "started" ? "agenda.started" : null;
}

/** The seats left to show: none for a session without a limit or one the player already holds. */
export const seatsLeftOf = (session: MemberSession): number | null =>
  session.registered ? null : session.seatsLeft;
