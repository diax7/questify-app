import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext, type RequestContext } from "#src/db/context";
import { questifyFixture, type QuestifyFixture } from "#test/support/questify";
import { TEST_DATABASE_URL, addMember } from "#test/support/test-db";

type Member = Readonly<{ player: string; enrollment: string }>;
type Ev = Readonly<{ id: string; category: string; seed: string }>;
type DayRow = Readonly<{
  day: string;
  days: number;
  entry_id: string | null;
  completion_id: string;
}>;
type Settings = Readonly<{
  enabled?: boolean;
  bonus?: number | null;
  /** Weekdays to close, as offsets from the event's day now (their ISO weekday is taken). */
  weekdays?: number[];
  /** Dates to close, as offsets from the event's day now. */
  dates?: number[];
}>;

const GUIDELINES = "1.0";
const BONUS = 5;
const text = (en: string) => ({ en });
const QUIZ = {
  questions: [
    {
      id: "q1",
      text: text("Question"),
      choices: [
        { id: "r", text: text("Right") },
        { id: "w", text: text("Wrong") },
      ],
      right: "r",
    },
  ],
  timerSeconds: null,
};
const GAME = { game: "memory_match", level: "easy", attempts: 3, cooldownMinutes: null };
const PASS = { pairs: 6, moves: 9, ms: 30_000, lucky: 0 };

const refusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
    return "none";
  } catch (error) {
    const pg = error as { code?: string; detail?: string };
    const detail =
      pg.detail === undefined || pg.detail === "" || /^[0-9]/.test(pg.code ?? "")
        ? ""
        : `:${pg.detail}`;
    return `${pg.code}${detail}`;
  }
};
const as = (player: string): RequestContext => ({ playerId: player });
const noop = (): void => undefined;
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
/** Resolves `work`, or fails when it is still waiting after `ms`: a door that must not wait on a lock. */
const promptly = <T>(work: Promise<T>, ms = 5000): Promise<T> =>
  Promise.race([
    work,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("waited on a lock it should not take")), ms),
    ),
  ]);

