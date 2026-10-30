import {
  POLL_CHOICES,
  POLL_RESULTS,
  TUNING,
  type ComposedConfig,
  type PollChoices,
  type PollResults,
} from "@questify/shared";
import type { Session } from "#src/api/session.ts";
import { communityOf, type CommunityCard } from "#src/event/community.ts";
import {
  liveBoostsOf,
  liveFlashOf,
  type LiveBoost,
  type LiveFlash,
} from "#src/event/flash-boost.ts";
import {
  isChoices,
  isRecord,
  isStrings,
  isText,
  type PlayChoice,
  type PlayText,
} from "#src/event/plays.ts";
import { liveFirstBonusOf, type LiveFirstBonus } from "#src/event/first-bonus.ts";

// ================================================================ the poll (FR-239 to FR-242)

export type PollCounts = Readonly<{
  options: readonly Readonly<{ id: string; votes: number }>[];
  voters: number;
}>;

/** A live poll as `GET /v1/quests/{id}/poll` answers it. */
export type PollView = Readonly<{
  title: PlayText;
  points: number;
  options: readonly PlayChoice[];
  choices: PollChoices;
  results: PollResults;
  closesAt: string;
  closed: boolean;
  mine: readonly string[];
  /** Each option's votes once the poll's policy shows them, else null. */
  counts: PollCounts | null;
  serverNow: string;
}>;

const isCounts = (value: unknown): value is PollCounts =>
  isRecord(value) &&
  typeof value["voters"] === "number" &&
  Array.isArray(value["options"]) &&
  value["options"].every(
    (option) =>
      isRecord(option) && typeof option["id"] === "string" && typeof option["votes"] === "number",
  );

const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (list as readonly string[]).includes(value);

export function pollViewOf(body: unknown): PollView | undefined {
  if (
    !isRecord(body) ||
    !isText(body["title"]) ||
    typeof body["points"] !== "number" ||
    !isChoices(body["options"]) ||
    !oneOf(POLL_CHOICES, body["choices"]) ||
    !oneOf(POLL_RESULTS, body["results"]) ||
    typeof body["closesAt"] !== "string" ||
    typeof body["closed"] !== "boolean" ||
    !isStrings(body["mine"]) ||
    !(body["counts"] === null || isCounts(body["counts"])) ||
    typeof body["serverNow"] !== "string"
  ) {
    return undefined;
  }
  return {
    title: body["title"],
    points: body["points"],
    options: body["options"],
    choices: body["choices"],
    results: body["results"],
    closesAt: body["closesAt"],
    closed: body["closed"],
    mine: body["mine"],
    counts: body["counts"],
    serverNow: body["serverNow"],
  };
}

/** The poll, `not_live` when the quest is a plain vote (404), or undefined when it could not be read. */
export async function fetchPoll(
  session: Pick<Session, "request">,
  questId: string,
): Promise<PollView | "not_live" | undefined> {
  const answer = await session.request({
    method: "GET",
    path: `/v1/quests/${encodeURIComponent(questId)}/poll`,
  });
  if (answer.kind === "error" && answer.status === 404) {
    return "not_live";
  }
  return answer.kind === "ok" ? pollViewOf(answer.body) : undefined;
}

/** A choice made on the sheet: one option replaces the last; several toggle. */
export function toggleChoice(
  chosen: readonly string[],
  id: string,
  choices: PollChoices,
): readonly string[] {
  if (choices === "one") {
    return [id];
  }
  return chosen.includes(id) ? chosen.filter((item) => item !== id) : [...chosen, id];
}

/** Each option's share of the voters, as a whole percent: with several choices they can add up past 100 (CTO 8). */
export function sharesOf(counts: PollCounts): readonly Readonly<{ id: string; percent: number }>[] {
  return counts.options.map((option) => ({
    id: option.id,
    percent: counts.voters === 0 ? 0 : Math.round((option.votes * 100) / counts.voters),
  }));
}

