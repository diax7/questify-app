import type { AuthedResult, Session } from "#src/api/session.ts";
import { lockNoteOf, type CommunityLock } from "#src/event/unlock.ts";

type Text = Readonly<{ ar: string | null; en: string | null }>;

/** The pinned reward or the next one in reach (FR-803, T-213); `left` 0 means it can be redeemed now. */
export type Goal = Readonly<{
  rewardId: string;
  name: Text;
  price: number;
  left: number;
  pinned: boolean;
  soldOut: boolean;
  /** A pinned reward a community goal still locks (T-306c): the card names the goal instead of what is left. */
  communityLock: CommunityLock | null;
}>;

/** The player's revealed rank prize while it waits at the desk (FR-1718, T-214). */
export type Win = Readonly<{
  rank: number;
  prize: Readonly<{ kind: string; name: Text }>;
  redemptionId: string;
  claimUntil: string | null;
}>;

/** `GET /v1/events/{id}/home` (T-113, API.md). */
export type Home = Readonly<{
  event: Readonly<{
    id: string;
    name: Text;
    venue: Text;
    startsAt: string | null;
    endsAt: string | null;
    timezone: string;
    statusNow: string;
    /** A rehearsal account (T-211): the strip shows, and the event goes when rehearsal ends. */
    rehearsal: boolean;
    /** An in-person event with a venue pin (T-303b): location may be explained once after joining. */
    locationPrompt: boolean;
  }>;
  standing:
    | Readonly<{
        status: "active";
        score: number;
        balance: number;
        /** Points waiting on the team's review (FR-409); 0 from a server before T-301. */
        pendingPoints: number;
        questsDone: number;
        questsTotal: number;
      }>
    /** Waiting for the organizer (FR-1819), or on a full event's waiting list (FR-1821). */
    | Readonly<{ status: "pending"; waitlisted: boolean }>
    /** The organizer declined the request (ADR-167). */
    | Readonly<{ status: "declined" }>;
  upNext: Readonly<{ questId: string; title: Text; points: number; type: string }> | null;
  goal: Goal | null;
  win: Win | null;
  rankingOn: boolean;
}>;

/**
 * What Home shows for an answer. `gone` is the server's definite word that this is no longer the player's event (403
 * or 404): the phone forgets it. A network failure or anything unreadable is `network`: retry, and forget nothing.
 */
export type HomeAnswer =
  | Readonly<{ kind: "home"; home: Home }>
  | Readonly<{ kind: "gone" }>
  | Readonly<{ kind: "network" }>
  | Readonly<{ kind: "signed_out" }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isText = (value: unknown): value is Text =>
  isRecord(value) &&
  (value["ar"] === null || typeof value["ar"] === "string") &&
  (value["en"] === null || typeof value["en"] === "string");

const isTime = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

function readStanding(value: unknown): Home["standing"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value["status"] === "pending") {
    return { status: "pending", waitlisted: value["waitlisted"] === true };
  }
  if (value["status"] === "declined") {
    return { status: "declined" };
  }
  const numbers = ["score", "balance", "questsDone", "questsTotal"] as const;
  if (value["status"] !== "active" || !numbers.every((key) => typeof value[key] === "number")) {
    return undefined;
  }
  const pending = value["pendingPoints"];
  return {
    status: "active",
    score: value["score"] as number,
    balance: value["balance"] as number,
    pendingPoints: typeof pending === "number" && pending > 0 ? pending : 0,
    questsDone: value["questsDone"] as number,
    questsTotal: value["questsTotal"] as number,
  };
}

function readUpNext(value: unknown): Home["upNext"] | undefined {
  if (value === null) {
    return null;
  }
  return isRecord(value) &&
    typeof value["questId"] === "string" &&
    isText(value["title"]) &&
    typeof value["points"] === "number" &&
    typeof value["type"] === "string"
    ? (value as Home["upNext"])
    : undefined;
}

/** The goal, or null: an older API sends none, and a goal this app cannot read is left out rather than break Home. */
function readGoal(value: unknown): Goal | null {
  return isRecord(value) &&
    typeof value["rewardId"] === "string" &&
    isText(value["name"]) &&
    typeof value["price"] === "number" &&
    typeof value["left"] === "number" &&
    typeof value["pinned"] === "boolean" &&
    typeof value["soldOut"] === "boolean"
    ? {
        rewardId: value["rewardId"],
        name: value["name"],
        price: value["price"],
        left: value["left"],
        pinned: value["pinned"],
        soldOut: value["soldOut"],
        communityLock: lockNoteOf(value["communityLock"]),
      }
    : null;
}

/** The win, or null: an older API sends none, and one this app cannot read is left out. */
export function readWin(value: unknown): Win | null {
  return isRecord(value) &&
    typeof value["rank"] === "number" &&
    typeof value["redemptionId"] === "string" &&
    isTime(value["claimUntil"]) &&
    isRecord(value["prize"]) &&
    typeof value["prize"]["kind"] === "string" &&
    isText(value["prize"]["name"])
    ? (value as Win)
    : null;
}