/**
 * The event day streak in the database (T-405, migration 0068, ADR-295, ADR-296, ADR-301): counting over open event
 * days, closed weekdays and dates, the day boundary, the bonus from day 2 through every door, which day a reviewed or
 * team-awarded completion counts for, the append-only day row and the boundary race, removal, the owner-only settings
 * door, the crossed locks, and the ledger and XP invariants. Earlier days are written as the trigger writes them (a
 * completion and its day row), since a test cannot move the clock.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("the event day streak (database)", () => {
  let f: QuestifyFixture;
  let counter = 0;

  beforeAll(async () => {
    f = await questifyFixture();
  });
  afterAll(async () => {
    await f.close();
  });

  const owner = <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
    f.owner<T>(sql, values);

  /** A live event of organizer A (multi-day unless `hours` is given), a category and a hidden quest for history. */
  const newEvent = async (
    options: Readonly<{
      startedDaysAgo?: number;
      endsInDays?: number;
      timezone?: string;
      dayStart?: number;
      singleDay?: boolean;
      status?: string;
    }> = {},
  ): Promise<Ev> => {
    counter += 1;
    const [hour] = await owner<{ h: number }>(
      "SELECT extract(hour FROM now() AT TIME ZONE 'UTC')::int AS h",
    );
    const single = options.singleDay === true;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at, timezone, day_start_hour)
       VALUES ($1, $2, 'Streak Fest', $3, now() - $4::interval, now() + $5::interval, $6, $7) RETURNING id`,
      [
        f.ids.orgA,
        `STK${counter}`,
        options.status ?? "live",
        single ? "1 hour" : `${options.startedDaysAgo ?? 3} days`,
        single ? "1 hour" : `${options.endsInDays ?? 3} days`,
        single ? "UTC" : (options.timezone ?? "Asia/Riyadh"),
        // A single-day event starts its day 12 hours from now, so its two hours never cross a day start.
        single ? ((hour?.h ?? 0) + 12) % 24 : (options.dayStart ?? 4),
      ],
    );
    const id = event?.id ?? "";
    const [category] = await owner<{ id: string }>(
      "INSERT INTO category (event_id, name_en) VALUES ($1, 'General') RETURNING id",
      [id],
    );
    const seed = await newQuest(id, category?.id ?? "", { visible: false, repeat: 100 });
    return { id, category: category?.id ?? "", seed };
  };

  type QuestFields = Readonly<{
    type?: string;
    config?: object;
    points?: number;
    verification?: string[];
    visible?: boolean;
    repeat?: number;
  }>;
  const newQuest = async (event: string, category: string, fields: QuestFields = {}) => {
    const type = fields.type ?? "scan_qr";
    const [quest] = await owner<{ id: string }>(
      `WITH q AS (
         INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, type_config, position,
                            verification, visible)
         VALUES ($1, $2, $3, 'Tower', $4, $5, $6, 0, $7, $8) RETURNING id, type
       ), s AS (
         INSERT INTO passport_step (event_id, quest_id, name_en, position)
         SELECT $1, q.id, 'Booth', 0 FROM q WHERE q.type = 'passport' RETURNING id
       )
       SELECT id FROM q`,
      [
        event,
        category,
        type,
        fields.points ?? 10,
        fields.repeat ??
          (type === "scan_qr" || type === "enter_code" ? 100 : type === "meet" ? 10 : 1),
        JSON.stringify(fields.config ?? {}),
        fields.verification ?? null,
        fields.visible ?? true,
      ],
    );
    return quest?.id ?? "";
  };
  const quest = (ev: Ev, fields: QuestFields = {}) => newQuest(ev.id, ev.category, fields);

  const member = async (event: string, via = "code"): Promise<Member> => {
    const player = await f.newPlayer();
    await owner(
      `INSERT INTO player_acceptance (player_id, document, version, method)
       VALUES ($1, 'community_guidelines', $2, 'submission')`,
      [player, GUIDELINES],
    );
    return { player, enrollment: await f.join(event, player, via) };
  };

  /** A completion and its day row on the event's day now plus `offset`, as the trigger would have written them. */
  const seedDay = async (ev: Ev, who: Member, offset: number, days: number) => {
    await owner(
      `WITH c AS (
         INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                       idempotency_key)
         SELECT e.organizer_id, e.id, $2, $3,
                coalesce((SELECT max(x.occurrence) FROM quest_completion x
                          WHERE x.enrollment_id = $2 AND x.quest_id = $3), 0) + 1,
                'qr', gen_random_uuid()::text
         FROM event e WHERE e.id = $1
         RETURNING id, organizer_id, event_id
       )
       INSERT INTO event_streak_day (enrollment_id, day, organizer_id, event_id, days, completion_id)
       SELECT $2, event_day(now(), e) + $4::int, c.organizer_id, c.event_id, $5, c.id
       FROM c JOIN event e ON e.id = c.event_id`,
      [ev.id, who.enrollment, ev.seed, offset, days],
    );
  };
  /** Earlier open days 1 to `days` ending yesterday. */
  const history = async (ev: Ev, who: Member, days: number) => {
    for (let n = 1; n <= days; n += 1) await seedDay(ev, who, n - days - 1, n);
  };

  /** The settings as the owner writes them, bypassing the door (which refuses days that have started). */
  const configure = (ev: Ev, settings: Settings) =>
    owner(
      `INSERT INTO event_streak (event_id, organizer_id, enabled, bonus_points, closed_weekdays, closed_days)
       SELECT e.id, e.organizer_id, $2, $3,
              ARRAY(SELECT DISTINCT extract(isodow FROM event_day(now(), e) + o)::smallint
                    FROM unnest($4::int[]) o ORDER BY 1),
              ARRAY(SELECT DISTINCT event_day(now(), e) + o FROM unnest($5::int[]) o ORDER BY 1)
       FROM event e WHERE e.id = $1
       ON CONFLICT (event_id) DO UPDATE
       SET enabled = excluded.enabled, bonus_points = excluded.bonus_points,
           closed_weekdays = excluded.closed_weekdays, closed_days = excluded.closed_days`,
      [
        ev.id,
        settings.enabled ?? true,
        settings.bonus ?? null,
        settings.weekdays ?? [],
        settings.dates ?? [],
      ],
    );
  const dayOf = async (ev: Ev, offset = 0) =>
    (
      await owner<{ d: string }>(
        "SELECT (event_day(now(), e) + $2::int)::text AS d FROM event e WHERE e.id = $1",
        [ev.id, offset],
      )
    )[0]?.d ?? "";
  const weekdayOf = async (ev: Ev, offset: number) =>
    (
      await owner<{ w: number }>(
        "SELECT extract(isodow FROM event_day(now(), e) + $2::int)::int AS w FROM event e WHERE e.id = $1",
        [ev.id, offset],
      )
    )[0]?.w ?? 0;

  const complete = (player: string, target: string, key = randomUUID()) =>
    f.asPlayer<{ completion_id: string; points: string; score: string; balance: string }>(
      player,
      "SELECT * FROM complete_quest($1, 'qr', 1, NULL, $2, NULL)",
      [target, key],
    );
  const rowsOf = (who: Member) =>
    owner<DayRow>(
      `SELECT day::text AS day, days, entry_id, completion_id FROM event_streak_day
       WHERE enrollment_id = $1 ORDER BY day`,
      [who.enrollment],
    );
  const todayRow = async (ev: Ev, who: Member) => {
    const today = await dayOf(ev);
    return (await rowsOf(who)).find((row) => row.day === today);
  };
  const bonusesOf = (who: Member) =>
    owner<{ id: string; score_delta: string; balance_delta: string; completion_id: string }>(
      `SELECT id, score_delta, balance_delta, completion_id FROM ledger_entry
       WHERE enrollment_id = $1 AND kind = 'streak' ORDER BY id`,
      [who.enrollment],
    );
  const scoreOf = async (who: Member) =>
    Number(
      (
        await owner<{ score: string }>("SELECT score FROM enrollment WHERE id = $1", [
          who.enrollment,
        ])
      )[0]?.score,
    );
  const setStreak = (
    ev: Ev,
    body: Readonly<{
      enabled: boolean | null;
      bonus: number | null;
      weekdays: readonly number[];
      dates: readonly string[];
    }>,
    team: RequestContext = f.team(),
  ) =>
    f
      .run<{ outcome: string }>(
        team,
        "SELECT set_event_streak($1, $2, $3, $4, $5, $6) AS outcome",
        [ev.id, body.enabled, body.bonus, body.weekdays, body.dates, randomUUID()],
      )
      .then((rows) => rows[0]?.outcome);
  const off = { enabled: false, bonus: null, weekdays: [], dates: [] } as const;
  const paidMember = async () => {
    const ev = await newEvent();
    await configure(ev, { bonus: BONUS });
    const target = await quest(ev, { points: 10 });
    const who = await member(ev.id);
    await history(ev, who, 1);
    await complete(who.player, target);
    const [bonus] = await bonusesOf(who);
    return { ev, target, who, bonus: bonus?.id ?? "" };
  };
  const remove = (ev: Ev, entry: string, key = randomUUID()) =>
    f.run<{ entry_id: string; replayed: boolean }>(
      f.team(),
      "SELECT * FROM remove_award($1, $2, 'Cheated', $3, $4)",
      [ev.id, entry, key, randomUUID()],
    );
  const xpOf = async (player: string) =>
    (await owner<{ xp: string }>("SELECT xp FROM player_xp WHERE player_id = $1", [player]))[0]?.xp;
  const settingsOf = async (ev: Ev, team: RequestContext = f.team()) =>
    (
      await f.run<{ s: Record<string, unknown> }>(team, "SELECT event_streak_settings($1) AS s", [
        ev.id,
      ])
    )[0]?.s;
  const audits = (ev: Ev) =>
    owner<{ before: unknown; after: Record<string, unknown> }>(
      "SELECT before, after FROM audit_log WHERE event_id = $1 AND action = 'event.streak_set' ORDER BY id",
      [ev.id],
    );

  /** Runs `sql` in its own transaction and holds it open until released. */
  const hold = async (context: RequestContext, sql: string, values: unknown[]) => {
    const client: PoolClient = await f.pool.connect();
    let release = noop;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ran = noop;
    const started = new Promise<void>((resolve) => {
      ran = resolve;
    });
    const done = withRequestContext(client, context, async () => {
      const rows = (await client.query(sql, values)).rows;
      ran();
      await gate;
      return rows;
    }).finally(() => client.release());
    await Promise.race([started, done]);
    return { release, done };
  };

  // ============================================================ counting (Done when)
  describe("counting open event days (ADR-295, FR-1615)", () => {
    it("plays days 1, 2 and 3: day 3 is 3, with no bonus while the streak has none", async () => {
      const ev = await newEvent();
      const target = await quest(ev);
      const who = await member(ev.id);
      await history(ev, who, 2);
      await complete(who.player, target);
      expect((await rowsOf(who)).map((row) => [row.days, row.entry_id])).toEqual([
        [1, null],
        [2, null],
        [3, null],
      ]);
      expect(await bonusesOf(who)).toEqual([]);
    });

    it("missing an open day breaks the streak: day 3 after day 1 alone is 1", async () => {
      const ev = await newEvent();
      const target = await quest(ev);
      const who = await member(ev.id);
      await seedDay(ev, who, -2, 1);
      await complete(who.player, target);
      expect((await todayRow(ev, who))?.days).toBe(1);
    });

    it("a closed weekday between neither counts nor breaks: day 3 after it is 4", async () => {
      const ev = await newEvent();
      const target = await quest(ev);
      const who = await member(ev.id);
      await seedDay(ev, who, -2, 3);
      await configure(ev, { enabled: false, weekdays: [-1] });
      await complete(who.player, target);
      expect((await todayRow(ev, who))?.days).toBe(4);
    });

    it("a closed date between does the same", async () => {
      const ev = await newEvent();
      const target = await quest(ev);
      const who = await member(ev.id);
      await seedDay(ev, who, -3, 1);
      await configure(ev, { enabled: false, dates: [-2, -1] });
      await complete(who.player, target);
      expect((await todayRow(ev, who))?.days).toBe(2);
    });

    it("a completion on a closed day writes no day row and pays no bonus; the Questify day still counts", async () => {
      for (const settings of [{ dates: [0] }, { weekdays: [0] }]) {
        const ev = await newEvent();
        const target = await quest(ev);
        const who = await member(ev.id);
        await seedDay(ev, who, -1, 1);
        await configure(ev, { bonus: BONUS, ...settings });
        await complete(who.player, target);
        expect(await todayRow(ev, who)).toBeUndefined();
        expect(await bonusesOf(who)).toEqual([]);
        expect(
          await owner("SELECT 1 FROM questify_streak_day WHERE player_id = $1", [who.player]),
        ).toHaveLength(1);
      }
    });

    it("the day starts at the event's day start hour in its own zone: just before counts the day before", async () => {
      const [clock] = await owner<{ zone: string; hour: number }>(
        `SELECT z.zone, extract(hour FROM now() AT TIME ZONE z.zone)::int AS hour
         FROM (VALUES ('Asia/Riyadh'), ('UTC')) z(zone)
         WHERE extract(hour FROM now() AT TIME ZONE z.zone) < 23 LIMIT 1`,
      );
      const zone = clock?.zone ?? "UTC";
      const hour = clock?.hour ?? 0;
      // Day start at this hour: the moment is after it (today). One hour later: the moment is before it (yesterday).
      for (const [start, shift] of [
        [hour, 0],
        [hour + 1, -1],
      ] as const) {
        const ev = await newEvent({ timezone: zone, dayStart: start });
        const target = await quest(ev);
        const who = await member(ev.id);
        await complete(who.player, target);
        const [expected] = await owner<{ d: string }>(
          "SELECT ((now() AT TIME ZONE $1)::date + $2::int)::text AS d",
          [zone, shift],
        );
        expect(
          (await rowsOf(who)).map((row) => row.day),
          `day start ${start}`,
        ).toEqual([expected?.d]);
      }
    });

    it("writes nothing before the event's start or after its end, and does inside its window", async () => {
      const ev = await newEvent({ singleDay: true });
      const target = await quest(ev);
      const who = await member(ev.id);
      await complete(who.player, target);
      expect(await rowsOf(who)).toEqual([]);
      const record = () =>
        owner(
          "SELECT streak_record(l) FROM ledger_entry l WHERE l.enrollment_id = $1 AND l.kind = 'quest'",
          [who.enrollment],
        );
      await owner(
        "UPDATE event SET starts_at = now() + interval '1 hour', ends_at = now() + interval '3 days' WHERE id = $1",
        [ev.id],
      );
      await record();
      expect(await rowsOf(who)).toEqual([]);
      await owner(
        "UPDATE event SET starts_at = now() - interval '3 days', ends_at = now() - interval '1 minute' WHERE id = $1",
        [ev.id],
      );
      await record();
      expect(await rowsOf(who)).toEqual([]);
      await owner("UPDATE event SET ends_at = now() + interval '3 days' WHERE id = $1", [ev.id]);
      await record();
      expect(await rowsOf(who)).toHaveLength(1);
    });

    it("a single-day event writes nothing", async () => {
      const ev = await newEvent({ singleDay: true });
      await configure(ev, { bonus: BONUS });
      const target = await quest(ev);
      const who = await member(ev.id);
      await complete(who.player, target);
      await complete(who.player, target);
      expect(await rowsOf(who)).toEqual([]);
      expect(await bonusesOf(who)).toEqual([]);
    });

    it("repeats on one day leave one row, naming the day's first completion", async () => {
      const ev = await newEvent();
      const target = await quest(ev);
      const who = await member(ev.id);
      const [first] = await complete(who.player, target);
      await complete(who.player, target);
      await complete(who.player, target);
      expect((await rowsOf(who)).map((row) => row.completion_id)).toEqual([first?.completion_id]);
    });

    it("rows are written while the streak is off, so switching it on mid-event shows the true length", async () => {
      const ev = await newEvent();
      const target = await quest(ev);
      const who = await member(ev.id);
      await complete(who.player, target);
      expect((await rowsOf(who)).map((row) => row.days)).toEqual([1]);
      const later = await member(ev.id);
      await history(ev, later, 2);
      await configure(ev, { bonus: BONUS });
      await complete(later.player, target);
      expect((await todayRow(ev, later))?.days).toBe(3);
      expect(await bonusesOf(later)).toHaveLength(1);
    });
  });

  // ============================================================ the bonus (FR-418)
  describe("the bonus (ADR-296, FR-418)", () => {
    it("pays nothing while off or without an amount; with one: none on day 1, then one flat bonus a day", async () => {
      const cases = [
        { settings: null, history: 1, paid: [] },
        { settings: { enabled: false, bonus: BONUS }, history: 1, paid: [] },
        { settings: { bonus: null }, history: 1, paid: [] },
        { settings: { bonus: BONUS }, history: 0, paid: [] },
        { settings: { bonus: BONUS }, history: 1, paid: [String(BONUS)] },
        { settings: { bonus: BONUS }, history: 2, paid: [String(BONUS)] },
      ] as const;
      for (const [index, one] of cases.entries()) {
        const ev = await newEvent();
        if (one.settings !== null) await configure(ev, one.settings);
        const target = await quest(ev);
        const who = await member(ev.id);
        await history(ev, who, one.history);
        await complete(who.player, target);
        await complete(who.player, target);
        expect(
          (await bonusesOf(who)).map((row) => row.score_delta),
          `case ${index}`,
        ).toEqual(one.paid);
      }
    });

    it("the day's first completion carries it, the answer's score holds it, the balance moves with it", async () => {
      const ev = await newEvent();
      await configure(ev, { bonus: BONUS });
      const target = await quest(ev, { points: 10 });
      const who = await member(ev.id);
      await history(ev, who, 1);
      const [paid] = await complete(who.player, target);
      expect(paid).toMatchObject({ points: "10", score: "15", balance: "15" });
      const [bonus] = await bonusesOf(who);
      expect(bonus).toMatchObject({
        completion_id: paid?.completion_id,
        score_delta: "5",
        balance_delta: "5",
      });
      expect((await todayRow(ev, who))?.entry_id).toBe(bonus?.id);
      const [own] = await f.asPlayer(who.player, "SELECT * FROM own_streak_bonus($1)", [
        paid?.completion_id,
      ]);
      expect(own).toEqual({ points: 5, days: 2 });
      // A replay answers the same, and another player's view of it is empty.
      const other = await member(ev.id);
      expect(
        await f.asPlayer(other.player, "SELECT * FROM own_streak_bonus($1)", [paid?.completion_id]),
      ).toEqual([]);
    });

    it("is never boosted and pays no XP", async () => {
      const ev = await newEvent();
      await configure(ev, { bonus: BONUS });
      const target = await quest(ev, { points: 10 });
      await owner(
        `INSERT INTO boost (organizer_id, event_id, category_id, starts_at, ends_at)
         VALUES ($1, $2, $3, now() - interval '5 minutes', now() + interval '1 hour')`,
        [f.ids.orgA, ev.id, ev.category],
      );
      const who = await member(ev.id);
      await history(ev, who, 1);
      const [paid] = await complete(who.player, target);
      expect(paid?.points).toBe("20");
      const [bonus] = await owner<{ score_delta: string; boost_id: string | null; id: string }>(
        "SELECT id, score_delta, boost_id FROM ledger_entry WHERE enrollment_id = $1 AND kind = 'streak'",
        [who.enrollment],
      );
      expect(bonus).toMatchObject({ score_delta: "5", boost_id: null });
      expect(await owner("SELECT 1 FROM xp_entry WHERE ledger_entry_id = $1", [bonus?.id])).toEqual(
        [],
      );
      expect(
        await owner<{ xp: string }>("SELECT xp FROM player_xp WHERE player_id = $1", [who.player]),
      ).toEqual([{ xp: "100" }]);
    });

    it("counts in today's ranking and in a community points goal", async () => {
      const ev = await newEvent();
      await configure(ev, { bonus: BONUS });
      const target = await quest(ev, { points: 10 });
      const who = await member(ev.id);
      await history(ev, who, 1);
      await complete(who.player, target);
      const [ranked] = await owner<{ score: string }>(
        "SELECT r.score FROM ranked_day($1, event_day(now(), (SELECT e FROM event e WHERE e.id = $1))) r WHERE r.id = $2",
        [ev.id, who.enrollment],
      );
      expect(ranked?.score).toBe("15");
      const [goal] = await owner<{ id: string }>(
        `INSERT INTO community_goal (organizer_id, event_id, title_en, measure, target, starts_at, ends_at)
         VALUES ($1, $2, 'Together', 'points', 1000, now() - interval '1 day', now() + interval '1 day')
         RETURNING id`,
        [f.ids.orgA, ev.id],
      );
      const [slice] = await owner<{ settled: string }>(
        `SELECT s.settled FROM community_goal g,
                community_read_slice(g, g.ends_at, g.starts_at, now() + interval '1 minute',
                                     now() + interval '1 minute') s
         WHERE g.id = $1 AND s.enrollment_id = $2`,
        [goal?.id, who.enrollment],
      );
      expect(slice?.settled).toBe("15");
    });

    it("an amount change applies to later days only", async () => {
      const ev = await newEvent();
      await configure(ev, { bonus: BONUS });
      const target = await quest(ev);
      const early = await member(ev.id);
      await history(ev, early, 1);
      await complete(early.player, target);
      await configure(ev, { bonus: 9 });
      const late = await member(ev.id);
      await history(ev, late, 1);
      await complete(late.player, target);
      await complete(early.player, target);
      expect((await bonusesOf(early)).map((row) => row.score_delta)).toEqual(["5"]);
      expect((await bonusesOf(late)).map((row) => row.score_delta)).toEqual(["9"]);
    });

    it("the shape CHECK refuses forged rows and a second bonus for one completion", async () => {
      const ev = await newEvent();
      const target = await quest(ev);
      const who = await member(ev.id);
      const [paid] = await complete(who.player, target);
      const forge = (fields: string, values: string) =>
        refusal(
          owner(
            `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, ${fields})
             VALUES ($1, $2, $3, 'streak', ${values})`,
            [f.ids.orgA, ev.id, who.enrollment, paid?.completion_id, target],
          ),
        );
      const shape = "score_delta, balance_delta, completion_id, quest_id, actor";
      expect(await forge(shape, "5, 5, $4, $5, 'player'")).toBe("23514");
      expect(await forge(shape, "0, 0, $4, $5, 'system'")).toBe("23514");
      expect(await forge(shape, "5, 3, $4, $5, 'system'")).toBe("23514");
      expect(await forge(shape, "5, 5, $4, nullif($5::uuid, $5::uuid), 'system'")).toBe("23514");
      expect(await forge(`${shape}, category_id`, `5, 5, $4, $5, 'system', '${ev.category}'`)).toBe(
        "23514",
      );
      expect(await forge(shape, "5, 0, $4, $5, 'system'")).toBe("none");
      expect(await forge(shape, "5, 5, $4, $5, 'system'")).toBe("23505");
    });

    it("rehearsal accounts and an operator's practice scan write nothing", async () => {
      const rehearsing = await newEvent({ status: "scheduled", startedDaysAgo: -1, endsInDays: 4 });
      await owner("UPDATE event SET starts_at = now() + interval '30 minutes' WHERE id = $1", [
        rehearsing.id,
      ]);
      counter += 1;
      await owner(
        "INSERT INTO event_rehearsal (event_id, organizer_id, code) VALUES ($1, $2, $3)",
        [
          rehearsing.id,
          f.ids.orgA,
          `ST${LETTERS[counter % 24]}${LETTERS[Math.floor(counter / 24) % 24]}-STRK`,
        ],
      );
      await configure(rehearsing, { bonus: BONUS });
      const target = await quest(rehearsing);
      const trial = await member(rehearsing.id, "rehearsal");
      await complete(trial.player, target);
      expect(await rowsOf(trial)).toEqual([]);
      expect(
        await owner("SELECT 1 FROM questify_streak_day WHERE player_id = $1", [trial.player]),
      ).toEqual([]);

      const ev = await newEvent();
      await configure(ev, { bonus: BONUS });
      const scanned = await quest(ev, { verification: ["quest_qr", "my_qr"] });
      const desk = await member(ev.id);
      await owner(
        `INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities, can_play)
         VALUES ($1, $2, $3, '{scan_quests}', true)`,
        [f.ids.orgA, ev.id, desk.player],
      );
      const who = await member(ev.id);
      await history(ev, who, 1);
      const [practice] = await f.asPlayer<{ outcome: string }>(
        desk.player,
        "SELECT * FROM operator_practice_scan($1, $2, 1)",
        [scanned, who.player],
      );
      expect(practice?.outcome).toBe("completed");
      expect(await todayRow(ev, who)).toBeUndefined();
      expect(await bonusesOf(who)).toEqual([]);
      await complete(who.player, scanned);
      expect(await bonusesOf(who)).toHaveLength(1);
    });
  });

  // ============================================================ the door table
  type DoorContext = { ev: Ev; quest: string; who: Member; extra: Record<string, string> };
  type Door = Readonly<{
    name: string;
    type: string;
    config?: object;
    verification?: string[];
    pay: (c: DoorContext) => Promise<unknown>;
    /** The other side of a meet, who is paid too. */
    both?: boolean;
  }>;
  const screenWindow = async () =>
    (await owner<{ w: number }>("SELECT screen_window_of(now()) AS w"))[0]?.w ?? 0;
  const pairKiosk = async (event: string, target: string) => {
    const pending = { secret: randomBytes(32), code: randomBytes(32) };
    await f.run({}, "SELECT * FROM open_device_request($1, $2, 'kiosk', 'Safari on iPadOS')", [
      pending.secret,
      pending.code,
    ]);
    const [row] = await f.run<{ id: string }>(
      f.team(),
      "SELECT team_claim_device($1, $2, 'kiosk', $3, 'Gate tablet', $4) AS id",
      [pending.code, event, target, randomUUID()],
    );
    await f.run({}, "SELECT activate_device($1, $2)", [pending.secret, randomBytes(32)]);
    return row?.id ?? "";
  };
  const DOORS: readonly Door[] = [
    { name: "QR scan", type: "scan_qr", pay: (c) => complete(c.who.player, c.quest) },
    {
      name: "typed code",
      type: "enter_code",
      config: { code: "TOWER" },
      pay: (c) =>
        f.asPlayer(
          c.who.player,
          "SELECT * FROM complete_quest($1, 'code', NULL, 'TOWER', $2, NULL)",
          [c.quest, randomUUID()],
        ),
    },
    {
      name: "kiosk",
      type: "scan_qr",
      verification: ["kiosk"],
      pay: async (c) =>
        f.run(
          { deviceId: await pairKiosk(c.ev.id, c.quest) },
          "SELECT * FROM kiosk_complete_quest($1, $2, $3)",
          [c.who.player, await screenWindow(), randomUUID()],
        ),
    },
    {
      name: "my-QR (an operator scanning the player)",
      type: "scan_qr",
      verification: ["my_qr"],
      pay: async (c) => {
        const desk = await member(c.ev.id);
        await owner(
          `INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities, can_play)
           VALUES ($1, $2, $3, '{scan_quests}', true)`,
          [f.ids.orgA, c.ev.id, desk.player],
        );
        return f.asPlayer(desk.player, "SELECT * FROM operator_complete_quest($1, $2, 1, $3)", [
          c.quest,
          c.who.player,
          randomUUID(),
        ]);
      },
    },
    {
      name: "submission (at its approval)",
      type: "submission",
      config: { accepts: ["text"], autoApprove: false, resubmit: false },
      pay: async (c) => {
        const [sent] = await f.asPlayer<{ submission_id: string }>(
          c.who.player,
          "SELECT * FROM submit_quest($1, 'My answer', $2, $3)",
          [c.quest, GUIDELINES, randomUUID()],
        );
        expect(await bonusesOf(c.who)).toEqual([]);
        return f.run(
          f.team(),
          "SELECT * FROM staff_review_submission($1, $2, 'approve', NULL, $3, $4)",
          [c.ev.id, sent?.submission_id, randomUUID(), randomUUID()],
        );
      },
    },
    {
      name: "quiz (at its finish)",
      type: "quiz",
      config: QUIZ,
      pay: async (c) => {
        await f.asPlayer(c.who.player, "SELECT quiz_start($1)", [c.quest]);
        await f.asPlayer(c.who.player, "SELECT quiz_next($1)", [c.quest]);
        return f.asPlayer(c.who.player, "SELECT quiz_answer($1, 'q1', 'r')", [c.quest]);
      },
    },
    {
      name: "mini-game (at its result)",
      type: "game",
      config: GAME,
      pay: async (c) => {
        const [round] = await f.asPlayer<{ round_id: string }>(
          c.who.player,
          "SELECT * FROM start_game_round($1, $2, NULL, 1)",
          [c.quest, randomUUID()],
        );
        return f.asPlayer(
          c.who.player,
          "SELECT * FROM finish_game_round($1, $2, 'passed', $3, NULL, false, 0)",
          [round?.round_id, randomUUID(), JSON.stringify(PASS)],
        );
      },
    },
    {
      name: "passport's final stamp",
      type: "passport",
      config: { needed: 1 },
      verification: [],
      pay: async (c) => {
        const [step] = await owner<{ id: string }>(
          "SELECT id FROM passport_step WHERE quest_id = $1",
          [c.quest],
        );
        return f.asPlayer(c.who.player, "SELECT * FROM stamp_step($1, 1, $2, NULL)", [
          step?.id,
          randomUUID(),
        ]);
      },
    },
    {
      name: "meet (both sides)",
      type: "meet",
      config: { dailyCap: 5 },
      both: true,
      pay: async (c) => {
        const shown = await member(c.ev.id);
        await history(c.ev, shown, 1);
        c.extra["shown"] = shown.enrollment;
        const hash = randomBytes(32);
        await f.asPlayer(shown.player, "SELECT * FROM issue_meet_pass($1, $2, NULL)", [
          c.quest,
          hash,
        ]);
        return f.asPlayer(c.who.player, "SELECT * FROM meet_player($1, $2, NULL, NULL)", [
          hash,
          randomUUID(),
        ]);
      },
    },
    {
      name: "the team's quest award",
      type: "scan_qr",
      pay: (c) =>
        f.run(f.team(), "SELECT * FROM staff_award($1, $2, $3, NULL, 'Helped', $4, $5)", [
          c.ev.id,
          c.who.enrollment,
          c.quest,
          randomUUID(),
          randomUUID(),
        ]),
    },
  ];

  describe("every door pays it with the day's first completion (the trigger on the quest entry)", () => {
    for (const door of DOORS) {
      it(door.name, async () => {
        const ev = await newEvent();
        await configure(ev, { bonus: BONUS });
        const target = await quest(ev, {
          type: door.type,
          config: door.config ?? {},
          ...(door.verification === undefined ? {} : { verification: door.verification }),
        });
        const c: DoorContext = { ev, quest: target, who: await member(ev.id), extra: {} };
        await history(ev, c.who, 1);
        await door.pay(c);
        const bonuses = await bonusesOf(c.who);
        expect(bonuses.map((row) => row.score_delta)).toEqual(["5"]);
        const row = await todayRow(ev, c.who);
        expect(row).toMatchObject({ days: 2, entry_id: bonuses[0]?.id });
        const [paying] = await owner<{ completion_id: string }>(
          "SELECT completion_id FROM ledger_entry WHERE enrollment_id = $1 AND kind = 'quest' AND quest_id = $2",
          [c.who.enrollment, target],
        );
        expect(bonuses[0]?.completion_id).toBe(paying?.completion_id);
        if (door.both === true) {
          const shown = { player: "", enrollment: c.extra["shown"] ?? "" };
          expect((await bonusesOf(shown)).map((one) => one.score_delta)).toEqual(["5"]);
        }
      });
    }
  });

  // ============================================================ which day (MAJOR-2, ADR-301)
  describe("which day a completion counts for (ADR-301)", () => {
    it("a submission sent on an earlier day and approved today counts today only", async () => {
      const ev = await newEvent();
      await configure(ev, { bonus: BONUS });
      const target = await quest(ev, {
        type: "submission",
        config: { accepts: ["text"], autoApprove: false, resubmit: false },
      });
      const who = await member(ev.id);
      await seedDay(ev, who, -2, 1);
      const [sent] = await f.asPlayer<{ submission_id: string }>(
        who.player,
        "SELECT * FROM submit_quest($1, 'My answer', $2, $3)",
        [target, GUIDELINES, randomUUID()],
      );
      await owner("UPDATE submission SET created_at = now() - interval '1 day' WHERE id = $1", [
        sent?.submission_id,
      ]);
      await f.run(
        f.team(),
        "SELECT * FROM staff_review_submission($1, $2, 'approve', NULL, $3, $4)",
        [ev.id, sent?.submission_id, randomUUID(), randomUUID()],
      );
      expect((await rowsOf(who)).map((row) => [row.day, row.days])).toEqual([
        [await dayOf(ev, -2), 1],
        [await dayOf(ev), 1],
      ]);
      expect(await bonusesOf(who)).toEqual([]);
    });

    it("a quiz started on an earlier day and finished today counts today", async () => {
      const ev = await newEvent();
      await configure(ev, { bonus: BONUS });
      const target = await quest(ev, { type: "quiz", config: QUIZ });
      const who = await member(ev.id);
      await history(ev, who, 1);
      await f.asPlayer(who.player, "SELECT quiz_start($1)", [target]);
      await owner(
        "UPDATE quiz_attempt SET started_at = now() - interval '1 day' WHERE enrollment_id = $1",
        [who.enrollment],
      );
      await f.asPlayer(who.player, "SELECT quiz_next($1)", [target]);
      await f.asPlayer(who.player, "SELECT quiz_answer($1, 'q1', 'r')", [target]);
      expect((await rowsOf(who)).map((row) => [row.day, row.days])).toEqual([
        [await dayOf(ev, -1), 1],
        [await dayOf(ev), 2],
      ]);
    });

    it("the team's manual quest award as the day's first completion counts the day and pays the bonus", async () => {
      const ev = await newEvent();
      await configure(ev, { bonus: BONUS });
      const target = await quest(ev);
      const who = await member(ev.id);
      await history(ev, who, 2);
      const desk = await member(ev.id);
      await owner(
        `INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities, can_play)
         VALUES ($1, $2, $3, '{award}', true)`,
        [f.ids.orgA, ev.id, desk.player],
      );
      await f.asPlayer(
        desk.player,
        "SELECT * FROM operator_award($1, $2, $3, NULL, 'Code failed', $4)",
        [ev.id, who.enrollment, target, randomUUID()],
      );
      expect((await todayRow(ev, who))?.days).toBe(3);
      expect((await bonusesOf(who)).map((row) => row.score_delta)).toEqual(["5"]);
    });
  });

  // ============================================================ append-only and the boundary race (MAJOR-1, MINOR-5)
  describe("the append-only day row and the day boundary", () => {
    it("refuses UPDATE, DELETE and TRUNCATE for every role, the owner included", async () => {
      const ev = await newEvent();
      const target = await quest(ev);
      const who = await member(ev.id);
      await complete(who.player, target);
      for (const sql of [
        "UPDATE event_streak_day SET days = 9 WHERE enrollment_id = $1",
        "DELETE FROM event_streak_day WHERE enrollment_id = $1",
      ]) {
        expect(await refusal(owner(sql, [who.enrollment])), sql).toBe("42501");
      }
      expect(await refusal(owner("TRUNCATE event_streak_day CASCADE"))).toBe("42501");
      expect(await rowsOf(who)).toHaveLength(1);
    });

    it("writes the day row once, by a plain INSERT with the bonus already named (no UPDATE ever reaches it)", async () => {
      const ev = await newEvent();
      await configure(ev, { bonus: BONUS });
      const target = await quest(ev);
      const who = await member(ev.id);
      await history(ev, who, 1);
      // A trigger that refuses any UPDATE of the table would fail the completion if the writer updated its row.
      await owner(
        `CREATE OR REPLACE FUNCTION test_no_streak_update() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN RAISE EXCEPTION 'updated'; END $$`,
      );
      await owner(
        `CREATE TRIGGER a_test_no_update BEFORE UPDATE ON event_streak_day FOR EACH ROW
         EXECUTE FUNCTION test_no_streak_update()`,
      );
      try {
        await complete(who.player, target);
      } finally {
        await owner("DROP TRIGGER a_test_no_update ON event_streak_day");
      }
      expect(await todayRow(ev, who)).toMatchObject({ days: 2 });
      expect((await todayRow(ev, who))?.entry_id).not.toBeNull();
    });

    it("a payment whose transaction started before the day boundary, after a row for the new day, writes nothing", async () => {
      const ev = await newEvent();
      await configure(ev, { bonus: BONUS });
      const target = await quest(ev);
      const who = await member(ev.id);
      await seedDay(ev, who, -1, 1);
      // The row of the later day exists: this payment's `now()` is the earlier day's.
      await seedDay(ev, who, 1, 2);
      await complete(who.player, target);
      expect((await rowsOf(who)).map((row) => row.day)).toEqual([
        await dayOf(ev, -1),
        await dayOf(ev, 1),
      ]);
      expect(await bonusesOf(who)).toEqual([]);
    });

    it("a second row for the same day or the same completion fails on the unique keys", async () => {
      const ev = await newEvent();
      const target = await quest(ev);
      const who = await member(ev.id);
      const [paid] = await complete(who.player, target);
      expect(await refusal(seedDay(ev, who, 0, 1))).toBe("23505");
      expect(
        await refusal(
          owner(
            `INSERT INTO event_streak_day (enrollment_id, day, organizer_id, event_id, days, completion_id)
             VALUES ($1, current_date + 30, $2, $3, 1, $4)`,
            [who.enrollment, f.ids.orgA, ev.id, paid?.completion_id],
          ),
        ),
      ).toBe("23505");
    });
  });

  // ============================================================ removal
  describe("removal", () => {
    it("removes the bonus line alone, writing no XP row; the day stays and is never paid again", async () => {
      const { ev, target, who, bonus } = await paidMember();
      const key = randomUUID();
      const [removed] = await remove(ev, bonus, key);
      expect(removed?.replayed).toBe(false);
      expect((await remove(ev, bonus, key))[0]).toMatchObject({ replayed: true });
      expect(await scoreOf(who)).toBe(10);
      expect(await xpOf(who.player)).toBe("100");
      expect(
        await owner("SELECT 1 FROM xp_entry WHERE ledger_entry_id = $1", [removed?.entry_id]),
      ).toEqual([]);
      expect((await todayRow(ev, who))?.entry_id).toBe(bonus);
      await complete(who.player, target);
      expect(await bonusesOf(who)).toHaveLength(1);
    });

    it("removing the quest line leaves the day and the bonus", async () => {
      const { ev, who, bonus } = await paidMember();
      const [line] = await owner<{ id: string }>(
        "SELECT id FROM ledger_entry WHERE enrollment_id = $1 AND kind = 'quest'",
        [who.enrollment],
      );
      await remove(ev, line?.id ?? "");
      expect(await scoreOf(who)).toBe(5);
      expect(await xpOf(who.player)).toBe("0");
      expect((await todayRow(ev, who))?.entry_id).toBe(bonus);
      expect(await owner("SELECT 1 FROM ledger_entry WHERE reverses = $1", [bonus])).toEqual([]);
    });

    it("the team's record and the player's history name the streak day; a quest's earned leaves it out", async () => {
      const { ev, target, who, bonus } = await paidMember();
      const [line] = await f.run<{ kind: string; streak_days: number; removable: boolean }>(
        f.team(),
        "SELECT kind, streak_days, removable FROM member_ledger($1, $2, NULL, 50) WHERE id = $3",
        [ev.id, who.enrollment, bonus],
      );
      expect(line).toEqual({ kind: "streak", streak_days: 2, removable: true });
      const activity = await f.asPlayer<{ kind: string; streak_days: number | null }>(
        who.player,
        "SELECT kind, streak_days FROM member_activity($1, NULL, 25)",
        [ev.id],
      );
      expect(activity).toEqual([
        { kind: "streak", streak_days: 2 },
        { kind: "quest", streak_days: null },
      ]);
      const earned = async () =>
        (
          await f.asPlayer<{ earned: string }>(
            who.player,
            "SELECT earned FROM member_event_quests($1) WHERE quest_id = $2",
            [ev.id, target],
          )
        )[0]?.earned;
      expect(await earned()).toBe("10");
      await remove(ev, bonus);
      expect(await earned()).toBe("10");
    });
  });

  // ============================================================ the settings door (ADR-295, ADR-299)
  describe("the owner-only settings door", () => {
    it("sets, reads back, answers unchanged on the same settings, and audits each change", async () => {
      const ev = await newEvent({ startedDaysAgo: 1, endsInDays: 9 });
      expect(await settingsOf(ev)).toEqual({
        enabled: false,
        bonusPoints: null,
        closedWeekdays: [],
        closedDays: [],
        multiDay: true,
        today: await dayOf(ev),
      });
      const later = [await dayOf(ev, 3), await dayOf(ev, 2)];
      const body = { enabled: true, bonus: 25, weekdays: [], dates: [...later, later[0] ?? ""] };
      expect(await setStreak(ev, body)).toBe("set");
      expect(await settingsOf(ev)).toMatchObject({
        enabled: true,
        bonusPoints: 25,
        closedDays: later.toSorted(),
      });
      expect(await setStreak(ev, body)).toBe("unchanged");
      expect(await setStreak(ev, { ...body, bonus: 30 })).toBe("set");
      const rows = await audits(ev);
      expect(rows.map((row) => [row.before === null, row.after["bonusPoints"]])).toEqual([
        [true, 25],
        [false, 30],
      ]);
    });

    it("refuses an editor and another organizer as a missing event, writing nothing", async () => {
      const ev = await newEvent();
      const editor = await addMember(f.db.owner, f.ids.orgA, "editor");
      const editorSeat = { organizerId: f.ids.orgA, staffUserId: editor };
      expect(await refusal(setStreak(ev, { ...off, enabled: true }, editorSeat))).toBe("AN404");
      expect(await settingsOf(ev, editorSeat)).toMatchObject({ enabled: false });
      const ownerB = await addMember(f.db.owner, f.ids.orgB, "owner");
      const seatB = { organizerId: f.ids.orgB, staffUserId: ownerB };
      expect(await refusal(setStreak(ev, { ...off, enabled: true }, seatB))).toBe("AN404");
      expect(await refusal(settingsOf(ev, seatB))).toBe("AN404");
      expect(await owner("SELECT 1 FROM event_streak WHERE event_id = $1", [ev.id])).toEqual([]);
    });

    it("refuses a single-day event, final results and an archived event", async () => {
      const single = await newEvent({ singleDay: true });
      expect(await refusal(setStreak(single, off))).toBe("ST409:single_day");
      const final = await newEvent();
      await owner("INSERT INTO event_result (event_id, organizer_id) VALUES ($1, $2)", [
        final.id,
        f.ids.orgA,
      ]);
      expect(await refusal(setStreak(final, off))).toBe("RF409:results_final");
      const archived = await newEvent({ status: "archived" });
      expect(await refusal(setStreak(archived, off))).toBe("ST409:archived");
    });

    it("waits for a results confirmation in flight and then sees the results final", async () => {
      const ev = await newEvent();
      // The door's settings read first: a pooled connection is open before the owner's transaction starts.
      await f.run(f.team(), "SELECT event_streak_settings($1)", [ev.id]);
      const confirming = f.db.owner;
      await confirming.query("BEGIN");
      let pending: Promise<string> | undefined;
      try {
        await confirming.query("SELECT 1 FROM event WHERE id = $1 FOR UPDATE", [ev.id]);
        await confirming.query(
          "INSERT INTO event_result (event_id, organizer_id) VALUES ($1, $2)",
          [ev.id, f.ids.orgA],
        );
        pending = refusal(setStreak(ev, { ...off, enabled: true }));
        let waited = false;
        for (let attempt = 0; attempt < 200 && !waited; attempt += 1) {
          // Inside its own transaction this connection would keep its first activity snapshot.
          await confirming.query("SELECT pg_stat_clear_snapshot()");
          const rows = await confirming.query(
            `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
               AND query LIKE '%set_event_streak%'`,
          );
          waited = rows.rows.length > 0;
          if (!waited) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(waited).toBe(true);
        await confirming.query("COMMIT");
      } catch (error) {
        await confirming.query("ROLLBACK");
        throw error;
      }
      expect(await pending).toBe("RF409:results_final");
      expect(await owner("SELECT 1 FROM event_streak WHERE event_id = $1", [ev.id])).toEqual([]);
    });

    it("refuses a change to a closed date that has started, today included; accepts a later one", async () => {
      const ev = await newEvent({ startedDaysAgo: 2 });
      for (const offset of [-1, 0]) {
        const day = await dayOf(ev, offset);
        const attempt = setStreak(ev, { ...off, dates: [day] });
        await expect(attempt).rejects.toMatchObject({
          code: "ST409",
          detail: "day_started",
          hint: day,
        });
      }
      expect(await setStreak(ev, { ...off, dates: [await dayOf(ev, 1)] })).toBe("set");
      // Removing a later closed date is a change too, accepted while it has not started.
      expect(await setStreak(ev, off)).toBe("set");
    });

    it("refuses a closed weekday that a started day fell on; accepts one before its first occurrence", async () => {
      const ev = await newEvent({ startedDaysAgo: 1, endsInDays: 4 });
      for (const offset of [-1, 0]) {
        await expect(
          setStreak(ev, { ...off, weekdays: [await weekdayOf(ev, offset)] }),
        ).rejects.toMatchObject({ code: "ST409", detail: "day_started" });
      }
      const ahead = await weekdayOf(ev, 2);
      expect(await setStreak(ev, { ...off, weekdays: [ahead] })).toBe("set");
      expect(await settingsOf(ev)).toMatchObject({ closedWeekdays: [ahead] });
    });

    it("refuses fields out of range, naming the field", async () => {
      const ev = await newEvent({ startedDaysAgo: 1, endsInDays: 4 });
      const cases: [Parameters<typeof setStreak>[1], string][] = [
        [{ ...off, enabled: null }, "ST422:enabled"],
        [{ ...off, bonus: 0 }, "ST422:bonusPoints"],
        [{ ...off, bonus: 100001 }, "ST422:bonusPoints"],
        [{ ...off, weekdays: [0] }, "ST422:closedWeekdays"],
        [{ ...off, weekdays: [8] }, "ST422:closedWeekdays"],
        [{ ...off, weekdays: [3, 3] }, "ST422:closedWeekdays"],
        [{ ...off, weekdays: [1, 2, 3, 4, 5, 6, 7] }, "ST422:closedWeekdays"],
        [{ ...off, dates: [await dayOf(ev, 30)] }, "ST422:closedDays"],
        [{ ...off, dates: [await dayOf(ev, -5)] }, "ST422:closedDays"],
      ];
      for (const [body, expected] of cases) {
        expect(await refusal(setStreak(ev, body)), JSON.stringify(body)).toBe(expected);
      }
      expect(await setStreak(ev, { ...off, bonus: 100000 })).toBe("set");
    });

    it("a single-day event extended to multi-day mid-event counts from the next completion only", async () => {
      const ev = await newEvent({ singleDay: true });
      const target = await quest(ev);
      const who = await member(ev.id);
      await complete(who.player, target);
      expect(await rowsOf(who)).toEqual([]);
      await owner("UPDATE event SET ends_at = now() + interval '3 days' WHERE id = $1", [ev.id]);
      expect(await setStreak(ev, { ...off, enabled: true, bonus: BONUS })).toBe("set");
      await complete(who.player, target);
      expect((await rowsOf(who)).map((row) => row.days)).toEqual([1]);
      expect(await bonusesOf(who)).toEqual([]);
    });
  });

  // ============================================================ concurrency
  describe("crossed locks", () => {
    it("two completions of one enrollment on one day on two connections: one row, one bonus", async () => {
      const ev = await newEvent();
      await configure(ev, { bonus: BONUS });
      const target = await quest(ev);
      const who = await member(ev.id);
      await history(ev, who, 1);
      const call = () => ({
        context: as(who.player),
        sql: "SELECT * FROM complete_quest($1, 'qr', 1, NULL, $2, NULL)",
        values: [target, randomUUID()],
      });
      const outcome = await f.crossed(call(), call());
      expect(outcome.waited).toBe(true);
      expect(outcome.second).not.toBeInstanceOf(Error);
      expect(await rowsOf(who)).toHaveLength(2);
      expect(await bonusesOf(who)).toHaveLength(1);
    });

    it("a meet of A and B crossing B's own scan of another quest, both orders: no deadlock, each paid once", async () => {
      for (const meetFirst of [true, false]) {
        const ev = await newEvent();
        await configure(ev, { bonus: BONUS });
        const meet = await quest(ev, { type: "meet", config: { dailyCap: 5 } });
        const other = await quest(ev);
        const a = await member(ev.id);
        const b = await member(ev.id);
        await history(ev, a, 1);
        await history(ev, b, 1);
        const hash = randomBytes(32);
        await f.asPlayer(b.player, "SELECT * FROM issue_meet_pass($1, $2, NULL)", [meet, hash]);
        const meeting = {
          context: as(a.player),
          sql: "SELECT * FROM meet_player($1, $2, NULL, NULL)",
          values: [hash, randomUUID()],
        };
        const scan = {
          context: as(b.player),
          sql: "SELECT * FROM complete_quest($1, 'qr', 1, NULL, $2, NULL)",
          values: [other, randomUUID()],
        };
        const outcome = meetFirst ? await f.crossed(meeting, scan) : await f.crossed(scan, meeting);
        expect(outcome.waited, `meet first: ${meetFirst}`).toBe(true);
        expect(outcome.second).not.toBeInstanceOf(Error);
        expect(await bonusesOf(a)).toHaveLength(1);
        expect(await bonusesOf(b)).toHaveLength(1);
        expect((await todayRow(ev, b))?.days).toBe(2);
      }
    });

    it("one player's first completions of the day in two events at once, both orders: one Questify day, no deadlock", async () => {
      for (let round = 0; round < 2; round += 1) {
        const one = await newEvent();
        const two = await newEvent();
        const player = await f.newPlayer();
        await f.join(one.id, player);
        await f.join(two.id, player);
        const first = await quest(round === 0 ? one : two);
        const second = await quest(round === 0 ? two : one);
        const call = (target: string) => ({
          context: as(player),
          sql: "SELECT * FROM complete_quest($1, 'qr', 1, NULL, $2, NULL)",
          values: [target, randomUUID()],
        });
        const outcome = await f.crossed(call(first), call(second));
        expect(outcome.waited, `round ${round}`).toBe(true);
        expect(outcome.second).not.toBeInstanceOf(Error);
        expect(
          await owner("SELECT day FROM questify_streak_day WHERE player_id = $1", [player]),
        ).toHaveLength(1);
        expect(
          await owner<{ xp: string }>("SELECT xp FROM player_xp WHERE player_id = $1", [player]),
        ).toEqual([{ xp: "200" }]);
      }
    });

    it("an erasure crossing a completion that writes both day rows, both orders: no deadlock, nothing after it", async () => {
      for (const completionFirst of [true, false]) {
        const ev = await newEvent();
        await configure(ev, { bonus: BONUS });
        const target = await quest(ev);
        const who = await member(ev.id);
        await history(ev, who, 1);
        const scan = {
          context: as(who.player),
          sql: "SELECT * FROM complete_quest($1, 'qr', 1, NULL, $2, NULL)",
          values: [target, randomUUID()],
        };
        const erase = {
          context: {},
          sql: "SELECT * FROM erase_player($1, true, $2)",
          values: [await f.deletionToken(who.player), randomUUID()],
        };
        const outcome = completionFirst
          ? await f.crossed(scan, erase)
          : await f.crossed(erase, scan);
        expect(outcome.waited, `completion first: ${completionFirst}`).toBe(true);
        const days = await owner("SELECT 1 FROM questify_streak_day WHERE player_id = $1", [
          who.player,
        ]);
        if (completionFirst) {
          expect(outcome.second).toMatchObject({ outcome: "erased" });
          expect(await todayRow(ev, who)).toMatchObject({ days: 2 });
          expect(days).toHaveLength(1);
        } else {
          expect(outcome.second).toBeInstanceOf(Error);
          expect(await todayRow(ev, who)).toBeUndefined();
          expect(days).toEqual([]);
        }
      }
    });

    it("the settings door crossing a burst of completions: neither waits on the other", async () => {
      const ev = await newEvent({ startedDaysAgo: 1, endsInDays: 9 });
      await configure(ev, { bonus: BONUS });
      const target = await quest(ev);
      const players: Member[] = [];
      for (let n = 0; n < 5; n += 1) players.push(await member(ev.id));
      for (const who of players) await history(ev, who, 1);
      const door = await hold(f.team(), "SELECT set_event_streak($1, true, 9, '{}', '{}', $2)", [
        ev.id,
        randomUUID(),
      ]);
      try {
        await promptly(Promise.all(players.slice(0, 3).map((who) => complete(who.player, target))));
      } finally {
        door.release();
        await door.done;
      }
      const scan = await hold(
        as(players[3]?.player ?? ""),
        "SELECT * FROM complete_quest($1, 'qr', 1, NULL, $2, NULL)",
        [target, randomUUID()],
      );
      try {
        expect(
          await promptly(setStreak(ev, { enabled: true, bonus: 7, weekdays: [], dates: [] })),
        ).toBe("set");
      } finally {
        scan.release();
        await scan.done;
      }
      await complete(players[4]?.player ?? "", target);
      // Paid before the change commits: the old amount; after it: the new one.
      expect((await bonusesOf(players[0] as Member)).map((row) => row.score_delta)).toEqual(["5"]);
      expect((await bonusesOf(players[3] as Member)).map((row) => row.score_delta)).toEqual(["9"]);
      expect((await bonusesOf(players[4] as Member)).map((row) => row.score_delta)).toEqual(["7"]);
    });
  });

  // ============================================================ integrity
  it("keeps the ledger invariant and the XP invariant after the whole sequence", async () => {
    expect(
      await owner(
        `SELECT n.id FROM enrollment n
         WHERE n.score <> (SELECT coalesce(sum(l.score_delta), 0) FROM ledger_entry l WHERE l.enrollment_id = n.id)
            OR n.balance <> (SELECT coalesce(sum(l.balance_delta), 0) FROM ledger_entry l WHERE l.enrollment_id = n.id)`,
      ),
    ).toEqual([]);
    expect(
      await owner(
        `SELECT x.player_id FROM player_xp x
         WHERE x.xp <> (SELECT coalesce(sum(e.delta), 0) FROM xp_entry e WHERE e.player_id = x.player_id)`,
      ),
    ).toEqual([]);
    // Every day row's bonus is a streak entry of the same enrollment and completion.
    expect(
      await owner(
        `SELECT d.enrollment_id FROM event_streak_day d JOIN ledger_entry l ON l.id = d.entry_id
         WHERE l.kind <> 'streak' OR l.enrollment_id <> d.enrollment_id OR l.completion_id <> d.completion_id`,
      ),
    ).toEqual([]);
  });
});
