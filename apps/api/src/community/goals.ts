import type { Pool, PoolClient } from "pg";
import { REGISTRIES } from "@questify/shared";
import { z } from "zod";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { OrganizerContext } from "#src/organizers/store";
import { teamSeat } from "#src/organizers/store";
import { platformOnFor } from "#src/settings/layers";

export type CommunityDeps = Readonly<{ pool: Pool }>;

/** The most milestones a goal has besides its goal step (FR-246). */
export const MAX_MILESTONES = 5;
/** The most goals one event holds (migration 0053's goal_limit). */
export const MAX_GOALS = 20;
const MAX_POINTS_TARGET = 1_000_000_000;
const MAX_COUNT_TARGET = 1_000_000;
const MIN_WINDOW_MS = 60_000;

const text = (max: number) => z.string().trim().min(1).max(max);
const bilingual = (max: number) =>
  z
    .strictObject({ ar: text(max).optional(), en: text(max).optional() })
    .refine((value) => value.ar !== undefined || value.en !== undefined);
const reward = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("points"), points: z.number().int().min(1).max(100_000) }),
  z.strictObject({ kind: z.literal("moment"), moment: bilingual(280) }),
  z.strictObject({ kind: z.literal("nothing") }),
  /** Unlocks one quest, category or shop reward of the event (T-306c, ADR-227). */
  z.strictObject({
    kind: z.literal("unlock"),
    target: z.strictObject({ kind: z.enum(["quest", "category", "reward"]), id: z.uuid() }),
  }),
]);

type GoalRules = Readonly<{
  measure: string;
  questId?: string | null | undefined;
  categoryId?: string | null | undefined;
  target: number;
  startsAt: string;
  endsAt: string;
  milestones?: readonly Readonly<{ threshold: number }>[] | undefined;
}>;

const bothScoped = (goal: GoalRules): boolean => goal.questId != null && goal.categoryId != null;

const pointsScoped = (goal: GoalRules): boolean =>
  goal.measure === "points" && (goal.questId != null || goal.categoryId != null);

const countTooBig = (goal: GoalRules): boolean =>
  goal.measure !== "points" && goal.target > MAX_COUNT_TARGET;

const windowTooShort = (goal: GoalRules): boolean =>
  Date.parse(goal.endsAt) - Date.parse(goal.startsAt) < MIN_WINDOW_MS;

const milestonesBroken = (goal: GoalRules): boolean => {
  const thresholds = (goal.milestones ?? []).map((step) => step.threshold);
  return (
    thresholds.some((threshold) => threshold >= goal.target) ||
    new Set(thresholds).size !== thresholds.length
  );
};

/** The cross-field rules a goal breaks, by the field at fault, in the order they are checked. */
const RULES: readonly (readonly [path: string, broken: (goal: GoalRules) => boolean])[] = [
  ["categoryId", bothScoped],
  ["measure", pointsScoped],
  ["target", countTooBig],
  ["endsAt", windowTooShort],
  ["milestones", milestonesBroken],
];

const goalIssues = (goal: GoalRules): string[] =>
  RULES.filter(([, broken]) => broken(goal)).map(([path]) => path);

/**
 * A goal as the dashboard sends it (FR-243 to FR-248): the goal step is `target` with `reward`; up to 5 milestones
 * below it. The cross-field rules are checked here for a clear answer; the database checks them again.
 */
export const goalBody = z
  .strictObject({
    title: bilingual(80),
    measure: z.enum(["points", "completions", "players"]),
    questId: z.uuid().nullable().optional(),
    categoryId: z.uuid().nullable().optional(),
    target: z.number().int().min(1).max(MAX_POINTS_TARGET),
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
    paidTo: z.enum(["contributors", "everyone"]).optional(),
    reward,
    milestones: z
      .array(z.strictObject({ threshold: z.number().int().min(1), reward }))
      .max(MAX_MILESTONES)
      .optional(),
  })
  .superRefine((goal, context) => {
    for (const path of goalIssues(goal)) {
      context.addIssue({ code: "custom", path: [path], message: path });
    }
  });

export type GoalBody = z.infer<typeof goalBody>;

type Bilingual = Readonly<{ ar: string | null; en: string | null }>;
/** What an unlock step opens, with its names for the Community page. */
export type UnlockTarget = Readonly<{ kind: string; id: string; name: Bilingual }>;
type Reward = Readonly<{
  kind: string;
  points: number | null;
  moment: Bilingual | null;
  unlock: UnlockTarget | null;
}>;

/** A goal for its event's team: its window, steps with their reach and payout counts, progress and status. */
export type GoalView = Readonly<{
  id: string;
  title: Bilingual;
  measure: string;
  questId: string | null;
  categoryId: string | null;
  target: number;
  startsAt: string;
  endsAt: string;
  /** The window's real end: the goal's end, or the event's when that is earlier. */
  closesAt: string;
  paidTo: string;
  status: string;
  progress: number;
  progressAt: string | null;
  finalAt: string | null;
  started: boolean;
  steps: readonly Readonly<{
    threshold: number;
    isGoal: boolean;
    reward: Reward;
    reachedAt: string | null;
    due: number;
    paid: number;
    skipped: number;
  }>[];
}>;

