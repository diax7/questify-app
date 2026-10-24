import { formatEventTime, type Language, type MessageKey } from "@questify/shared";
import type { Quest, RunningBoost } from "#src/event/quests-api.ts";
import type { Bilingual } from "#src/i18n/text.ts";

type Translate = (key: MessageKey, params?: Readonly<Record<string, string | number>>) => string;

/**
 * A flash quest's line on its card (T-307, FR-251): "Ends {time}" in the event's zone. Null for any other quest. The
 * server lists a flash quest only inside its window, so what shows is always running.
 */
export function flashLine(
  quest: Pick<Quest, "flash">,
  t: Translate,
  language: Language,
  timeZone: string,
): string | null {
  return quest.flash === null
    ? null
    : t("quests.flash.endsAt", {
        time: formatEventTime(new Date(quest.flash.closesAt), timeZone, language),
      });
}

/** A boost's line (T-307, FR-252): "Double points until {time}" in the event's zone; null with no boost. */
export function boostLine(
  boost: RunningBoost | null,
  t: Translate,
  language: Language,
  timeZone: string,
): string | null {
  return boost === null
    ? null
    : t("quests.boost.until", {
        time: formatEventTime(new Date(boost.endsAt), timeZone, language),
      });
}

/** A flash quest open now, as `/live` names it (T-307): a one-time card. */
export type LiveFlash = Readonly<{ questId: string; title: Bilingual; closesAt: string }>;

/** A boost running on a category the player sees, as `/live` names it (T-307): a one-time card. */
export type LiveBoost = Readonly<{
  boostId: string;
  categoryId: string;
  category: Bilingual;
  multiplier: number;
  endsAt: string;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isText = (value: unknown): value is Bilingual =>
  isRecord(value) &&
  (value["ar"] === null || typeof value["ar"] === "string") &&
  (value["en"] === null || typeof value["en"] === "string");

/** The flash quests in a live answer; none from an older API or for anything not well formed. */
export function liveFlashOf(value: unknown): readonly LiveFlash[] {
  return Array.isArray(value)
    ? value
        .filter(
          (item): item is LiveFlash =>
            isRecord(item) &&
            typeof item["questId"] === "string" &&
            isText(item["title"]) &&
            typeof item["closesAt"] === "string",
        )
        .map((item) => ({ questId: item.questId, title: item.title, closesAt: item.closesAt }))
    : [];
}

/** The boosts in a live answer; none from an older API or for anything not well formed. */
export function liveBoostsOf(value: unknown): readonly LiveBoost[] {
  return Array.isArray(value)
    ? value
        .filter(
          (item): item is LiveBoost =>
            isRecord(item) &&
            typeof item["boostId"] === "string" &&
            typeof item["categoryId"] === "string" &&
            isText(item["category"]) &&
            typeof item["multiplier"] === "number" &&
            typeof item["endsAt"] === "string",
        )
        .map((item) => ({
          boostId: item.boostId,
          categoryId: item.categoryId,
          category: item.category,
          multiplier: item.multiplier,
          endsAt: item.endsAt,
        }))
    : [];
}

/** The key a card is remembered by on the phone, beside the poll results' (one-time each). */
export const flashKey = (questId: string): string => `flash:${questId}`;
export const boostKey = (boostId: string): string => `boost:${boostId}`;

/**
 * The next one-time flash or boost card not yet shown on this phone (T-307), flash quests first. `/live` stops naming a
 * boost or flash quest 15 minutes after it starts (CTO 8): that only ends its card; the quest list keeps its badge.
 */
export function nextDrop(
  live: Readonly<{ flash: readonly LiveFlash[]; boosts: readonly LiveBoost[] }>,
  shown: readonly string[],
):
  | Readonly<{ kind: "flash"; key: string; flash: LiveFlash }>
  | Readonly<{ kind: "boost"; key: string; boost: LiveBoost }>
  | undefined {
  const flash = live.flash.find((item) => !shown.includes(flashKey(item.questId)));
  if (flash !== undefined) {
    return { kind: "flash", key: flashKey(flash.questId), flash };
  }
  const boost = live.boosts.find((item) => !shown.includes(boostKey(item.boostId)));
  return boost === undefined ? undefined : { kind: "boost", key: boostKey(boost.boostId), boost };
}
