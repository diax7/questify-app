import { AVATARS } from "@questify/shared";

/** The scenes the team picks and orders (T-504, FR-631): the live ranking, the community goal and the live poll. */
export const SCENES = ["ranking", "community", "poll"] as const;
export type Scene = (typeof SCENES)[number];
/** The scenes a screen runs: the picked ones, and the finale a set finale adds by itself (T-307b). */
export const RUNNING_SCENES = [...SCENES, "finale"] as const;
export type RunningScene = (typeof RUNNING_SCENES)[number];

/** How long one scene stays up before the next (fixed, ADR-365), and how often the open scene reads again. */
export const SCENE_MS = 15_000;
export const SCENE_POLL_MS = 3000;
/** A rate-limited screen waits this long before its next read; an empty scene is read again after this long. */
export const SLOWED_MS = 6000;
export const EMPTY_RECHECK_MS = 20_000;
/** A scene found empty is left after this long, when another scene has something to show. */
export const EMPTY_SKIP_MS = 1000;

type Bilingual = Readonly<{ ar: string | null; en: string | null }>;
export type Measure = "points" | "completions" | "players";

export type RankingRow = Readonly<{
  place: number;
  username: string;
  avatar: string;
  score: number;
}>;
export type Milestone = Readonly<{ threshold: number; isGoal: boolean; reached: boolean }>;
export type CommunityGoal = Readonly<{
  title: Bilingual;
  measure: Measure;
  target: number;
  progress: number;
  status: "running" | "reached" | "missed";
  steps: readonly Milestone[];
}>;
export type FinaleWinner = Readonly<{ place: number; username: string | null; avatar: string }>;
/** The finale scene's phase now (T-307b): the countdown, the last push, a wait for the reveal, or the winners. */
export type FinaleView =
  | Readonly<{ phase: "countdown"; startsAt: number }>
  | Readonly<{ phase: "push"; startsAt: number; goal: CommunityGoal }>
  | Readonly<{ phase: "waiting"; startsAt: number }>
  | Readonly<{ phase: "reveal"; startsAt: number; winners: readonly FinaleWinner[] }>;
export type PollOption = Readonly<{ text: Bilingual; votes: number }>;
export type PollView = Readonly<{
  title: Bilingual;
  closed: boolean;
  voters: number;
  /** The options with their votes when the poll's policy shows them now, else null (the count only, FR-1613). */
  options: readonly PollOption[] | null;
}>;

/** One scene's answer; `shut` is why nothing shows (the event ended, the add-on is off, the ranking is off). */
export type SceneAnswer =
  | Readonly<{ scene: "ranking"; shut: string | null; rows: readonly RankingRow[] }>
  | Readonly<{ scene: "community"; shut: string | null; goal: CommunityGoal | null }>
  | Readonly<{ scene: "poll"; shut: string | null; poll: PollView | null }>
  /** `clockOffset` is the server's clock minus this page's when the answer arrived, in milliseconds. */
  | Readonly<{
      scene: "finale";
      shut: string | null;
      finale: FinaleView | null;
      clockOffset: number;
    }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const numberOf = (value: unknown): number => (typeof value === "number" ? value : 0);

const textOf = (value: unknown): Bilingual => {
  const text = isRecord(value) ? value : {};
  return {
    ar: typeof text["ar"] === "string" ? text["ar"] : null,
    en: typeof text["en"] === "string" ? text["en"] : null,
  };
};

const rowsOf = (value: unknown): readonly RankingRow[] =>
  (Array.isArray(value) ? value : []).filter(isRecord).map((row) => ({
    place: numberOf(row["place"]),
    username: typeof row["username"] === "string" ? row["username"] : "",
    avatar: typeof row["avatar"] === "string" ? row["avatar"] : "",
    score: numberOf(row["score"]),
  }));

const MEASURES: readonly string[] = ["points", "completions", "players"];
const STATUSES: readonly string[] = ["running", "reached", "missed"];

function goalOf(value: unknown): CommunityGoal | null {
  if (!isRecord(value) || numberOf(value["target"]) < 1) {
    return null;
  }
  const measure = String(value["measure"]);
  const status = String(value["status"]);
  return {
    title: textOf(value["title"]),
    measure: (MEASURES.includes(measure) ? measure : "points") as Measure,
    target: numberOf(value["target"]),
    progress: numberOf(value["progress"]),
    status: (STATUSES.includes(status) ? status : "running") as CommunityGoal["status"],
    steps: (Array.isArray(value["steps"]) ? value["steps"] : []).filter(isRecord).map((step) => ({
      threshold: numberOf(step["threshold"]),
      isGoal: step["isGoal"] === true,
      reached: step["reached"] === true,
    })),
  };
}

