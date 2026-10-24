import { toInstant, toLocalInput, type MessageKey } from "@questify/shared";

// ================================================================ community goals on the dashboard (T-306b)

export type Bilingual = Readonly<{ ar: string | null; en: string | null }>;
export type Measure = "points" | "completions" | "players";
export type RewardKind = "points" | "moment" | "nothing";

export type GoalStep = Readonly<{
  threshold: number;
  isGoal: boolean;
  reward: Readonly<{ kind: RewardKind; points: number | null; moment: Bilingual | null }>;
  reachedAt: string | null;
  due: number;
  paid: number;
  skipped: number;
}>;

/** A goal as `GET …/community-goals` answers it. */
export type Goal = Readonly<{
  id: string;
  title: Bilingual;
  measure: Measure;
  questId: string | null;
  categoryId: string | null;
  target: number;
  startsAt: string;
  endsAt: string;
  closesAt: string;
  paidTo: "contributors" | "everyone";
  status: "scheduled" | "running" | "reached" | "missed";
  progress: number;
  finalAt: string | null;
  started: boolean;
  steps: readonly GoalStep[];
}>;

export const STATUS_KEYS: Readonly<Record<Goal["status"], MessageKey>> = {
  scheduled: "community.page.status.scheduled",
  running: "community.page.status.running",
  reached: "community.page.status.reached",
  missed: "community.page.status.missed",
};

