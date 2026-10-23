import type { Stamped } from "#src/event/passport.ts";
import type { Revealed } from "#src/event/reveal.ts";
import type { Bilingual } from "#src/i18n/text.ts";
import type { CompletionAnswer, QuestsView, Quest, Category } from "#src/event/quests-api.ts";
import type { Bonus } from "#src/event/quests-api.ts";
import type { LevelUp } from "#src/questify/level.ts";

/**
 * Where a scan stands (FR-406): scanning; checking (the "Scanned! Checking…" beat, shown within 300 ms of the read);
 * then the celebration, a passport's progress after a step's stamp (T-304b), a hidden category found (T-304c), a refusal in clear words, or a lost answer
 * that can be retried with the same key. While checking, `questId` is the id the code holds: a quest's, or a passport
 * step's; a payment names its quest.
 */
export type ScanStep =
  | Readonly<{ kind: "scanning" }>
  | Readonly<{ kind: "checking"; questId: string; token: string }>
  | Readonly<{ kind: "stamped"; done: number; needed: number; fresh: boolean }>
  /** A hidden category found by its secret code (T-304c); `fresh` is false when found before. */
  | Readonly<{ kind: "revealed"; name: Bilingual; fresh: boolean }>
  | Readonly<{
      kind: "celebrating";
      questId: string;
      points: number;
      replayed: boolean;
      /** The Questify level reached first: a medium celebration after the points (FR-407). */
      levelUp: LevelUp | null;
      /** The category bonus this scan paid (T-304), said with the points. */
      bonus: Bonus | null;
      /** Read after the completion: the quest's title, its category when this scan finished it, another event. */
      details: Details | undefined;
    }>
  | Readonly<{
      kind: "refused";
      answer: Exclude<CompletionAnswer, { kind: "completed" | "network" }>;
    }>
  | Readonly<{ kind: "lost"; questId: string; token: string }>;

export type Details = Readonly<{
  quest: Quest | undefined;
  /** The category this scan just finished: the full-screen celebration follows the quest's (FR-407). */
  finishedCategory: Category | undefined;
  /** The code belonged to another of the player's events: paid there, and said so. */
  otherEvent: boolean;
}>;

export type ScanEvent =
  | Readonly<{ type: "read"; questId: string; token: string }>
  | Readonly<{
      type: "answered";
      answer:
        | CompletionAnswer
        | Stamped
        | Revealed
        | (CompletionAnswer & Readonly<{ questId: string }>);
    }>
  | Readonly<{ type: "details"; details: Details }>
  | Readonly<{ type: "retry" }>
  | Readonly<{ type: "again" }>;

/** Moves a scan on; an event that does not fit the step changes nothing. */
export function scanStep(step: ScanStep, event: ScanEvent): ScanStep {
  switch (event.type) {
    case "read":
      return step.kind === "scanning"
        ? { kind: "checking", questId: event.questId, token: event.token }
        : step;
    case "answered":
      return step.kind === "checking" ? answered(step, event.answer) : step;
    case "details":
      return step.kind === "celebrating" ? { ...step, details: event.details } : step;
    case "retry":
      return step.kind === "lost"
        ? { kind: "checking", questId: step.questId, token: step.token }
        : step;
    case "again":
      return step.kind === "checking" ? step : { kind: "scanning" };
  }
}

function answered(
  step: Extract<ScanStep, { kind: "checking" }>,
  answer: Extract<ScanEvent, { type: "answered" }>["answer"],
): ScanStep {
  switch (answer.kind) {
    case "stamped":
      return { kind: "stamped", done: answer.done, needed: answer.needed, fresh: answer.fresh };
    case "revealed":
      return { kind: "revealed", name: answer.name, fresh: answer.fresh };
    case "completed":
      return {
        kind: "celebrating",
        questId: "questId" in answer ? answer.questId : step.questId,
        points: answer.points,
        replayed: answer.replayed,
        levelUp: answer.levelUp,
        bonus: answer.bonus,
        details: undefined,
      };
    case "network":
      return { kind: "lost", questId: step.questId, token: step.token };
    default:
      return { kind: "refused", answer };
  }
}

/**
 * What the celebration adds once the quests are read again: the quest (absent when the code was another event's), and
 * its category when this scan finished it. A replayed answer finishes nothing new.
 */
export function detailsAfter(
  view: QuestsView | undefined,
  questId: string,
  replayed: boolean,
): Details {
  const category = view?.categories.find((item) =>
    item.quests.some((quest) => quest.id === questId),
  );
  const quest = category?.quests.find((item) => item.id === questId);
  if (view === undefined) {
    return { quest: undefined, finishedCategory: undefined, otherEvent: false };
  }
  const finished =
    !replayed &&
    quest?.state === "done" &&
    category !== undefined &&
    category.quests.every((item) => item.state === "done");
  return {
    quest,
    finishedCategory: finished ? category : undefined,
    otherEvent: quest === undefined,
  };
}

export type Beat = "points" | "level" | "category";

/**
 * The beats of a celebration in order, growing with rarity (FR-407): the quest's small one, then a level-up's medium
 * one, then a finished category's full-screen one. A replay (a dropped answer retried) carries the first answer's
 * level-up, so a player who never saw it still does.
 */
export function celebrationBeats(
  step: Extract<ScanStep, { kind: "celebrating" }>,
): readonly Beat[] {
  return [
    "points",
    ...(step.levelUp === null ? [] : (["level"] as const)),
    ...(step.details?.finishedCategory === undefined ? [] : (["category"] as const)),
  ];
}