function pollOf(value: unknown): PollView | null {
  if (!isRecord(value)) {
    return null;
  }
  const options = value["options"];
  return {
    title: textOf(value["title"]),
    closed: value["closed"] === true,
    voters: numberOf(value["voters"]),
    options: Array.isArray(options)
      ? options
          .filter(isRecord)
          .map((option) => ({ text: textOf(option["text"]), votes: numberOf(option["votes"]) }))
      : null,
  };
}

const winnersOf = (value: unknown): readonly FinaleWinner[] =>
  (Array.isArray(value) ? value : []).filter(isRecord).map((row) => ({
    place: numberOf(row["place"]),
    username: typeof row["username"] === "string" ? row["username"] : null,
    avatar: typeof row["avatar"] === "string" ? row["avatar"] : "",
  }));

/** The finale in a scene answer, or null when none is set or the answer is not one. */
function finaleOf(value: unknown): FinaleView | null {
  if (!isRecord(value)) {
    return null;
  }
  const startsAt =
    typeof value["startsAt"] === "string" ? Date.parse(value["startsAt"]) : Number.NaN;
  return Number.isNaN(startsAt) ? null : phaseOf(value, startsAt);
}

function phaseOf(value: Record<string, unknown>, startsAt: number): FinaleView | null {
  switch (value["phase"]) {
    case "countdown":
      return { phase: "countdown", startsAt };
    case "push": {
      const goal = goalOf(value["goal"]);
      return goal === null ? { phase: "waiting", startsAt } : { phase: "push", startsAt, goal };
    }
    case "waiting":
      return { phase: "waiting", startsAt };
    case "reveal":
      return { phase: "reveal", startsAt, winners: winnersOf(value["winners"]) };
    default:
      return null;
  }
}

/** A scene's answer, read defensively; undefined when the body is not one. `now` is this page's clock on arrival. */
export function sceneAnswerOf(
  scene: RunningScene,
  body: unknown,
  now: number = Date.now(),
): SceneAnswer | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  const shut = typeof body["shut"] === "string" ? body["shut"] : null;
  switch (scene) {
    case "ranking":
      return { scene, shut, rows: rowsOf(body["rows"]) };
    case "community":
      return { scene, shut, goal: goalOf(body["goal"]) };
    case "poll":
      return { scene, shut, poll: pollOf(body["poll"]) };
    case "finale":
      return finaleAnswer(shut, body, now);
  }
}

/** The finale scene's answer, with the offset between the server clock and this page's when it arrived. */
function finaleAnswer(
  shut: string | null,
  body: Record<string, unknown>,
  now: number,
): SceneAnswer {
  const served = typeof body["serverNow"] === "string" ? Date.parse(body["serverNow"]) : Number.NaN;
  return {
    scene: "finale",
    shut,
    finale: finaleOf(body["finale"]),
    clockOffset: Number.isNaN(served) ? 0 : served - now,
  };
}

/** The picked scene names in an answer, in order; anything this page cannot pick is left out. */
export function scenesOf(value: unknown): readonly Scene[] {
  const names: readonly unknown[] = Array.isArray(value) ? value : [];
  return names.filter((name): name is Scene => SCENES.includes(name as Scene));
}

/** The scene names a screen runs in a device answer, in order; anything this page cannot run is left out. */
export function runningOf(value: unknown): readonly RunningScene[] {
  const names: readonly unknown[] = Array.isArray(value) ? value : [];
  return names.filter((name): name is RunningScene =>
    RUNNING_SCENES.includes(name as RunningScene),
  );
}

/**
 * Whether a scene has nothing to show, so the rotation passes it by: shut, no community goal, no poll. The ranking is
 * never empty while it is open (it says no one has scored yet).
 */
export function isEmpty(answer: SceneAnswer): boolean {
  if (answer.shut !== null) {
    return true;
  }
  switch (answer.scene) {
    case "ranking":
      return false;
    case "community":
      return answer.goal === null;
    case "poll":
      return answer.poll === null;
    case "finale":
      return answer.finale === null;
  }
}

