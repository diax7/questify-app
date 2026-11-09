import type { AuthedResult, Session } from "#src/api/session.ts";
import type { Bilingual } from "#src/i18n/text.ts";

/** One line of the player's points record (FR-410), as `GET /v1/events/{id}/activity` gives it (T-115). */
export type ActivityEntry = Readonly<{
  id: string;
  at: string;
  /** `quest` today; spends, awards and removals arrive later (T-207), and an unknown kind still shows. */
  kind: string;
  scoreDelta: number;
  balanceDelta: number;
  /** The quest's title for a quest; for anything else only its type. */
  title: Bilingual | null;
  /** The boost that doubled it or its removal (T-307), shown as "×2"; null when none or from an older API. */
  multiplier: number | null;
  /** A first-N bonus line's N (T-313), "First-{slots} bonus"; null for any other line or an older API. */
  bonusSlots: number | null;
  /** A streak bonus line's streak day (T-405b), "Streak bonus, day {days}"; null for any other line or an older API. */
  streakDays: number | null;
}>;

export type ActivityPage = Readonly<{
  entries: readonly ActivityEntry[];
  nextCursor: string | null;
}>;

export type ActivityAnswer =
  | Readonly<{ kind: "page"; page: ActivityPage }>
  | Readonly<{ kind: "pending" }>
  | Readonly<{ kind: "gone" }>
  | Readonly<{ kind: "network" }>
  | Readonly<{ kind: "signed_out" }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isText = (value: unknown): value is Bilingual =>
  isRecord(value) &&
  (value["ar"] === null || typeof value["ar"] === "string") &&
  (value["en"] === null || typeof value["en"] === "string");

const numberOrNull = (value: unknown): number | null => (typeof value === "number" ? value : null);

type EntryCore = Pick<ActivityEntry, "id" | "at" | "kind" | "scoreDelta" | "balanceDelta">;

function readCore(value: Record<string, unknown>): EntryCore | undefined {
  const { id, at, kind, scoreDelta, balanceDelta } = value;
  return typeof id === "string" &&
    typeof at === "string" &&
    typeof kind === "string" &&
    typeof scoreDelta === "number" &&
    typeof balanceDelta === "number"
    ? { id, at, kind, scoreDelta, balanceDelta }
    : undefined;
}

const titleOf = (reason: Record<string, unknown>): Bilingual | null =>
  reason["type"] === "quest" && isText(reason["title"]) ? reason["title"] : null;

const multiplierOf = (value: unknown): number | null =>
  typeof value === "number" && value > 1 ? value : null;

function readEntry(value: unknown): ActivityEntry | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const core = readCore(value);
  const reason = value["reason"];
  if (core === undefined || !isRecord(reason)) {
    return undefined;
  }
  return {
    ...core,
    title: titleOf(reason),
    multiplier: multiplierOf(value["multiplier"]),
    bonusSlots: numberOrNull(value["bonusSlots"]),
    streakDays: numberOrNull(value["streakDays"]),
  };
}

/** Reads a page; one entry of another shape fails the page, so a changed API says "can't load". */
export function readActivity(body: unknown): ActivityPage | undefined {
  if (!isRecord(body) || !Array.isArray(body["entries"])) {
    return undefined;
  }
  const cursor = body["nextCursor"];
  if (cursor !== null && typeof cursor !== "string") {
    return undefined;
  }
  const entries = body["entries"].map(readEntry);
  return entries.every((entry) => entry !== undefined)
    ? { entries: entries as ActivityEntry[], nextCursor: cursor }
    : undefined;
}

/** As the Quests tab: pending waits, a definite 403 `not_enrolled` or 404 is gone, anything else is network. */
export function activityAnswer(answer: AuthedResult): ActivityAnswer {
  if (answer.kind === "signed_out" || answer.kind === "network") {
    return { kind: answer.kind };
  }
  if (answer.kind === "error") {
    if (answer.code === "membership_pending") {
      return { kind: "pending" };
    }
    return { kind: answer.status === 403 || answer.status === 404 ? "gone" : "network" };
  }
  const page = readActivity(answer.body);
  return page === undefined ? { kind: "network" } : { kind: "page", page };
}

export async function fetchActivity(
  session: Pick<Session, "request">,
  eventId: string,
  cursor: string | null,
): Promise<ActivityAnswer> {
  const query = cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`;
  return activityAnswer(
    await session.request({
      method: "GET",
      path: `/v1/events/${encodeURIComponent(eventId)}/activity${query}`,
    }),
  );
}
