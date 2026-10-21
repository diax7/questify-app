import type { Pool, PoolClient } from "pg";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { SettingsService } from "#src/settings/service";

export type HomeDeps = Readonly<{ pool: Pool; settings: SettingsService }>;

type Text = Readonly<{ ar: string | null; en: string | null }>;

/** A quest as the event's members see it (`member_event_quests`, migration 0021). */
export type MemberQuest = Readonly<{
  id: string;
  title: Text;
  description: Text;
  type: string;
  points: number;
  repeatCap: number;
  opensAt: Date | null;
  closesAt: Date | null;
  /** How many times the calling player completed it. */
  done: number;
}>;

export type MemberCategory = Readonly<{ id: string; name: Text; quests: MemberQuest[] }>;

export type UpNext = Readonly<{ questId: string; title: Text; points: number; type: string }>;

export type EventStatusNow = "draft" | "scheduled" | "live" | "ended" | "archived";

export type Home = Readonly<{
  event: Readonly<{
    id: string;
    name: Text;
    venue: Text;
    startsAt: Date | null;
    endsAt: Date | null;
    timezone: string;
    statusNow: EventStatusNow;
  }>;
  standing:
    | Readonly<{
        status: "active";
        score: number;
        balance: number;
        questsDone: number;
        questsTotal: number;
      }>
    | Readonly<{ status: "pending" }>;
  upNext: UpNext | null;
  rankingOn: boolean;
}>;

/** Finished means done to its repeat cap: the same rule for progress and for Up next, so they never disagree. */
export const finished = (quest: MemberQuest): boolean => quest.done >= quest.repeatCap;

/** Open for this player now: the event is live, the quest's window holds `now`, and they have not finished it. */
export function isOpen(quest: MemberQuest, statusNow: EventStatusNow, now: Date): boolean {
  return (
    statusNow === "live" &&
    (quest.opensAt === null || quest.opensAt <= now) &&
    (quest.closesAt === null || quest.closesAt > now) &&
    !finished(quest)
  );
}

/**
 * Up next (FR-804, FR-1748): the pinned quest while it is open for this player; else the open quest with the most
 * points, the first in the event's order on a tie (Q-101: points per estimated minute once quests have a time).
 */
export function pickUpNext(
  quests: readonly MemberQuest[],
  focusQuestId: string | null,
  statusNow: EventStatusNow,
  now: Date,
): UpNext | null {
  const open = quests.filter((quest) => isOpen(quest, statusNow, now));
  const pinned = open.find((quest) => quest.id === focusQuestId);
  const chosen =
    pinned ??
    open.reduce<MemberQuest | undefined>(
      (best, quest) => (best === undefined || quest.points > best.points ? quest : best),
      undefined,
    );
  return chosen === undefined
    ? null
    : { questId: chosen.id, title: chosen.title, points: chosen.points, type: chosen.type };
}

type QuestRow = Readonly<{
  category_id: string;
  category_name_ar: string | null;
  category_name_en: string | null;
  quest_id: string;
  title_ar: string | null;
  title_en: string | null;
  description_ar: string | null;
  description_en: string | null;
  type: string;
  points: number;
  repeat_cap: number;
  opens_at: Date | null;
  closes_at: Date | null;
  done: number;
}>;

const asPlayer = <T>(deps: HomeDeps, playerId: string, work: (client: PoolClient) => Promise<T>) =>
  withConnection(deps.pool, (client) =>
    withRequestContext(client, { playerId }, () => work(client)),
  );

async function questRows(client: PoolClient, eventId: string): Promise<MemberCategory[]> {
  const { rows } = await client.query<QuestRow>("SELECT * FROM member_event_quests($1)", [eventId]);
  const categories = new Map<string, { id: string; name: Text; quests: MemberQuest[] }>();
  for (const row of rows) {
    const category = categories.get(row.category_id) ?? {
      id: row.category_id,
      name: { ar: row.category_name_ar, en: row.category_name_en },
      quests: [],
    };
    category.quests.push({
      id: row.quest_id,
      title: { ar: row.title_ar, en: row.title_en },
      description: { ar: row.description_ar, en: row.description_en },
      type: row.type,
      points: row.points,
      repeatCap: row.repeat_cap,
      opensAt: row.opens_at,
      closesAt: row.closes_at,
      done: row.done,
    });
    categories.set(row.category_id, category);
  }
  return [...categories.values()];
}

/** The event's quests for an active member (T-114's tab, Home's Up next); null for anyone else. */
export async function memberQuests(
  deps: HomeDeps,
  playerId: string,
  eventId: string,
): Promise<MemberCategory[] | null> {
  return asPlayer(deps, playerId, async (client) => {
    if ((await standingOf(client, playerId, eventId))?.status !== "active") {
      return null;
    }
    return questRows(client, eventId);
  });
}

type StandingRow = Readonly<{
  status: string;
  score: string;
  balance: string;
  name_ar: string | null;
  name_en: string | null;
  venue_ar: string | null;
  venue_en: string | null;
  starts_at: Date | null;
  ends_at: Date | null;
  timezone: string;
  status_now: EventStatusNow;
  focus_quest_id: string | null;
  /** The database's clock: the same one that decided `status_now`, so "open" has one source. */
  now: Date;
}>;

/** The player's own enrollment and its event, read under their own rules (a player reads only their events). */
async function standingOf(
  client: PoolClient,
  playerId: string,
  eventId: string,
): Promise<StandingRow | undefined> {
  const { rows } = await client.query<StandingRow>(
    `SELECT n.status, n.score, n.balance, e.name_ar, e.name_en, e.venue_ar, e.venue_en, e.starts_at, e.ends_at,
            e.timezone, event_status_now(e.status, e.starts_at, e.ends_at) AS status_now, e.focus_quest_id,
            now() AS now
     FROM enrollment n JOIN event e ON e.id = n.event_id
     WHERE n.event_id = $1 AND n.player_id = $2`,
    [eventId, playerId],
  );
  return rows[0];
}

/**
 * The event Home (FR-801, FR-804): the event, the player's standing and progress, Up next, and whether the ranking is
 * on. A pending member gets the event and "pending" only; anyone not active or pending gets null (403).
 */
export async function readHome(
  deps: HomeDeps,
  playerId: string,
  eventId: string,
): Promise<Home | null> {
  const home = await asPlayer(deps, playerId, async (client) => {
    const row = await standingOf(client, playerId, eventId);
    if (row === undefined || (row.status !== "active" && row.status !== "pending")) {
      return null;
    }
    const event = {
      id: eventId,
      name: { ar: row.name_ar, en: row.name_en },
      venue: { ar: row.venue_ar, en: row.venue_en },
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      timezone: row.timezone,
      statusNow: row.status_now,
    };
    if (row.status === "pending") {
      return { event, standing: { status: "pending" as const }, upNext: null };
    }
    const quests = (await questRows(client, eventId)).flatMap((category) => category.quests);
    return {
      event,
      standing: {
        status: "active" as const,
        score: Number(row.score),
        balance: Number(row.balance),
        questsDone: quests.filter(finished).length,
        questsTotal: quests.length,
      },
      upNext: pickUpNext(quests, row.focus_quest_id, row.status_now, row.now),
    };
  });
  if (home === null) {
    return null;
  }
  const config = await deps.settings.forEvent(eventId);
  const rankingOn = config.kind === "ok" && config.config.features["ranking"]?.enabled !== false;
  return { ...home, rankingOn };
}
