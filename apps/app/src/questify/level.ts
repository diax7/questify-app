import { itemSchema, type Language, type MessageKey, type ProfileItem } from "@questify/shared";
import type { LocalizedText } from "@questify/shared";

/** The lifetime Questify level from `GET /v1/me` (T-401, FR-416, FR-706). */
export type QuestifyLevel = Readonly<{
  xp: number;
  level: number;
  levelFrom: number;
  /** Null at the top level: the bar is full. */
  nextLevelAt: number | null;
  title: LocalizedText;
  nextReward?: ProfileItem | null;
}>;

/** A level a completion reached for the first time: the medium celebration after the points (FR-407). */
export type LevelUp = Readonly<{
  level: number;
  title: LocalizedText;
  items?: readonly ProfileItem[];
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTitle = (value: unknown): value is LocalizedText =>
  isRecord(value) && typeof value["ar"] === "string" && typeof value["en"] === "string";

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/** The level in an answer, or undefined when it is missing or malformed (the profile then shows no bar). */
export function levelOf(value: unknown): QuestifyLevel | undefined {
  if (
    !isRecord(value) ||
    !isCount(value["xp"]) ||
    !isCount(value["level"]) ||
    !isCount(value["levelFrom"]) ||
    !(value["nextLevelAt"] === null || isCount(value["nextLevelAt"])) ||
    !isTitle(value["title"])
  ) {
    return undefined;
  }
  return {
    xp: value["xp"],
    level: value["level"],
    levelFrom: value["levelFrom"],
    nextLevelAt: value["nextLevelAt"],
    title: value["title"],
    ...(value["nextReward"] === undefined
      ? {}
      : { nextReward: itemSchema.safeParse(value["nextReward"]).data ?? null }),
  };
}

/** A completion's level-up, or null when it reached no new level (or the answer has none). */
export function levelUpOf(value: unknown): LevelUp | null {
  return isRecord(value) && isCount(value["level"]) && isTitle(value["title"])
    ? {
        level: value["level"],
        title: value["title"],
        ...(Array.isArray(value["items"])
          ? {
              items: value["items"].flatMap((item) => {
                const parsed = itemSchema.safeParse(item);
                return parsed.success ? [parsed.data] : [];
              }),
            }
          : {}),
      }
    : null;
}

/** How full the bar is, from 0 to 1: the share of the way from this level's start to the next. */
export function levelProgress(level: QuestifyLevel): number {
  if (level.nextLevelAt === null) {
    return 1;
  }
  const span = level.nextLevelAt - level.levelFrom;
  if (span <= 0) {
    return 1;
  }
  return Math.min(1, Math.max(0, (level.xp - level.levelFrom) / span));
}

/** Every item crossed by this completion is named, including multi-level jumps. */
export function levelUpMessage(
  t: (key: MessageKey, params?: Readonly<Record<string, string | number>>) => string,
  language: Language,
  value: LevelUp,
): string {
  const line = t("level.upLine", { level: value.level, title: value.title[language] });
  const names = value.items?.map((item) => item.name[language]) ?? [];
  return names.length === 0
    ? line
    : `${line}. ${t("locker.rewardLine", { items: names.join(language === "ar" ? "، " : ", ") })}`;
}
