import {
  DEFAULT_TERMS,
  type EventTerms,
  type Language,
  type MessageKey,
  type StreakBonus,
} from "@questify/shared";
import type { TextLine } from "#src/components/text-lines.ts";
import { bonusLine, headlineText, itemLine } from "#src/event/amount.ts";
import { celebrationBeats, type Beat, type ScanStep } from "#src/event/celebration.ts";
import { firstBonusLine, type FirstBonusPaid } from "#src/event/first-bonus.ts";
import type { Category } from "#src/event/quests-api.ts";
import { textIn } from "#src/i18n/text.ts";
import type { LevelUp } from "#src/questify/level.ts";

type Translate = (key: MessageKey, params?: Readonly<Record<string, string | number>>) => string;
type Celebrating = Extract<ScanStep, { kind: "celebrating" }>;

/** The beat on screen with the data it needs; a beat whose data is missing falls back to the points. */
export type BeatView =
  | Readonly<{ kind: "points" }>
  | Readonly<{ kind: "category"; category: Category }>
  | Readonly<{ kind: "firstBonus"; bonus: FirstBonusPaid }>
  | Readonly<{ kind: "streak"; bonus: StreakBonus }>
  | Readonly<{ kind: "level"; levelUp: LevelUp }>;

const POINTS: BeatView = { kind: "points" };

/** Each beat's view when the data it needs is there, else null. */
const VIEWS: Readonly<Record<Beat, (step: Celebrating) => BeatView | null>> = {
  points: () => POINTS,
  category: (step) => {
    const category = step.details?.finishedCategory;
    return category === undefined ? null : { kind: "category", category };
  },
  firstBonus: (step) =>
    step.firstBonus === null ? null : { kind: "firstBonus", bonus: step.firstBonus },
  streak: (step) =>
    step.streakBonus === null ? null : { kind: "streak", bonus: step.streakBonus },
  level: (step) => (step.levelUp === null ? null : { kind: "level", levelUp: step.levelUp }),
};

/** The beat number `shown` of this celebration, or the points when that beat's data is not there (yet). */
export function beatViewOf(step: Celebrating, shown: number): BeatView {
  const beat = celebrationBeats(step)[shown] ?? "points";
  return VIEWS[beat](step) ?? POINTS;
}

/** Whether Claim moves on to another beat (else it closes the celebration). */
export const hasNextBeat = (step: Celebrating, shown: number): boolean =>
  shown + 1 < celebrationBeats(step).length;

const title = (key: string, text: string): TextLine => ({
  key,
  text,
  props: { variant: "title" },
});

/** The points beat's headline, "Double points!" and who the player met. */
function headLines(
  t: Translate,
  terms: EventTerms,
  language: Language,
  step: Celebrating,
): TextLine[] {
  // Paid in another event: its words are unknown here, so Questify's own name the amount.
  const words = step.details?.otherEvent ? DEFAULT_TERMS : terms;
  const lines: TextLine[] = [
    {
      key: "headline",
      text: headlineText(t, words, language, step),
      props: { variant: "display" },
    },
  ];
  if (step.boosted) {
    lines.push(title("boosted", t("completion.boosted")));
  }
  if (step.met !== null) {
    lines.push(title("met", t("meet.youMet", { name: step.met })));
  }
  return lines;
}

/** What else the scan paid: its item, its category bonus, and a first-N bonus that was missed. */
function paidLines(t: Translate, language: Language, step: Celebrating): TextLine[] {
  const lines: TextLine[] = [];
  if (step.item !== null) {
    lines.push(title("item", itemLine(t, language, step.item)));
  }
  if (step.bonus !== null) {
    lines.push(title("bonus", bonusLine(t, language, step.bonus)));
  }
  if (step.firstBonus !== null && step.firstBonus.place === null) {
    lines.push({
      key: "firstBonusMissed",
      text: firstBonusLine(t, language, step.firstBonus),
      props: {},
    });
  }
  return lines;
}

/** What the quests read after the scan adds: the quest's title, and that the code was another event's. */
function detailLines(t: Translate, language: Language, step: Celebrating): TextLine[] {
  const lines: TextLine[] = [];
  const quest = step.details?.quest;
  if (quest !== undefined) {
    lines.push(title("quest", textIn(quest.title, language)));
  }
  if (step.details?.otherEvent) {
    lines.push({ key: "otherEvent", text: t("scanner.otherEvent"), props: {} });
  }
  return lines;
}

/** The lines of the points beat, in the order they are shown. */
export function pointsLines(
  t: Translate,
  terms: EventTerms,
  language: Language,
  step: Celebrating,
): TextLine[] {
  return [
    ...headLines(t, terms, language, step),
    ...paidLines(t, language, step),
    ...detailLines(t, language, step),
  ];
}