/** What the page knows of a scene it read: whether it was empty, and when (milliseconds). */
export type Known = Readonly<{ empty: boolean; at: number }>;

/**
 * The scene to show after `current`: the next in the picked order that was not found empty in the last 20 seconds
 * (an empty scene is looked at again after that). When every other scene is empty it stays where it is.
 */
export function nextScene(
  scenes: readonly RunningScene[],
  current: RunningScene,
  known: Readonly<Partial<Record<RunningScene, Known>>>,
  now: number,
): RunningScene {
  const start = scenes.indexOf(current);
  for (let step = 1; step < scenes.length; step += 1) {
    const candidate = scenes[(start + step) % scenes.length] as RunningScene;
    const seen = known[candidate];
    if (seen === undefined || !seen.empty || now - seen.at >= EMPTY_RECHECK_MS) {
      return candidate;
    }
  }
  return current;
}

/** Milliseconds left to `startsAt` by the server's clock: this page's `now` moved by the offset read with the answer. */
export const remainingMs = (startsAt: number, clockOffset: number, now: number): number =>
  Math.max(0, startsAt - (now + clockOffset));

const two = (value: number): string => String(value).padStart(2, "0");

/** A countdown as hours, minutes and seconds, each of at least two Western digits; the last second rounds up. */
export function clockParts(
  ms: number,
): Readonly<{ hours: string; minutes: string; seconds: string }> {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return {
    hours: two(Math.floor(total / 3600)),
    minutes: two(Math.floor((total % 3600) / 60)),
    seconds: two(total % 60),
  };
}

/** The fill of a bar, 0 to 100 whole percent. */
export function percentOf(part: number, whole: number): number {
  return whole <= 0 ? 0 : Math.min(100, Math.max(0, Math.floor((part / whole) * 100)));
}

/** A poll's share for an option out of all the votes cast, in whole percent (rounded, so two of three reads 67). */
export function shareOf(votes: number, options: readonly PollOption[]): number {
  const total = options.reduce((sum, option) => sum + option.votes, 0);
  return total <= 0 ? 0 : Math.round((votes / total) * 100);
}

/** Questify's own avatar picture for a player, or null for one this page lacks (the first letter shows instead). */
export const avatarFile = (avatar: string): string | null =>
  AVATARS.find((known) => known === avatar) ?? null;

// ================================================================ the dashboard's Big screen page

/** One line of the scene list: a scene and whether it is picked. */
export type SceneRow = Readonly<{ scene: Scene; on: boolean }>;

/** The page's reading (`GET …/big-screen`). */
export type BigScreenPlan = Readonly<{
  scenes: readonly Scene[];
  offered: readonly Scene[];
  enabled: boolean;
}>;

/** The plan in an answer, or undefined when it is not one. */
export function planOf(body: unknown): BigScreenPlan | undefined {
  if (!isRecord(body) || !Array.isArray(body["scenes"]) || !Array.isArray(body["offered"])) {
    return undefined;
  }
  return {
    scenes: scenesOf(body["scenes"]),
    offered: scenesOf(body["offered"]),
    enabled: body["enabled"] === true,
  };
}

/** The offered scenes as lines: the picked ones first, in their order, then the others. */
export function rowsFor(plan: BigScreenPlan): readonly SceneRow[] {
  const picked = plan.scenes.filter((scene) => plan.offered.includes(scene));
  const rest = plan.offered.filter((scene) => !picked.includes(scene));
  return [
    ...picked.map((scene) => ({ scene, on: true })),
    ...rest.map((scene) => ({ scene, on: false })),
  ];
}

/** The lines with the one at `index` moved by one place, or the same lines at the ends of the list. */
export function moveRow(rows: readonly SceneRow[], index: number, by: -1 | 1): readonly SceneRow[] {
  const target = index + by;
  if (index < 0 || index >= rows.length || target < 0 || target >= rows.length) {
    return rows;
  }
  const next = [...rows];
  [next[index], next[target]] = [next[target] as SceneRow, next[index] as SceneRow];
  return next;
}

/** The lines with the scene's box ticked or cleared. */
export const toggleRow = (rows: readonly SceneRow[], scene: Scene): readonly SceneRow[] =>
  rows.map((row) => (row.scene === scene ? { scene, on: !row.on } : row));

/** The scenes to save: the ticked lines, in order. */
export const scenesToSave = (rows: readonly SceneRow[]): readonly Scene[] =>
  rows.filter((row) => row.on).map((row) => row.scene);
