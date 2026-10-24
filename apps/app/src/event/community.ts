import { formatNumber, type Language, type MessageKey } from "@questify/shared";
import { isRecord, type PlayText } from "#src/event/plays.ts";
import { textIn } from "#src/i18n/text.ts";

type Translate = (key: MessageKey, params?: Readonly<Record<string, string | number>>) => string;

// ================================================================ the community goal (T-306b, FR-243 to FR-250)

/** What an unlock step opens, sent only when the player sees it (T-306c); without it the step is "a surprise". */
export type UnlockTarget = Readonly<{ kind: string; id: string; name: PlayText }>;

/** A step's reward. A kind this build does not know (F-282) keeps its step on the bar, with no words. */
export type CommunityReward = Readonly<{
  kind: "points" | "moment" | "nothing" | "unlock" | (string & {});
  points?: number;
  moment?: PlayText;
  target?: UnlockTarget;
}>;

export type CommunityStep = Readonly<{
  threshold: number;
  isGoal: boolean;
  reward: CommunityReward;
  reachedAt: string | null;
  /** The player's own payout for this step, when it pays them. */
  mine: "due" | "paid" | "skipped" | null;
}>;

/** The goal `GET /v1/events/{id}/live` shows: running now, or finished in the last 30 minutes. */
export type CommunityCard = Readonly<{
  goalId: string;
  title: PlayText;
  measure: "points" | "completions" | "players";
  target: number;
  progress: number;
  status: "running" | "reached" | "missed";
  /** Whom its points steps pay: those who took part, or every player. */
  paidTo: "contributors" | "everyone";
  endsAt: string;
  steps: readonly CommunityStep[];
  contributed: boolean;
}>;

const MEASURES = ["points", "completions", "players"] as const;
const STATUSES = ["running", "reached", "missed"] as const;
const MINE = ["due", "paid", "skipped"] as const;

const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (list as readonly string[]).includes(value);

const textOf = (value: unknown): PlayText => {
  const both = isRecord(value) ? value : {};
  return {
    ar: typeof both["ar"] === "string" ? both["ar"] : null,
    en: typeof both["en"] === "string" ? both["en"] : null,
  };
};

function targetOf(value: unknown): UnlockTarget | undefined {
  return isRecord(value) && typeof value["kind"] === "string" && typeof value["id"] === "string"
    ? { kind: value["kind"], id: value["id"], name: textOf(value["name"]) }
    : undefined;
}

function rewardOf(value: unknown): CommunityReward | undefined {
  if (!isRecord(value) || typeof value["kind"] !== "string") {
    return undefined;
  }
  const target = targetOf(value["target"]);
  return {
    kind: value["kind"],
    ...(typeof value["points"] === "number" ? { points: value["points"] } : {}),
    ...(isRecord(value["moment"]) ? { moment: textOf(value["moment"]) } : {}),
    ...(target === undefined ? {} : { target }),
  };
}

function stepOf(value: unknown): CommunityStep | undefined {
  if (!isRecord(value) || typeof value["threshold"] !== "number") {
    return undefined;
  }
  const reward = rewardOf(value["reward"]);
  if (reward === undefined) {
    return undefined;
  }
  return {
    threshold: value["threshold"],
    isGoal: value["isGoal"] === true,
    reward,
    reachedAt: typeof value["reachedAt"] === "string" ? value["reachedAt"] : null,
    mine: oneOf(MINE, value["mine"]) ? value["mine"] : null,
  };
}

/** The live answer's `community`, or null when it is absent or not readable. */
export function communityOf(value: unknown): CommunityCard | null {
  if (
    !isRecord(value) ||
    typeof value["goalId"] !== "string" ||
    !oneOf(MEASURES, value["measure"]) ||
    !oneOf(STATUSES, value["status"]) ||
    typeof value["target"] !== "number" ||
    typeof value["progress"] !== "number" ||
    typeof value["endsAt"] !== "string" ||
    !Array.isArray(value["steps"])
  ) {
    return null;
  }
  const steps = value["steps"].map(stepOf);
  if (steps.some((step) => step === undefined)) {
    return null;
  }
  return {
    goalId: value["goalId"],
    title: textOf(value["title"]),
    measure: value["measure"],
    target: value["target"],
    progress: value["progress"],
    status: value["status"],
    paidTo: value["paidTo"] === "everyone" ? "everyone" : "contributors",
    endsAt: value["endsAt"],
    steps: steps.filter((step): step is CommunityStep => step !== undefined),
    contributed: value["contributed"] === true,
  };
}

