import type { LocalizedText } from "@questify/shared";
import type { ApiResult, Client } from "#src/api/client.ts";
import type { AuthedResult, Session } from "#src/api/session.ts";
import type { PendingJoin } from "#src/auth/sign-in-flow.ts";

type Text = Readonly<{ ar: string | null; en: string | null }>;

/** An event as its join card shows it (`GET /v1/public/events/{code}`, T-111). */
export type CardEvent = Readonly<{
  id: string;
  joinCode: string;
  name: Text;
  venue: Text;
  startsAt: string;
  endsAt: string;
  timezone: string;
  statusNow: "scheduled" | "live" | "ended";
  access: "public" | "unlisted" | "private";
}>;

export type JoinCard = Readonly<{
  version: string;
  title: LocalizedText;
  receives: readonly LocalizedText[];
}>;

export type CardAnswer =
  | Readonly<{ kind: "card"; event: CardEvent; card: JoinCard }>
  | Readonly<{ kind: "not_found" | "throttled" | "network" }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isLocalized = (value: unknown): value is LocalizedText =>
  isRecord(value) && typeof value["ar"] === "string" && typeof value["en"] === "string";

/** The join card's own fields: its version, the title and what the organizer will see, each in both languages. */
function readJoinCard(card: unknown): JoinCard | undefined {
  if (
    !isRecord(card) ||
    typeof card["version"] !== "string" ||
    !isLocalized(card["title"]) ||
    !Array.isArray(card["receives"]) ||
    !card["receives"].every(isLocalized)
  ) {
    return undefined;
  }
  return {
    version: card["version"],
    title: card["title"],
    receives: card["receives"] as LocalizedText[],
  };
}

/** Checks the card's shape, so a changed API shows "can't load" instead of a broken screen. */
export function readCard(
  body: unknown,
): Readonly<{ event: CardEvent; card: JoinCard }> | undefined {
  if (!isRecord(body) || !isRecord(body["event"]) || !isRecord(body["card"])) {
    return undefined;
  }
  const event = body["event"];
  const card = readJoinCard(body["card"]);
  const strings = ["id", "joinCode", "startsAt", "endsAt", "timezone"] as const;
  if (
    card === undefined ||
    strings.some((key) => typeof event[key] !== "string") ||
    !isRecord(event["name"]) ||
    !isRecord(event["venue"]) ||
    !["scheduled", "live", "ended"].includes(String(event["statusNow"])) ||
    !["public", "unlisted", "private"].includes(String(event["access"]))
  ) {
    return undefined;
  }
  return { event: event as unknown as CardEvent, card };
}

function cardAnswer(answer: ApiResult): CardAnswer {
  if (answer.kind === "network") {
    return { kind: "network" };
  }
  if (answer.kind === "error") {
    return {
      kind: answer.status === 429 ? "throttled" : answer.status === 404 ? "not_found" : "network",
    };
  }
  const read = readCard(answer.body);
  return read === undefined ? { kind: "network" } : { kind: "card", ...read };
}

/** The join card by its code, before or after sign-in (FR-121, FR-111). */
export async function fetchCard(client: Client, code: string): Promise<CardAnswer> {
  return cardAnswer(
    await client.request({ method: "GET", path: `/v1/public/events/${encodeURIComponent(code)}` }),
  );
}

export type JoinOutcome =
  | Readonly<{
      kind: "joined";
      eventId: string;
      status: "active" | "pending";
      alreadyMember: boolean;
    }>
  /** The card changed (join answers, a new version): show the new one; a new Join tap is the consent. */
  | Readonly<{ kind: "stale"; card: JoinCard }>
  | Readonly<{ kind: "refused"; code: string; problem: LocalizedText | null }>
  | Readonly<{ kind: "signed_out" | "network" }>;

function joinOutcome(answer: AuthedResult): JoinOutcome {
  if (answer.kind === "signed_out" || answer.kind === "network") {
    return { kind: answer.kind };
  }
  if (answer.kind === "ok") {
    const body = isRecord(answer.body) ? answer.body : {};
    const status = body["status"] === "pending" ? "pending" : "active";
    return typeof body["eventId"] === "string"
      ? {
          kind: "joined",
          eventId: body["eventId"],
          status,
          alreadyMember: body["alreadyMember"] === true,
        }
      : { kind: "network" };
  }
  const card =
    answer.code === "card_version_stale" ? readJoinCard(answer.details["card"]) : undefined;
  if (card !== undefined) {
    return { kind: "stale", card };
  }
  return { kind: "refused", code: answer.code, problem: answer.message };
}

/**
 * Joins with the card the person saw (FR-121): by its code, saying how they came. A join is idempotent by event and
 * player, so a retry after a lost answer is safe.
 */
export async function joinEvent(
  session: Pick<Session, "request">,
  join: PendingJoin,
): Promise<JoinOutcome> {
  return joinOutcome(
    await session.request({
      method: "POST",
      path: "/v1/join",
      body: { joinCode: join.code, via: join.via, cardVersion: join.cardVersion },
    }),
  );
}
