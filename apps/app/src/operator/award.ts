import type { MessageKey } from "@questify/shared";
import type { Bilingual } from "#src/i18n/text.ts";

/** The most points one award may carry (the API's own bound; the event's cap is usually lower). */
const MAX_POINTS = 100_000;
const MAX_REASON = 300;

/** What `GET /v1/operator/events/{id}/award` answers: the caps in force, what is left today, the quests (FR-310). */
export type AwardForm = Readonly<{
  capEach: number;
  capDay: number;
  leftToday: number;
  live: boolean;
  quests: readonly Readonly<{ id: string; title: Bilingual; points: number }>[];
}>;

/** The one member a find returned (`POST …/find-player`); `active` is false for anyone who cannot get points now. */
export type FoundPlayer = Readonly<{
  enrollmentId: string;
  username: string;
  avatar: string;
  active: boolean;
}>;

/** The form as the operator fills it: a quest or an amount, and a reason. */
export type AwardDraft = Readonly<{
  mode: "quest" | "points";
  questId: string | null;
  points: string;
  reason: string;
}>;

export const EMPTY_DRAFT: AwardDraft = { mode: "points", questId: null, points: "", reason: "" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;

const textOf = (value: unknown): Bilingual => ({
  ar: isRecord(value) && typeof value["ar"] === "string" ? value["ar"] : null,
  en: isRecord(value) && typeof value["en"] === "string" ? value["en"] : null,
});

/** Reads the form; anything malformed reads as nothing, so the screen shows a load failure instead of a guess. */
export function awardFormOf(body: unknown): AwardForm | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  const capEach = count(body["capEach"]);
  const capDay = count(body["capDay"]);
  const leftToday = count(body["leftToday"]);
  if (capEach === undefined || capDay === undefined || leftToday === undefined) {
    return undefined;
  }
  const quests = Array.isArray(body["quests"]) ? body["quests"] : [];
  return {
    capEach,
    capDay,
    leftToday,
    live: body["live"] === true,
    quests: quests.flatMap((row: unknown) => {
      const points = isRecord(row) ? count(row["points"]) : undefined;
      return isRecord(row) && typeof row["id"] === "string" && points !== undefined
        ? [{ id: row["id"], title: textOf(row["title"]), points }]
        : [];
    }),
  };
}

/** Reads a find's answer: the member, `null` for no match, `undefined` for a malformed answer. */
export function foundPlayerOf(body: unknown): FoundPlayer | null | undefined {
  if (!isRecord(body) || !("player" in body)) {
    return undefined;
  }
  const player = body["player"];
  if (player === null) {
    return null;
  }
  return isRecord(player) &&
    typeof player["enrollmentId"] === "string" &&
    typeof player["username"] === "string"
    ? {
        enrollmentId: player["enrollmentId"],
        username: player["username"],
        avatar: typeof player["avatar"] === "string" ? player["avatar"] : "",
        active: player["active"] === true,
      }
    : undefined;
}

/** A typed amount: a whole number from 1 to 100000 in Western digits, else nothing. */
export function pointsOf(typed: string): number | undefined {
  const trimmed = typed.trim();
  if (!/^[0-9]{1,6}$/.test(trimmed)) {
    return undefined;
  }
  const value = Number(trimmed);
  return value >= 1 && value <= MAX_POINTS ? value : undefined;
}

export const reasonOk = (typed: string): boolean => {
  const length = typed.trim().length;
  return length >= 1 && length <= MAX_REASON;
};

/** How many points the draft would award: the quest's own points, or the typed amount. */
export function amountOf(draft: AwardDraft, form: AwardForm): number | undefined {
  if (draft.mode === "points") {
    return pointsOf(draft.points);
  }
  return form.quests.find((quest) => quest.id === draft.questId)?.points;
}

/** A line in the screen's words, with what fills its placeholders. */
export type Said = Readonly<{ key: MessageKey; params: Readonly<Record<string, string>> }>;

/** The cap an amount would cross (FR-310): the per-award cap first, then what is left today. */
export function capProblem(amount: number, form: AwardForm): Said | undefined {
  if (amount > form.capEach) {
    return { key: "awards.overEach", params: { limit: String(form.capEach) } };
  }
  if (amount > form.leftToday) {
    return { key: "awards.overDay", params: { left: String(form.leftToday) } };
  }
  return undefined;
}

/**
 * Award stays off until a member who can get points, a quest or amount inside the caps, and a reason are all filled in,
 * and only while the event is live (OPERATOR_MODE 3.5).
 */
export function canAward(player: FoundPlayer | null, draft: AwardDraft, form: AwardForm): boolean {
  const amount = amountOf(draft, form);
  return (
    form.live &&
    player !== null &&
    player.active &&
    amount !== undefined &&
    capProblem(amount, form) === undefined &&
    reasonOk(draft.reason)
  );
}

/** The award's body for `POST /v1/operator/award`: exactly one of a quest or an amount, and the trimmed reason. */
export function awardBody(
  eventId: string,
  player: FoundPlayer,
  draft: AwardDraft,
): Readonly<Record<string, string | number>> {
  const what =
    draft.mode === "quest" && draft.questId !== null
      ? { questId: draft.questId }
      : { points: pointsOf(draft.points) ?? 0 };
  return { eventId, enrollmentId: player.enrollmentId, ...what, reason: draft.reason.trim() };
}

/** After an award, the form shows less left today; the server's next form read is the truth. */
export const afterAward = (form: AwardForm, points: number): AwardForm => ({
  ...form,
  leftToday: Math.max(0, form.leftToday - points),
});

/**
 * A refusal in words: an over-cap answer names the cap and what is left (FR-310), too many finds says to wait; any
 * other refusal shows the API's own message (`undefined` here).
 */
export function refusalSaid(
  code: string,
  details: Readonly<Record<string, unknown>>,
): Said | undefined {
  if (code === "too_many_attempts") {
    return { key: "operator.award.tooMany", params: {} };
  }
  if (code !== "over_cap") {
    return undefined;
  }
  const limit = count(details["limit"]);
  const left = count(details["left"]);
  if (details["cap"] === "day") {
    return left === undefined
      ? undefined
      : { key: "awards.overDay", params: { left: String(left) } };
  }
  return limit === undefined
    ? undefined
    : { key: "awards.overEach", params: { limit: String(limit) } };
}