export const MEASURE_KEYS: Readonly<Record<Measure, MessageKey>> = {
  points: "community.measure.points",
  completions: "community.measure.completions",
  players: "community.measure.players",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** The goals of an answer, or undefined when it is not one. */
export function goalsOf(body: unknown): readonly Goal[] | undefined {
  if (!isRecord(body) || !Array.isArray(body["goals"])) {
    return undefined;
  }
  return body["goals"] as Goal[];
}

/** One milestone or the goal's reward on the form, every field as typed. */
export type RewardDraft = { kind: RewardKind; points: string; momentAr: string; momentEn: string };
export type MilestoneDraft = RewardDraft & { threshold: string };

/** The form's fields, as typed; times in the event's zone (`datetime-local`). */
export type GoalDraft = {
  id: string | null;
  started: boolean;
  titleAr: string;
  titleEn: string;
  measure: Measure;
  scope: "all" | "quest" | "category";
  questId: string;
  categoryId: string;
  target: string;
  startsAt: string;
  endsAt: string;
  paidTo: "contributors" | "everyone";
  reward: RewardDraft;
  milestones: MilestoneDraft[];
};

export const MAX_MILESTONES = 5;

export const blankReward = (): RewardDraft => ({
  kind: "points",
  points: "",
  momentAr: "",
  momentEn: "",
});

/** A new goal: it starts in 10 minutes and runs an hour. */
export function blankGoal(now: number, timeZone: string): GoalDraft {
  return {
    id: null,
    started: false,
    titleAr: "",
    titleEn: "",
    measure: "points",
    scope: "all",
    questId: "",
    categoryId: "",
    target: "",
    startsAt: toLocalInput(new Date(now + 10 * 60_000), timeZone),
    endsAt: toLocalInput(new Date(now + 70 * 60_000), timeZone),
    paidTo: "contributors",
    reward: blankReward(),
    milestones: [],
  };
}

const rewardDraftOf = (step: GoalStep): RewardDraft => ({
  kind: step.reward.kind,
  points: step.reward.points === null ? "" : String(step.reward.points),
  momentAr: step.reward.moment?.ar ?? "",
  momentEn: step.reward.moment?.en ?? "",
});

/** The form for an existing goal; a started one keeps its window as it is stored. */
export function goalDraftOf(goal: Goal, timeZone: string): GoalDraft {
  const goalStep = goal.steps.find((step) => step.isGoal);
  return {
    id: goal.id,
    started: goal.started,
    titleAr: goal.title.ar ?? "",
    titleEn: goal.title.en ?? "",
    measure: goal.measure,
    scope: goal.questId !== null ? "quest" : goal.categoryId !== null ? "category" : "all",
    questId: goal.questId ?? "",
    categoryId: goal.categoryId ?? "",
    target: String(goal.target),
    startsAt: toLocalInput(new Date(goal.startsAt), timeZone),
    endsAt: toLocalInput(new Date(goal.endsAt), timeZone),
    paidTo: goal.paidTo,
    reward: goalStep === undefined ? blankReward() : rewardDraftOf(goalStep),
    milestones: goal.steps
      .filter((step) => !step.isGoal)
      .map((step) => ({ ...rewardDraftOf(step), threshold: String(step.threshold) })),
  };
}

const text = (value: string): string | undefined =>
  value.trim() === "" ? undefined : value.trim();
const whole = (value: string): number =>
  /^[0-9]{1,10}$/.test(value.trim()) ? Number(value) : Number.NaN;

function rewardBody(reward: RewardDraft): Record<string, unknown> {
  if (reward.kind === "points") {
    return { kind: "points", points: whole(reward.points) };
  }
  if (reward.kind === "moment") {
    return { kind: "moment", moment: { ar: text(reward.momentAr), en: text(reward.momentEn) } };
  }
  return { kind: "nothing" };
}

/**
 * The body for `POST`/`PATCH …/community-goals`. A started goal sends its stored window back unchanged (`original`),
 * so only its texts can differ; the API answers `goal_locked` for anything else.
 */
export function goalBodyOf(
  draft: GoalDraft,
  timeZone: string,
  original?: Readonly<{ startsAt: string; endsAt: string }>,
): Record<string, unknown> {
  const counted = draft.measure !== "points";
  return {
    title: { ar: text(draft.titleAr), en: text(draft.titleEn) },
    measure: draft.measure,
    questId: counted && draft.scope === "quest" ? draft.questId || null : null,
    categoryId: counted && draft.scope === "category" ? draft.categoryId || null : null,
    target: whole(draft.target),
    startsAt:
      draft.started && original !== undefined
        ? original.startsAt
        : toInstant(draft.startsAt, timeZone).toISOString(),
    endsAt:
      draft.started && original !== undefined
        ? original.endsAt
        : toInstant(draft.endsAt, timeZone).toISOString(),
    paidTo: draft.paidTo,
    reward: rewardBody(draft.reward),
    milestones: draft.milestones.map((step) => ({
      threshold: whole(step.threshold),
      reward: rewardBody(step),
    })),
  };
}

/** The bar's preview (Q-186: goals do not run in rehearsal): empty, and at the first milestone when there is one. */
export function previewFills(draft: Pick<GoalDraft, "target" | "milestones">): readonly number[] {
  const target = whole(draft.target);
  const first = draft.milestones
    .map((step) => whole(step.threshold))
    .filter((value) => value > 0)
    .toSorted((a, b) => a - b)[0];
  if (!(target > 0) || first === undefined || first >= target) {
    return [0];
  }
  return [0, first / target];
}

/** The fields an `invalid_goal` answer named, from its details. */
export function issuesOf(body: unknown): readonly string[] {
  const details = isRecord(body) && isRecord(body["details"]) ? body["details"] : {};
  const issues = details["issues"];
  return Array.isArray(issues)
    ? issues.filter((issue): issue is string => typeof issue === "string")
    : [];
}

/** Whether the goal is still running and its progress worth reading again. */
export const isLive = (goal: Pick<Goal, "status" | "finalAt">): boolean =>
  goal.status === "running" || (goal.status === "reached" && goal.finalAt === null);

/** "Settle and pay now"'s answer, or undefined when it is not one. */
export type SettleAnswer = Readonly<{ status: "paid" | "paying"; goals: number; due: number }>;

export function settleAnswerOf(body: unknown): SettleAnswer | undefined {
  if (!isRecord(body) || (body["status"] !== "paid" && body["status"] !== "paying")) {
    return undefined;
  }
  return { status: body["status"], goals: Number(body["goals"]), due: Number(body["due"]) };
}