/** How full the bar is, from 0 to 1 (progress can pass the target). */
export const fillOf = (card: Pick<CommunityCard, "progress" | "target">): number =>
  card.target <= 0 ? 0 : Math.min(1, Math.max(0, card.progress / card.target));

/** Where a step's marker sits on the bar, from 0 to 1. */
export const markerOf = (step: Pick<CommunityStep, "threshold">, target: number): number =>
  target <= 0 ? 0 : Math.min(1, step.threshold / target);

/** The line under the bar: the time left, "Counting the last points…" past the end, or how it finished. */
export type CommunityLine =
  | Readonly<{ kind: "ends_in"; seconds: number }>
  | Readonly<{ kind: "counting" }>
  | Readonly<{ kind: "reached" }>
  | Readonly<{ kind: "missed" }>;

export function lineOf(card: Pick<CommunityCard, "status" | "endsAt">, now: number): CommunityLine {
  if (card.status === "reached") {
    return { kind: "reached" };
  }
  if (card.status === "missed") {
    return { kind: "missed" };
  }
  const left = (Date.parse(card.endsAt) - now) / 1000;
  return left > 0 ? { kind: "ends_in", seconds: left } : { kind: "counting" };
}

export const MEASURE_KEYS: Readonly<Record<CommunityCard["measure"], MessageKey>> = {
  points: "community.measure.points",
  completions: "community.measure.completions",
  players: "community.measure.players",
};

/**
 * What a step gives, in the player's words; null for a reward kind this build does not know (F-282), whose marker
 * stays on the bar without words. An unlock names its target only when the server sent it (the player sees it).
 */
export function rewardText(
  step: CommunityStep,
  everyone: boolean,
  t: Translate,
  language: Language,
): string | null {
  switch (step.reward.kind) {
    case "points": {
      const points = formatNumber(step.reward.points ?? 0, language);
      return t(everyone ? "community.forEveryone" : "community.forContributors", { points });
    }
    case "moment":
      return step.reward.moment === undefined
        ? t("community.nothing")
        : textIn(step.reward.moment, language);
    case "nothing":
      return t("community.nothing");
    case "unlock":
      return step.reward.target === undefined
        ? t("community.reward.surprise")
        : t("community.reward.unlock", { name: textIn(step.reward.target.name, language) });
    default:
      return null;
  }
}

/** A one-time card for this phone: a reached moment step, a reached unlock (T-306c), or a step that paid the player. */
export type CommunityNews = Readonly<{
  key: string;
  kind: "moment" | "unlocked" | "paid";
  step: CommunityStep;
}>;

/** The cards this goal owes the player and this phone has not shown, in step order. */
export function communityNews(
  card: CommunityCard | null,
  shown: readonly string[],
): readonly CommunityNews[] {
  if (card === null) {
    return [];
  }
  const news: CommunityNews[] = [];
  for (const step of card.steps) {
    if (step.reward.kind === "moment" && step.reachedAt !== null) {
      news.push({ key: `community:${card.goalId}:${step.threshold}:moment`, kind: "moment", step });
    }
    if (step.reward.kind === "unlock" && step.reachedAt !== null) {
      news.push({
        key: `community:${card.goalId}:${step.threshold}:unlocked`,
        kind: "unlocked",
        step,
      });
    }
    if (step.mine === "paid") {
      news.push({ key: `community:${card.goalId}:${step.threshold}:paid`, kind: "paid", step });
    }
  }
  return news.filter((item) => !shown.includes(item.key));
}

/** The unlock steps reached on this card, by goal and threshold. */
export function reachedUnlocks(card: CommunityCard | null): readonly string[] {
  return card === null
    ? []
    : card.steps
        .filter((step) => step.reward.kind === "unlock" && step.reachedAt !== null)
        .map((step) => `${card.goalId}:${step.threshold}`);
}

/**
 * Whether the live read just reached an unlock this phone had seen waiting (T-306c): the quests and shop it shows are
 * then out of date and read again. The first read of the event (`before` undefined) has nothing older to replace.
 */
export function unlockedSince(
  before: readonly string[] | undefined,
  card: CommunityCard | null,
): boolean {
  return before !== undefined && reachedUnlocks(card).some((key) => !before.includes(key));
}
