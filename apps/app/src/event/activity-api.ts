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

function readEntry(value: unknown): ActivityEntry | undefined {
  if (
    !isRecord(value) ||
    typeof value["id"] !== "string" ||
    typeof value["at"] !== "string" ||
    typeof value["kind"] !== "string" ||
    typeof value["scoreDelta"] !== "number" ||
    typeof value["balanceDelta"] !== "number" ||
    !isRecord(value["reason"])
  ) {
    return undefined;
  }
  const reason = value["reason"];
  return {
    id: value["id"],
    at: value["at"],
    kind: value["kind"],
    scoreDelta: value["scoreDelta"],
    balanceDelta: value["balanceDelta"],
    title: reason["type"] === "quest" && isText(reason["title"]) ? reason["title"] : null,
    multiplier:
      typeof value["multiplier"] === "number" && value["multiplier"] > 1
        ? value["multiplier"]
        : null,
    bonusSlots: typeof value["bonusSlots"] === "number" ? value["bonusSlots"] : null,
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
