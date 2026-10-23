import type { LocalizedText } from "@questify/shared";
import type { AuthedResult, Session } from "#src/api/session.ts";
import { readJoinCard, type JoinCard } from "#src/join/join-api.ts";

type Text = Readonly<{ ar: string | null; en: string | null }>;

/** The event a rehearsal code opens (`GET /v1/rehearsals/{code}`, T-211). */
export type RehearsalEvent = Readonly<{
  id: string;
  name: Text;
  venue: Text;
  statusNow: string;
}>;

export type RehearsalCardAnswer =
  | Readonly<{ kind: "card"; event: RehearsalEvent; card: JoinCard }>
  | Readonly<{ kind: "not_found" | "throttled" | "network" | "signed_out" }>;

export type RehearsalJoinAnswer =
  | Readonly<{ kind: "joined"; eventId: string; alreadyMember: boolean }>
  | Readonly<{ kind: "stale"; card: JoinCard }>
  | Readonly<{ kind: "refused"; code: string; problem: LocalizedText | null }>
  | Readonly<{ kind: "signed_out" | "network" }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isText = (value: unknown): value is Text =>
  isRecord(value) &&
  (value["ar"] === null || typeof value["ar"] === "string") &&
  (value["en"] === null || typeof value["en"] === "string");

/** The card's event, checked: a changed API reads as a network failure instead of a broken screen. */
export function readRehearsalEvent(value: unknown): RehearsalEvent | undefined {
  return isRecord(value) &&
    typeof value["id"] === "string" &&
    isText(value["name"]) &&
    isText(value["venue"]) &&
    typeof value["statusNow"] === "string"
    ? {
        id: value["id"],
        name: value["name"],
        venue: value["venue"],
        statusNow: value["statusNow"],
      }
    : undefined;
}

export function rehearsalCardAnswer(answer: AuthedResult): RehearsalCardAnswer {
  if (answer.kind === "signed_out" || answer.kind === "network") {
    return { kind: answer.kind };
  }
  if (answer.kind === "error") {
    return {
      kind: answer.status === 429 ? "throttled" : answer.status === 404 ? "not_found" : "network",
    };
  }
  const body = isRecord(answer.body) ? answer.body : {};
  const event = readRehearsalEvent(body["event"]);
  const card = readJoinCard(body["card"]);
  return event === undefined || card === undefined
    ? { kind: "network" }
    : { kind: "card", event, card };
}

export function rehearsalJoinAnswer(answer: AuthedResult): RehearsalJoinAnswer {
  if (answer.kind === "signed_out" || answer.kind === "network") {
    return { kind: answer.kind };
  }
  if (answer.kind === "ok") {
    const body = isRecord(answer.body) ? answer.body : {};
    return typeof body["eventId"] === "string"
      ? { kind: "joined", eventId: body["eventId"], alreadyMember: body["alreadyMember"] === true }
      : { kind: "network" };
  }
  const card =
    answer.code === "card_version_stale" ? readJoinCard(answer.details["card"]) : undefined;
  return card === undefined
    ? { kind: "refused", code: answer.code, problem: answer.message }
    : { kind: "stale", card };
}

/** The event a rehearsal code opens, for a signed-in player (wrong codes count like wrong join codes). */
export async function fetchRehearsal(
  session: Pick<Session, "request">,
  code: string,
): Promise<RehearsalCardAnswer> {
  return rehearsalCardAnswer(
    await session.request({ method: "GET", path: `/v1/rehearsals/${encodeURIComponent(code)}` }),
  );
}

/** Joins as a rehearsal account with the card the person saw; joining again answers the same account. */
export async function joinRehearsal(
  session: Pick<Session, "request">,
  code: string,
  cardVersion: string,
): Promise<RehearsalJoinAnswer> {
  return rehearsalJoinAnswer(
    await session.request({
      method: "POST",
      path: "/v1/rehearsals/join",
      body: { code, cardVersion },
    }),
  );
}
