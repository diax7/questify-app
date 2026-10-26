import {
  achievementsSchema,
  ownEventsSchema,
  questifyQuestsSchema,
  questifySyncSchema,
  type Achievement,
  type QuestifyQuests,
  type QuestifySync,
} from "@questify/shared";
import type { Session } from "#src/api/session.ts";

type Reader = Pick<Session, "request">;
type Schema<T> = Readonly<{
  safeParse: (value: unknown) => Readonly<{ success: true; data: T } | { success: false }>;
}>;

/** The body of a 200 answer that fits the schema, else null: a failed or odd answer is never shown as an empty list. */
async function readOk<T>(session: Reader, path: string, schema: Schema<T>): Promise<T | null> {
  const answer = await session.request({ method: "GET", path });
  const parsed = answer.kind === "ok" ? schema.safeParse(answer.body) : null;
  return parsed?.success === true ? parsed.data : null;
}

/** The five achievements with the caller's tier and progress (FR-707, FR-708); null when unreadable. */
export async function fetchAchievements(session: Reader): Promise<Achievement[] | null> {
  return (await readOk(session, "/v1/me/achievements", achievementsSchema))?.achievements ?? null;
}

/** One page of the caller's events: the passport with `played`, the whole history without it (owner only). */
export function fetchEventPage(session: Reader, query: { played: boolean; cursor: string | null }) {
  const params = [
    ...(query.played ? ["played=true"] : []),
    ...(query.cursor === null ? [] : [`cursor=${encodeURIComponent(query.cursor)}`]),
  ];
  const suffix = params.length === 0 ? "" : `?${params.join("&")}`;
  return readOk(session, `/v1/me/event-history${suffix}`, ownEventsSchema);
}

/** The always-on Questify quests and the campaigns running now, with the caller's progress. */
export function fetchQuestifyQuests(session: Reader): Promise<QuestifyQuests | null> {
  return readOk(session, "/v1/me/questify-quests", questifyQuestsSchema);
}

/** What one sync call came to; a 429 is `limited` and is never shown to the player. */
export type SyncOutcome =
  | Readonly<{ kind: "ok"; sync: QuestifySync }>
  | Readonly<{ kind: "limited"; retryAfterSeconds: number | null }>
  | Readonly<{ kind: "failed" }>;

const retryAfterOf = (headers: Headers): number | null => {
  const seconds = Number(headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
};

/** Asks the server to credit what the player has earned (achievements, Questify quests, levels). */
export async function postSync(session: Reader): Promise<SyncOutcome> {
  const answer = await session.request({ method: "POST", path: "/v1/me/questify/sync" });
  if (answer.kind === "error" && answer.status === 429) {
    return { kind: "limited", retryAfterSeconds: retryAfterOf(answer.headers) };
  }
  const parsed = answer.kind === "ok" ? questifySyncSchema.safeParse(answer.body) : null;
  return parsed?.success === true ? { kind: "ok", sync: parsed.data } : { kind: "failed" };
}
