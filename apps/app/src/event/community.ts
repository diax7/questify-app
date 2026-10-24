import type { MessageKey } from "@questify/shared";
import { isRecord, type PlayText } from "#src/event/plays.ts";

// ================================================================ the community goal (T-306b, FR-243 to FR-250)

export type CommunityReward = Readonly<{
  kind: "points" | "moment" | "nothing";
  points?: number;
  moment?: PlayText;
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
const KINDS = ["points", "moment", "nothing"] as const;
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

function rewardOf(value: unknown): CommunityReward | undefined {
  if (!isRecord(value) || !oneOf(KINDS, value["kind"])) {
    return undefined;
  }
  return {
    kind: value["kind"],
    ...(typeof value["points"] === "number" ? { points: value["points"] } : {}),
    ...(isRecord(value["moment"]) ? { moment: textOf(value["moment"]) } : {}),
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

/** A one-time card for this phone: a reached moment step, or a step that paid the player. */
export type CommunityNews = Readonly<{
  key: string;
  kind: "moment" | "paid";
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
    if (step.mine === "paid") {
      news.push({ key: `community:${card.goalId}:${step.threshold}:paid`, kind: "paid", step });
    }
  }
  return news.filter((item) => !shown.includes(item.key));
}
