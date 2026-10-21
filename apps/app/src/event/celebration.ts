import type { CompletionAnswer, QuestsView, Quest, Category } from "#src/event/quests-api.ts";

/**
 * Where a scan stands (FR-406): scanning; checking (the "Scanned! Checking…" beat, shown within 300 ms of the read);
 * then the celebration, a refusal in clear words, or a lost answer that can be retried with the same key.
 */
export type ScanStep =
  | Readonly<{ kind: "scanning" }>
  | Readonly<{ kind: "checking"; questId: string; token: string }>
  | Readonly<{
      kind: "celebrating";
      questId: string;
      points: number;
      replayed: boolean;
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
  | Readonly<{ type: "answered"; answer: CompletionAnswer }>
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
  answer: CompletionAnswer,
): ScanStep {
  switch (answer.kind) {
    case "completed":
      return {
        kind: "celebrating",
        questId: step.questId,
        points: answer.points,
        replayed: answer.replayed,
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
