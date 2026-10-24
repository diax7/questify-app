import { formatNumber, type Language, type MessageKey } from "@questify/shared";

type Translate = (key: MessageKey, params?: Readonly<Record<string, string | number>>) => string;

/** A quest's first-N bonus as the quests read sends it (T-313): `mine` once this player got it. */
export type QuestFirstBonus = Readonly<{
  points: number;
  slots: number;
  left: number;
  mine: Readonly<{ place: number }> | null;
}>;

/** The first-N bonus a completion earned, or missed when `place` is null ("all taken"). */
export type FirstBonusPaid = Readonly<{ points: number; place: number | null; slots: number }>;

/** What `/live` says is left of a bonus the player may still earn (ADR-263). */
export type LiveFirstBonus = Readonly<{ questId: string; left: number; slots: number }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/** The quests read's bonus, or null for none, anything not well formed, or an older API. */
export function questFirstBonusOf(value: unknown): QuestFirstBonus | null {
  if (
    !isRecord(value) ||
    !isCount(value["points"]) ||
    !isCount(value["slots"]) ||
    !isCount(value["left"])
  ) {
    return null;
  }
  const mine = value["mine"];
  return {
    points: value["points"],
    slots: value["slots"],
    left: value["left"],
    mine: isRecord(mine) && isCount(mine["place"]) ? { place: mine["place"] } : null,
  };
}

/** A completion answer's bonus, or null for none, anything not well formed, or an older API. */
export function firstBonusPaidOf(value: unknown): FirstBonusPaid | null {
  return isRecord(value) &&
    isCount(value["points"]) &&
    isCount(value["slots"]) &&
    (value["place"] === null || isCount(value["place"]))
    ? { points: value["points"], place: value["place"], slots: value["slots"] }
    : null;
}

/** The live answer's bonuses; none from an older API or for anything not well formed. */
export function liveFirstBonusOf(value: unknown): readonly LiveFirstBonus[] {
  return Array.isArray(value)
    ? value
        .filter(
          (item): item is LiveFirstBonus =>
            isRecord(item) &&
            typeof item["questId"] === "string" &&
            isCount(item["left"]) &&
            isCount(item["slots"]),
        )
        .map((item) => ({ questId: item.questId, left: item.left, slots: item.slots }))
    : [];
}

/**
 * The bonus with what `/live` last said is left (CTO MAJOR 3): the ribbon follows the live read, never a re-read of
 * the quests. A quest `/live` does not name keeps the quests read's own count.
 */
export function withLiveLeft(
  bonus: QuestFirstBonus | null,
  questId: string,
  live: readonly LiveFirstBonus[],
): QuestFirstBonus | null {
  const found = live.find((item) => item.questId === questId);
  return bonus === null || found === undefined || bonus.mine !== null
    ? bonus
    : { ...bonus, left: found.left, slots: found.slots };
}

/** The gold ribbon's two lines: "First 50" and "+25 · 12 left", "All taken" or "You got bonus #3". */
export function ribbonLines(
  bonus: QuestFirstBonus,
  t: Translate,
  language: Language,
): Readonly<{ title: string; detail: string }> {
  const title = t("quest.firstBonus.ribbon", { slots: formatNumber(bonus.slots, language) });
  if (bonus.mine !== null) {
    return {
      title,
      detail: t("quest.firstBonus.mine", { place: formatNumber(bonus.mine.place, language) }),
    };
  }
  return {
    title,
    detail:
      bonus.left === 0
        ? t("quest.firstBonus.gone")
        : t("quest.firstBonus.left", {
            points: formatNumber(bonus.points, language),
            left: formatNumber(bonus.left, language),
          }),
  };
}

/** The success card's line: "First 50 bonus! +25", or "The first-50 bonus is all taken". */
export function firstBonusLine(t: Translate, language: Language, paid: FirstBonusPaid): string {
  const slots = formatNumber(paid.slots, language);
  return paid.place === null
    ? t("play.firstBonus.missed", { slots })
    : t("play.firstBonus.won", { slots, points: formatNumber(paid.points, language) });
}