/** Why a community call was refused (migration 0053); each maps to one HTTP answer in the routes. */
export type CommunityRefusal =
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "invalid"; issues: readonly string[] }>
  | Readonly<{ kind: "overlap" }>
  | Readonly<{ kind: "unlock_taken" }>
  | Readonly<{ kind: "locked"; field: string }>
  | Readonly<{ kind: "started" }>
  | Readonly<{ kind: "event_ended" }>
  | Readonly<{ kind: "limit_reached"; limit: number }>
  | Readonly<{ kind: "feature_off" }>
  | Readonly<{ kind: "owner_only" }>
  | Readonly<{ kind: "settling" }>;

export type CommunityDone<T> = Readonly<{ kind: "done"; value: T }> | CommunityRefusal;

type PgError = Readonly<{ code?: string; detail?: string; hint?: string; constraint?: string }>;

type Refuse = (pg: PgError) => CommunityRefusal;
type RefuseOrNot = (pg: PgError) => CommunityRefusal | undefined;

const GL409: ReadonlyMap<string, Refuse> = new Map<string, Refuse>([
  ["goal_overlap", () => ({ kind: "overlap" })],
  ["goal_locked", (pg) => ({ kind: "locked", field: pg.hint ?? "goal" })],
  ["goal_started", () => ({ kind: "started" })],
  ["event_ended", () => ({ kind: "event_ended" })],
  ["goal_limit", () => ({ kind: "limit_reached", limit: MAX_GOALS })],
  ["unlock_taken", () => ({ kind: "unlock_taken" })],
]);

/** The field a constraint or key the database refused names, for `invalid_goal`. */
const fieldOf = (pg: PgError): string => {
  const constraint = pg.constraint ?? "";
  // A step's unlock target removed or deleted between the check and the write (migration 0054's keys).
  if (constraint.startsWith("community_step_unlock")) {
    return "unlock_target";
  }
  if (constraint.includes("quest")) {
    return "questId";
  }
  if (constraint.includes("category")) {
    return "categoryId";
  }
  return "milestones";
};

/** An unlock's refusal names its reason in HINT: unlock_target or unlock_counted (migration 0054). */
const goalIssueOf = (pg: PgError): string =>
  pg.detail === "unlock" ? (pg.hint ?? "unlock") : (pg.detail ?? "goal");

/** The unique index on a target, the backstop behind the builder's unlock_taken check. */
const uniqueRefusalOf = (pg: PgError): CommunityRefusal =>
  pg.constraint?.startsWith("community_step_unlock") === true
    ? { kind: "unlock_taken" }
    : { kind: "invalid", issues: [fieldOf(pg)] };

const notFoundRefusal = (): CommunityRefusal => ({ kind: "not_found" });
const invalidFieldRefusal = (pg: PgError): CommunityRefusal => ({
  kind: "invalid",
  issues: [fieldOf(pg)],
});

const REFUSALS_BY_CODE: ReadonlyMap<string, RefuseOrNot> = new Map<string, RefuseOrNot>([
  ["AN404", notFoundRefusal],
  ["GN404", notFoundRefusal],
  ["CG422", (pg) => ({ kind: "invalid", issues: [goalIssueOf(pg)] })],
  ["GL409", (pg) => GL409.get(pg.detail ?? "")?.(pg)],
  ["CO403", () => ({ kind: "owner_only" })],
  ["CS409", () => ({ kind: "settling" })],
  ["23505", uniqueRefusalOf],
  ["23503", invalidFieldRefusal],
  ["23514", invalidFieldRefusal],
]);

/** The SQLSTATEs of migrations 0053 and 0054 (and the keys behind them) as refusals; undefined for anything else. */
export function refusalOf(pg: PgError): CommunityRefusal | undefined {
  return pg.code === undefined ? undefined : REFUSALS_BY_CODE.get(pg.code)?.(pg);
}

/** Runs one call in the team member's seat; a refusal the database raises becomes its result. */
export async function asTeam<T>(
  deps: Pick<CommunityDeps, "pool">,
  context: OrganizerContext,
  work: (client: PoolClient) => Promise<T>,
): Promise<CommunityDone<T>> {
  const seat = teamSeat(context);
  try {
    const value = await withConnection(deps.pool, (client) =>
      withRequestContext(client, seat, () => work(client)),
    );
    return { kind: "done", value };
  } catch (error) {
    const refusal = refusalOf(error as PgError);
    if (refusal === undefined) {
      throw error;
    }
    return refusal;
  }
}

/**
 * Runs one builder call in the team seat unless the platform switch, as the event's organizer sees it (the platform, or
 * Questify's override for the organizer; ADR-543), keeps community quests off: then `feature_off` and nothing is written.
 * The event's own switch is the database's (`community_on`).
 */