/** A countdown as `m:ss`, or `h:mm:ss` from an hour; Western digits in both languages (ADR-018). */
export function clockText(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

// ================================================================ what is live (ADR-221)

export type LiveState = Readonly<{
  polls: readonly Readonly<{ questId: string; closesAt: string }>[];
  closed: readonly Readonly<{ questId: string }>[];
  /** The community goal to show (T-306b), or null. */
  community: CommunityCard | null;
  /** Flash quests just launched or started (T-307): one-time cards; none from an older API. */
  flash: readonly LiveFlash[];
  /** Boosts just started on categories the player sees (T-307): one-time cards; none from an older API. */
  boosts: readonly LiveBoost[];
  /** What is left of the first-N bonuses the player may still earn (T-313); none from an older API. */
  firstBonus: readonly LiveFirstBonus[];
  /** The cheers moment live now (T-509): the end, or null; none from an older API. */
  cheers: Readonly<{ endsAt: string }> | null;
}>;

export const NOTHING_LIVE: LiveState = {
  polls: [],
  closed: [],
  community: null,
  flash: [],
  boosts: [],
  firstBonus: [],
  cheers: null,
};

export function liveStateOf(body: unknown): LiveState | undefined {
  if (!isRecord(body) || !Array.isArray(body["polls"]) || !Array.isArray(body["closed"])) {
    return undefined;
  }
  const polls = body["polls"].filter(
    (poll): poll is { questId: string; closesAt: string } =>
      isRecord(poll) && typeof poll["questId"] === "string" && typeof poll["closesAt"] === "string",
  );
  const closed = body["closed"].filter(
    (poll): poll is { questId: string } => isRecord(poll) && typeof poll["questId"] === "string",
  );
  return {
    polls: polls.map((poll) => ({ questId: poll.questId, closesAt: poll.closesAt })),
    closed: closed.map((poll) => ({ questId: poll.questId })),
    community: communityOf(body["community"]),
    flash: liveFlashOf(body["flash"]),
    boosts: liveBoostsOf(body["boosts"]),
    firstBonus: liveFirstBonusOf(body["firstBonus"]),
    cheers: liveCheersOf(body["cheers"]),
  };
}

/** The cheers moment in a live answer, or null when none is live or the answer is not one. */
function liveCheersOf(value: unknown): LiveState["cheers"] {
  return isRecord(value) &&
    typeof value["endsAt"] === "string" &&
    !Number.isNaN(Date.parse(value["endsAt"]))
    ? { endsAt: value["endsAt"] }
    : null;
}

/** One read of `GET /v1/events/{id}/live`: the state (or `unchanged` on a 304) with its ETag and the server's clock. */
export type LiveRead =
  | Readonly<{ kind: "state"; state: LiveState; etag: string | null; serverNow: string | null }>
  | Readonly<{ kind: "unchanged"; serverNow: string | null }>
  | Readonly<{ kind: "failed" }>;

export async function fetchLive(
  session: Pick<Session, "request">,
  eventId: string,
  etag: string | null,
): Promise<LiveRead> {
  const answer = await session.request({
    method: "GET",
    path: `/v1/events/${encodeURIComponent(eventId)}/live`,
    ...(etag === null ? {} : { headers: { "if-none-match": etag } }),
  });
  if (answer.kind === "error" && answer.status === 304) {
    return { kind: "unchanged", serverNow: answer.headers.get("server-now") };
  }
  if (answer.kind !== "ok") {
    return { kind: "failed" };
  }
  const state = liveStateOf(answer.body);
  return state === undefined
    ? { kind: "failed" }
    : {
        kind: "state",
        state,
        etag: answer.headers.get("etag"),
        serverNow: answer.headers.get("server-now"),
      };
}

/** The poll the card shows next: the first open one not voted in or put off in this session. */
export function nextPoll(
  state: LiveState,
  putOff: ReadonlySet<string>,
): Readonly<{ questId: string; closesAt: string }> | undefined {
  return state.polls.find((poll) => !putOff.has(poll.questId));
}

/** The at_close poll whose results card shows next: closed lately and not yet shown on this phone. */
export function nextResults(state: LiveState, shown: readonly string[]): string | undefined {
  return state.closed.find((poll) => !shown.includes(poll.questId))?.questId;
}

/** Where the phone remembers which results cards it showed (one-time each). */
export const resultsShownKey = (eventId: string): string => `questify.pollResults.${eventId}`;

/** The ids kept on the phone, at most the latest 50, so the list never grows without end. */
export function rememberShown(shown: readonly string[], questId: string): readonly string[] {
  return [...shown.filter((id) => id !== questId), questId].slice(-50);
}

export function shownOf(raw: string | null): readonly string[] {
  if (raw === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isStrings(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Whether the screen is calm enough for the card: on one of the event's tabs other than Scan, with no other sheet open
 * (the card's own sheet is not open yet when this is asked). A game, the scanner and the ranking are screens above the
 * tabs, so their route leaves the tabs.
 */
export function calmScreen(segments: readonly string[], openSheets: number): boolean {
  const last = segments[segments.length - 1];
  return openSheets === 0 && segments.includes("(tabs)") && last !== "scan";
}

const LIVE_POLL = TUNING["livePollSeconds"];

/** The configuration's live poll interval, kept inside its range; the default when it has none. */
export function livePollSecondsOf(config: ComposedConfig | undefined): number {
  const value = config?.tuning["livePollSeconds"];
  const fallback = LIVE_POLL?.default ?? 10;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(LIVE_POLL?.max ?? 60, Math.max(LIVE_POLL?.min ?? 5, value));
}