/** Checks Home's shape, so a changed API shows "can't load" instead of a broken screen. */
export function readHome(body: unknown): Home | undefined {
  if (!isRecord(body) || !isRecord(body["event"])) {
    return undefined;
  }
  const event = body["event"];
  const standing = readStanding(body["standing"]);
  const upNext = readUpNext(body["upNext"]);
  if (
    typeof event["id"] !== "string" ||
    !isText(event["name"]) ||
    !isText(event["venue"]) ||
    !isTime(event["startsAt"]) ||
    !isTime(event["endsAt"]) ||
    typeof event["timezone"] !== "string" ||
    typeof event["statusNow"] !== "string" ||
    !(event["rehearsal"] === undefined || typeof event["rehearsal"] === "boolean") ||
    standing === undefined ||
    upNext === undefined ||
    typeof body["rankingOn"] !== "boolean"
  ) {
    return undefined;
  }
  // An older API sends no rehearsal flag: an ordinary member.
  // An older API sends neither flag: an ordinary member, and no location prompt.
  const read = {
    ...(event as Home["event"]),
    rehearsal: event["rehearsal"] === true,
    locationPrompt: event["locationPrompt"] === true,
  };
  return {
    event: read,
    standing,
    upNext,
    goal: readGoal(body["goal"]),
    win: readWin(body["win"]),
    rankingOn: body["rankingOn"],
  };
}

export function homeAnswer(answer: AuthedResult): HomeAnswer {
  if (answer.kind === "signed_out" || answer.kind === "network") {
    return { kind: answer.kind };
  }
  if (answer.kind === "error") {
    return { kind: answer.status === 403 || answer.status === 404 ? "gone" : "network" };
  }
  const home = readHome(answer.body);
  return home === undefined ? { kind: "network" } : { kind: "home", home };
}

export async function fetchHome(
  session: Pick<Session, "request">,
  eventId: string,
): Promise<HomeAnswer> {
  return homeAnswer(
    await session.request({
      method: "GET",
      path: `/v1/events/${encodeURIComponent(eventId)}/home`,
    }),
  );
}

/** A ranking row: public profile details only (FR-604); `avatar` may be one this app does not know (F-282). */
export type RankRow = Readonly<{
  rank: number;
  username: string;
  avatar: string;
  score: number;
  isMe: boolean;
}>;

/**
 * `GET /v1/events/{id}/ranking` (T-106): the top rows and the player's own place. `today` says the event has a today's
 * ranking now (T-216); an older API without it has none.
 */
export type Ranking = Readonly<{
  rows: readonly RankRow[];
  me: Readonly<{ rank: number; username: string; avatar: string; score: number }> | null;
  total: number;
  today: boolean;
}>;

/** The whole event's ranking, or today's points only (FR-610). */
export type RankingScope = "event" | "today";

/**
 * `off` hides the ranking (404 `ranking_off`); any other 403 or 404 is `gone`, the server's word that this is no longer
 * the player's event; anything else that fails is `network`.
 */
export type RankingAnswer =
  | Readonly<{ kind: "ranking"; ranking: Ranking }>
  | Readonly<{ kind: "off" }>
  | Readonly<{ kind: "today_off" }>
  | Readonly<{ kind: "gone" }>
  | Readonly<{ kind: "network" }>
  | Readonly<{ kind: "signed_out" }>;

const isRow = (value: unknown): value is RankRow =>
  isRecord(value) &&
  typeof value["rank"] === "number" &&
  typeof value["username"] === "string" &&
  typeof value["avatar"] === "string" &&
  typeof value["score"] === "number" &&
  typeof value["isMe"] === "boolean";

export function readRanking(body: unknown): Ranking | undefined {
  if (!isRecord(body) || !Array.isArray(body["rows"]) || typeof body["total"] !== "number") {
    return undefined;
  }
  const me = body["me"];
  const meOk =
    me === null ||
    (isRecord(me) &&
      typeof me["rank"] === "number" &&
      typeof me["username"] === "string" &&
      typeof me["avatar"] === "string" &&
      typeof me["score"] === "number");
  if (!meOk || !body["rows"].every(isRow)) {
    return undefined;
  }
  return {
    rows: body["rows"],
    me: me as Ranking["me"],
    total: body["total"],
    today: body["today"] === true,
  };
}

export function rankingAnswer(answer: AuthedResult): RankingAnswer {
  if (answer.kind === "signed_out" || answer.kind === "network") {
    return { kind: answer.kind };
  }
  if (answer.kind === "error") {
    // The same status means two things here: the ranking switched off, or not this player's event.
    if (answer.code === "ranking_off") {
      return { kind: "off" };
    }
    if (answer.code === "today_ranking_off") {
      return { kind: "today_off" };
    }
    return { kind: answer.status === 403 || answer.status === 404 ? "gone" : "network" };
  }
  const ranking = readRanking(answer.body);
  return ranking === undefined ? { kind: "network" } : { kind: "ranking", ranking };
}

export async function fetchRanking(
  session: Pick<Session, "request">,
  eventId: string,
  scope: RankingScope = "event",
): Promise<RankingAnswer> {
  const query = scope === "today" ? "?scope=today" : "";
  return rankingAnswer(
    await session.request({
      method: "GET",
      path: `/v1/events/${encodeURIComponent(eventId)}/ranking${query}`,
    }),
  );
}