async function whileCommunityOn<T>(
  deps: Pick<CommunityDeps, "pool">,
  context: OrganizerContext,
  eventId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<CommunityDone<T>> {
  const target = { eventId, organizerId: context.organizerId };
  const result = await asTeam(deps, context, async (client) =>
    (await platformOnFor(client, REGISTRIES, target, "community")) === false
      ? { off: true as const }
      : { off: false as const, value: await work(client) },
  );
  if (result.kind !== "done") {
    return result;
  }
  return result.value.off ? { kind: "feature_off" } : { kind: "done", value: result.value.value };
}

const iso = (value: unknown): string | null =>
  typeof value === "string" ? new Date(value).toISOString() : null;

type GoalJson = Record<string, unknown> & { steps: Record<string, unknown>[] | null };

const bilingualOf = (value: unknown): Bilingual => {
  const both = (value ?? {}) as { ar?: string | null; en?: string | null };
  return { ar: both.ar ?? null, en: both.en ?? null };
};

const unlockOf = (value: unknown): UnlockTarget | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const target = value as Record<string, unknown>;
  return {
    kind: String(target["kind"]),
    id: String(target["id"]),
    name: bilingualOf(target["name"]),
  };
};

const viewOf = (goal: GoalJson): GoalView => ({
  id: String(goal["id"]),
  title: bilingualOf(goal["title"]),
  measure: String(goal["measure"]),
  questId: (goal["questId"] as string | null) ?? null,
  categoryId: (goal["categoryId"] as string | null) ?? null,
  target: Number(goal["target"]),
  startsAt: iso(goal["startsAt"]) ?? "",
  endsAt: iso(goal["endsAt"]) ?? "",
  closesAt: iso(goal["closesAt"]) ?? "",
  paidTo: String(goal["paidTo"]),
  status: String(goal["status"]),
  progress: Number(goal["progress"]),
  progressAt: iso(goal["progressAt"]),
  finalAt: iso(goal["finalAt"]),
  started: goal["started"] === true,
  steps: (goal.steps ?? []).map((step) => ({
    threshold: Number(step["threshold"]),
    isGoal: step["isGoal"] === true,
    reward: {
      kind: String(step["reward"]),
      points: step["points"] === null ? null : Number(step["points"]),
      moment: step["moment"] === null ? null : bilingualOf(step["moment"]),
      unlock: unlockOf(step["unlock"]),
    },
    reachedAt: iso(step["reachedAt"]),
    due: Number(step["due"]),
    paid: Number(step["paid"]),
    skipped: Number(step["skipped"]),
  })),
});

const readGoals = async (client: PoolClient, eventId: string): Promise<GoalView[]> => {
  const { rows } = await client.query<{ goals: GoalJson[] }>(
    "SELECT community_goals($1) AS goals",
    [eventId],
  );
  return (rows[0]?.goals ?? []).map(viewOf);
};

/** The event's community goals for its team (owners and editors), by start. */
export function listGoals(
  deps: CommunityDeps,
  context: OrganizerContext,
  eventId: string,
): Promise<CommunityDone<GoalView[]>> {
  return asTeam(deps, context, (client) => readGoals(client, eventId));
}

/** The body as the database reads it: absent optional fields as null, milestones as a list. */
const stored = (body: GoalBody) => ({
  ...body,
  questId: body.questId ?? null,
  categoryId: body.categoryId ?? null,
  paidTo: body.paidTo ?? "contributors",
  milestones: body.milestones ?? [],
});

/**
 * Creates a goal (`goalId` null) or replaces one before it starts; a started goal takes new texts only (FR-243,
 * migration 0053). Refused while the platform switch, as the organizer sees it, is off. Audited by the database. Answers the saved goal.
 */
export async function saveGoal(
  deps: CommunityDeps,
  context: OrganizerContext,
  request: Readonly<{ eventId: string; goalId: string | null; body: GoalBody; requestId: string }>,
): Promise<CommunityDone<GoalView>> {
  const result = await whileCommunityOn(deps, context, request.eventId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      "SELECT save_community_goal($1, $2, $3, $4) AS id",
      [request.eventId, request.goalId, JSON.stringify(stored(request.body)), request.requestId],
    );
    const goals = await readGoals(client, request.eventId);
    return goals.find((goal) => goal.id === rows[0]?.id);
  });
  if (result.kind !== "done") {
    return result;
  }
  return result.value === undefined ? { kind: "not_found" } : { kind: "done", value: result.value };
}

/** Deletes a goal before it starts (GL409 goal_started after). Audited by the database. */
export async function deleteGoal(
  deps: CommunityDeps,
  context: OrganizerContext,
  request: Readonly<{ eventId: string; goalId: string; requestId: string }>,
): Promise<CommunityDone<null>> {
  return whileCommunityOn(deps, context, request.eventId, async (client) => {
    await client.query("SELECT delete_community_goal($1, $2, $3)", [
      request.eventId,
      request.goalId,
      request.requestId,
    ]);
    return null;
  });
}
