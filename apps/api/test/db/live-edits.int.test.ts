import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "#src/db/context";
import { addMember, TEST_DATABASE_URL } from "#test/support/test-db";
import { questifyFixture, type QuestifyFixture } from "#test/support/questify";

type Standing = { score: string; balance: string };
type Member = { player: string; enrollment: string };
type Change = {
  change_id: string;
  completions: number;
  players: number;
  raised: number;
  lowered: number;
  clamped: number;
  replayed: boolean;
};

/** A call's SQLSTATE and detail, or "none". */
const refusal = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "none",
    (error: { code?: string; detail?: string }) =>
      error.detail === undefined || error.detail === ""
        ? `${error.code}`
        : `${error.code}:${error.detail}`,
  );

/** The past door's statements as the PATCH runs them: the quest FOR UPDATE first, then its points, then the door. */
const pastSteps = (event: string, target: string, points: number): [string, unknown[]][] => [
  ["SELECT 1 FROM quest WHERE id = $1 FOR UPDATE", [target]],
  ["UPDATE quest SET points = $2 WHERE id = $1", [target, points]],
  [
    "SELECT * FROM apply_past_points($1, $2, 100, $3, $4)",
    [event, target, randomUUID(), randomUUID()],
  ],
];

/**
 * Live points edits in the database (T-604, migration 0098, ADR-387): "also past" writes compensating `adjust` entries
 * toward absolute targets (score and balance on their own, clamped at zero), a played quest's delete keeps or removes
 * its points, every door that pays a quest pins it first so a past edit and a scan never pay the wrong amount or
 * deadlock, and the readers (community goals, duplication) know the new kind and the deleted mark.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("live points edits (database)", () => {
  let f: QuestifyFixture;
  let counter = 0;
  beforeAll(async () => {
    f = await questifyFixture();
  });
  afterAll(async () => {
    await f.close();
  });

  const quest = async (
    event: string,
    options: { type?: string; points?: number; cap?: number } = {},
  ) =>
    (
      await f.owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, type_config, position, visible)
         SELECT $1, id, $2, 'Stage', $3, $4, $5, $6, true FROM category WHERE event_id = $1 LIMIT 1 RETURNING id`,
        [
          event,
          options.type ?? "enter_code",
          options.points ?? 100,
          options.cap ?? 1,
          JSON.stringify(
            options.type === "quiz"
              ? {
                  questions: [
                    {
                      id: "q1",
                      text: { en: "?" },
                      choices: [
                        { id: "r", text: { en: "R" } },
                        { id: "w", text: { en: "W" } },
                      ],
                      right: "r",
                    },
                  ],
                }
              : { code: "ABC" },
          ),
          (counter += 1),
        ],
      )
    )[0]?.id ?? "";
  const member = async (event: string) => {
    const player = await f.newPlayer();
    return { player, enrollment: await f.join(event, player) };
  };
  const scan = (player: string, target: string, key: string = randomUUID()) =>
    f.asPlayer<{ completion_id: string; points: string }>(
      player,
      "SELECT * FROM complete_quest($1, 'code', NULL, 'ABC', $2, NULL)",
      [target, key],
    );
  const setPoints = (target: string, points: number) =>
    f.owner("UPDATE quest SET points = $2 WHERE id = $1", [target, points]);
  const past = async (
    event: string,
    target: string,
    points: number,
    options: { key?: string; seat?: RequestContext; from?: number } = {},
  ) => {
    await setPoints(target, points);
    return (
      await f.run<Change>(
        options.seat ?? f.team(),
        "SELECT * FROM apply_past_points($1, $2, $3, $4, $5)",
        [event, target, options.from ?? 0, options.key ?? randomUUID(), randomUUID()],
      )
    )[0] as Change;
  };
  const standing = async (enrollment: string) =>
    (
      await f.owner<Standing>("SELECT score, balance FROM enrollment WHERE id = $1", [enrollment])
    )[0];
  const net = async (target: string) =>
    (
      await f.owner<{ completion_id: string; s: string; b: string }>(
        `SELECT l.completion_id, sum(l.score_delta) AS s, sum(l.balance_delta) AS b FROM ledger_entry l
         WHERE l.quest_id = $1 AND l.kind IN ('quest', 'adjust') GROUP BY l.completion_id ORDER BY l.completion_id`,
        [target],
      )
    ).map((row) => [Number(row.s), Number(row.b)]);
  const adjusts = async (target: string) =>
    (
      await f.owner<{ n: number }>(
        "SELECT count(*)::int AS n FROM ledger_entry WHERE quest_id = $1 AND kind = 'adjust'",
        [target],
      )
    )[0]?.n ?? 0;
  const deleteQuest = (event: string, target: string, remove: boolean) =>
    f.run<{ removed: number; total: string }>(
      f.team(),
      "SELECT * FROM delete_played_quest($1, $2, $3, NULL, $4)",
      [event, target, remove, randomUUID()],
    );

  /** The event's players whose score or balance is not their ledger's sum (none when the books balance). */
  const offBooks = async (event: string) =>
    (
      await f.owner<{ n: number }>(
        `SELECT count(*)::int AS n FROM enrollment n
         LEFT JOIN (SELECT enrollment_id, sum(score_delta) AS s, sum(balance_delta) AS b FROM ledger_entry
                    GROUP BY enrollment_id) l ON l.enrollment_id = n.id
         WHERE n.event_id = $1 AND (n.score <> coalesce(l.s, 0) OR n.balance <> coalesce(l.b, 0))`,
        [event],
      )
    )[0]?.n;
  /** Each kept (not removed) completion's net score on the quest, quest entry and adjusts folded, in id order. */
  const keptNets = async (target: string) =>
    (
      await f.owner<{ s: string }>(
        `SELECT sum(l.score_delta) AS s FROM ledger_entry q
         JOIN ledger_entry l ON l.completion_id = q.completion_id AND l.kind IN ('quest', 'adjust')
         WHERE q.quest_id = $1 AND q.kind = 'quest'
           AND NOT EXISTS (SELECT 1 FROM ledger_entry r WHERE r.reverses = q.id AND r.kind = 'removal')
         GROUP BY q.completion_id ORDER BY q.completion_id`,
        [target],
      )
    ).map((row) => Number(row.s));
  /** Opens a transaction as `context`, runs `sql`, and leaves it open. */
  const hold = async (context: RequestContext, sql: string, values: unknown[]) => {
    const client: PoolClient = await f.pool.connect();
    await client.query("BEGIN");
    for (const [name, value] of Object.entries({
      "app.player_id": context.playerId,
      "app.organizer_id": context.organizerId,
      "app.staff_user_id": context.staffUserId,
    })) {
      if (value !== undefined) await client.query("SELECT set_config($1, $2, true)", [name, value]);
    }
    const rows = (await client.query(sql, values)).rows;
    return { client, rows };
  };
  /**
   * Starts `sql` as `context` on another connection (after the statements of `before`, in its transaction) and waits
   * until it blocks on a lock.
   */
  const blocked = async (
    context: RequestContext,
    sql: string,
    values: unknown[],
    before: readonly (readonly [string, unknown[]])[] = [],
  ) => {
    const client: PoolClient = await f.pool.connect();
    const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const run = (async () => {
      await client.query("BEGIN");
      for (const [name, value] of Object.entries({
        "app.player_id": context.playerId,
        "app.organizer_id": context.organizerId,
        "app.staff_user_id": context.staffUserId,
      })) {
        if (value !== undefined)
          await client.query("SELECT set_config($1, $2, true)", [name, value]);
      }
      try {
        for (const [first, given] of before) await client.query(first, given);
        const rows = (await client.query(sql, values)).rows;
        await client.query("COMMIT");
        return rows;
      } catch (error) {
        await client.query("ROLLBACK");
        return error;
      } finally {
        client.release();
      }
    })();
    let waited = false;
    for (let attempt = 0; attempt < 300 && !waited; attempt += 1) {
      waited =
        (
          await f.owner(
            "SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'",
            [pid],
          )
        ).length === 1;
      if (!waited) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return { run, waited };
  };

  describe("also past", () => {
    it("moves 40 players from 100 to 150, then to 120, writing only the difference", async () => {
      const event = await f.newEvent({ phase: "live" });
      const stage = await quest(event);
      const players = [];
      for (let i = 0; i < 40; i += 1) players.push(await member(event));
      for (const one of players) await scan(one.player, stage);
      const up = await past(event, stage, 150, { from: 100 });
      expect(up).toMatchObject({
        completions: 40,
        players: 40,
        raised: 40,
        lowered: 0,
        clamped: 0,
      });
      expect(new Set((await net(stage)).map(String))).toEqual(new Set(["150,150"]));
      const down = await past(event, stage, 120, { from: 150 });
      expect(down).toMatchObject({ completions: 40, raised: 0, lowered: 40 });
      expect(await standing(players[0]?.enrollment ?? "")).toEqual({
        score: "120",
        balance: "120",
      });
      expect(await adjusts(stage)).toBe(80);
      const [audit] = await f.owner<{ after: Record<string, unknown> }>(
        "SELECT after FROM audit_log WHERE target_id = $1 AND action = 'quest.points_past' ORDER BY id DESC LIMIT 1",
        [stage],
      );
      expect(audit?.after).toMatchObject({ points: 120, completions: 40, lowered: 40 });
    });

    it("converges earlier future-only edits, targets a boost's multiple and leaves a removed completion", async () => {
      const event = await f.newEvent({ phase: "live" });
      const stage = await quest(event, { cap: 3 });
      const a = await member(event);
      const b = await member(event);
      await scan(a.player, stage);
      await setPoints(stage, 120);
      await scan(a.player, stage);
      await f.owner(
        `INSERT INTO boost (organizer_id, event_id, category_id, multiplier, starts_at, ends_at)
         SELECT organizer_id, event_id, category_id, 2, now() - interval '1 minute', now() + interval '1 hour'
         FROM quest WHERE id = $1`,
        [stage],
      );
      await scan(b.player, stage);
      const [gone] = await scan(b.player, stage);
      const [entry] = await f.owner<{ id: string }>(
        "SELECT id FROM ledger_entry WHERE completion_id = $1 AND kind = 'quest'",
        [gone?.completion_id],
      );
      await f.removeEntry(event, entry?.id ?? "");
      await past(event, stage, 150);
      expect(await net(stage)).toEqual([
        [150, 150],
        [150, 150],
        [300, 300],
        [240, 240],
      ]);
    });

    it("lowers for a player who spent, clamps the balance on its own, and an undo puts both back", async () => {
      const event = await f.newEvent({ phase: "live" });
      const stage = await quest(event);
      const { player, enrollment } = await member(event);
      await scan(player, stage);
      const [reward] = await f.owner<{ id: string }>(
        "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, 'experience', 'Tour', 90, 9) RETURNING id",
        [event],
      );
      await f.asPlayer(player, "SELECT * FROM reserve_reward($1, $2)", [reward?.id, randomUUID()]);
      await f.owner(
        "UPDATE redemption SET status = 'handed_over', ended_at = now(), ended_by = 'handover', operator_id = $2 WHERE enrollment_id = $1",
        [enrollment, player],
      );
      expect(await standing(enrollment)).toEqual({ score: "100", balance: "10" });
      expect(await past(event, stage, 50)).toMatchObject({ lowered: 1, clamped: 1 });
      expect(await standing(enrollment)).toEqual({ score: "50", balance: "0" });
      const again = await past(event, stage, 50);
      expect(again).toMatchObject({ completions: 0, clamped: 1 });
      expect(await past(event, stage, 100)).toMatchObject({ raised: 1, clamped: 0 });
      expect(await standing(enrollment)).toEqual({ score: "100", balance: "10" });
      expect(await adjusts(stage)).toBe(2);
    });

    it("replays a key, refuses it for other points, and a new key finds nothing to write", async () => {
      const event = await f.newEvent({ phase: "live" });
      const stage = await quest(event);
      const { player } = await member(event);
      await scan(player, stage);
      const key = randomUUID();
      const first = await past(event, stage, 130, { key });
      const replay = await past(event, stage, 130, { key });
      expect(replay).toMatchObject({ change_id: first.change_id, completions: 1, replayed: true });
      expect(await refusal(past(event, stage, 140, { key }))).toBe("AK422");
      await setPoints(stage, 130);
      expect(await past(event, stage, 130)).toMatchObject({ completions: 0, replayed: false });
      expect(await adjusts(stage)).toBe(1);
    });

    it("refuses an editor over the cap per award, an unpaid type, an event not live and final results", async () => {
      const event = await f.newEvent({ phase: "live" });
      await f.owner("UPDATE event SET award_cap_each = 20 WHERE id = $1", [event]);
      const stage = await quest(event);
      const { player } = await member(event);
      await scan(player, stage);
      const editor = await addMember(f.db.owner, f.ids.orgA, "editor");
      const seat = { organizerId: f.ids.orgA, staffUserId: editor };
      expect(await refusal(past(event, stage, 150, { seat }))).toBe("AC409:each");
      expect(await past(event, stage, 115, { seat })).toMatchObject({ raised: 1 });
      expect(await past(event, stage, 150)).toMatchObject({ raised: 1 });
      const quiz = await quest(event, { type: "quiz" });
      expect(await refusal(past(event, quiz, 5))).toBe("PX422:quiz");
      const ended = await f.newEvent({ phase: "ended" });
      expect(await refusal(past(ended, await quest(ended), 5))).toBe("AS409");
      const closed = await f.newEvent({ phase: "ended" });
      const done = await quest(closed);
      await f.confirm(closed);
      expect(await refusal(past(closed, done, 5))).toBe("RF409:results_final");
    });

    it("writes at most the batch's entries a call and says when more are left", async () => {
      const event = await f.newEvent({ phase: "live" });
      const stage = await quest(event);
      for (let i = 0; i < 5; i += 1) await scan((await member(event)).player, stage);
      await setPoints(stage, 110);
      const call = (key: string) =>
        f.run<Change & { more: boolean }>(
          f.team(),
          "SELECT * FROM apply_past_points($1, $2, 100, $3, $4, 2)",
          [event, stage, key, randomUUID()],
        );
      const key = randomUUID();
      expect((await call(key))[0]).toMatchObject({ completions: 2, more: true });
      expect((await call(`${key}#2`))[0]).toMatchObject({ completions: 2, more: true });
      expect((await call(`${key}#3`))[0]).toMatchObject({ completions: 1, more: false });
      const [replay] = await f.run<{ completions: number }>(
        f.team(),
        "SELECT * FROM past_points_replay($1, $2)",
        [event, key],
      );
      expect(replay?.completions).toBe(5);
      expect(new Set((await net(stage)).map(String))).toEqual(new Set(["110,110"]));
    });

    it("lowers 3,000 completions of 500 players who spent, each call under the timeouts, clamped at zero", async () => {
      const event = await f.newEvent({ phase: "live" });
      const stage = await quest(event, { cap: 6 });
      const [reward] = await f.owner<{ id: string }>(
        "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, 'experience', 'Tour', 550, 500) RETURNING id",
        [event],
      );
      const players = await f.owner<{ player: string; enrollment: string }>(
        `WITH made AS (INSERT INTO player (username) SELECT 'scale_' || $2 || '_' || g FROM generate_series(1, 500) g
                       RETURNING id)
         INSERT INTO enrollment (organizer_id, event_id, player_id)
         SELECT e.organizer_id, e.id, made.id FROM made, event e WHERE e.id = $1
         RETURNING player_id AS player, id AS enrollment`,
        [event, (counter += 1)],
      );
      await f.owner(
        `WITH done AS (
           INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                         idempotency_key)
           SELECT n.organizer_id, n.event_id, n.id, $2, g, 'code', gen_random_uuid()::text
           FROM enrollment n, generate_series(1, 6) g WHERE n.event_id = $1 ORDER BY n.id, g
           RETURNING id, organizer_id, event_id, enrollment_id)
         INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                   completion_id, quest_id, actor)
         SELECT d.organizer_id, d.event_id, d.enrollment_id, 'quest', 100, 100, d.id, $2, 'player' FROM done d`,
        [event, stage],
      );
      for (let i = 0; i < players.length; i += 25) {
        await Promise.all(
          players
            .slice(i, i + 25)
            .map((one) =>
              f.asPlayer(one.player, "SELECT * FROM reserve_reward($1, $2)", [
                reward?.id,
                randomUUID(),
              ]),
            ),
        );
      }
      expect(await standing(players[0]?.enrollment ?? "")).toEqual({
        score: "600",
        balance: "50",
      });
      const client: PoolClient = await f.pool.connect();
      const timings: number[] = [];
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.organizer_id', $1, true)", [f.ids.orgA]);
        await client.query("SELECT set_config('app.staff_user_id', $1, true)", [
          f.team().staffUserId,
        ]);
        await client.query("SET LOCAL statement_timeout = '5s'");
        await client.query("SET LOCAL lock_timeout = '2s'");
        await client.query("UPDATE quest SET points = 10 WHERE id = $1", [stage]);
        const key = randomUUID();
        for (let part = 1; ; part += 1) {
          const started = performance.now();
          const { rows } = await client.query<Change & { more: boolean }>(
            "SELECT * FROM apply_past_points($1, $2, 100, $3, $4, 2000, $5)",
            [event, stage, key, randomUUID(), part],
          );
          timings.push(Math.round(performance.now() - started));
          if (rows[0]?.more !== true) break;
        }
        await client.query("COMMIT");
        const [sum] = await f.run<Change>(f.team(), "SELECT * FROM past_points_replay($1, $2)", [
          event,
          key,
        ]);
        expect(sum).toMatchObject({ completions: 3000, players: 500, lowered: 3000, clamped: 500 });
      } finally {
        client.release();
      }
      // oxlint-disable-next-line no-console -- the measured calls are the numbers ADR-387 cites
      console.info(`past points at scale: calls of ${timings.join(" ms, ")} ms`);
      expect(timings).toHaveLength(2);
      for (const took of timings) expect(took).toBeLessThan(5000);
      const ends = await f.owner<{ score: string; balance: string; n: number }>(
        "SELECT score, balance, count(*)::int AS n FROM enrollment WHERE event_id = $1 GROUP BY score, balance",
        [event],
      );
      expect(ends).toEqual([{ score: "60", balance: "0", n: 500 }]);
      expect(await offBooks(event)).toBe(0);
    }, 120_000);

    it("replays only its own key's parts, takes a key's `%` and `_` as themselves, and refuses a key over 240", async () => {
      const event = await f.newEvent({ phase: "live" });
      const stage = await quest(event);
      for (let i = 0; i < 3; i += 1) await scan((await member(event)).player, stage);
      await setPoints(stage, 110);
      const call = (key: string, part: number) =>
        f.run<Change & { more: boolean }>(
          f.team(),
          "SELECT * FROM apply_past_points($1, $2, 100, $3, $4, 2, $5)",
          [event, stage, key, randomUUID(), part],
        );
      expect((await call("xy", 1))[0]).toMatchObject({ completions: 2, players: 3, more: true });
      expect((await call("xy", 2))[0]).toMatchObject({ completions: 1, players: 0, more: false });
      const replay = (key: string) =>
        f.run<Change>(f.team(), "SELECT * FROM past_points_replay($1, $2)", [event, key]);
      expect(await replay("xy")).toMatchObject([{ completions: 3, players: 3 }]);
      expect(await replay("x_")).toEqual([]);
      expect(await replay("x%")).toEqual([]);
      expect(await refusal(call("k".repeat(241), 1))).toBe("AK422");
    });

    it("counts the impact before the edit, as the screen shows it", async () => {
      const event = await f.newEvent({ phase: "live" });
      const stage = await quest(event);
      const a = await member(event);
      const b = await member(event);
      await scan(a.player, stage);
      await scan(b.player, stage);
      const [impact] = await f.run(f.team(), "SELECT * FROM quest_points_impact($1, $2, 40)", [
        event,
        stage,
      ]);
      expect(impact).toMatchObject({
        eligible: true,
        completions: 2,
        players: 2,
        raise: 0,
        lower: 2,
        clamped: 0,
        prizes_handed: 0,
      });
      expect(await adjusts(stage)).toBe(0);
    });
  });

  describe("delete keep or remove", () => {
    it("keeps the points, hides and freezes the quest, and clears the Up next pin", async () => {
      const event = await f.newEvent({ phase: "live" });
      const stage = await quest(event);
      const { player, enrollment } = await member(event);
      await scan(player, stage);
      await f.owner("UPDATE event SET focus_quest_id = $2 WHERE id = $1", [event, stage]);
      expect((await deleteQuest(event, stage, false))[0]).toMatchObject({ removed: 0 });
      expect(await standing(enrollment)).toEqual({ score: "100", balance: "100" });
      const [row] = await f.owner<{ visible: boolean; focus: string | null }>(
        "SELECT q.visible, e.focus_quest_id AS focus FROM quest q JOIN event e ON e.id = q.event_id WHERE q.id = $1",
        [stage],
      );
      expect(row).toEqual({ visible: false, focus: null });
      expect(await refusal(f.owner("UPDATE quest SET title_en = 'X' WHERE id = $1", [stage]))).toBe(
        "QX409",
      );
      expect(await refusal(scan(player, stage))).toBe("QN403:hidden");
      expect(await refusal(deleteQuest(event, stage, true))).toBe("AQ404");
      expect(
        await refusal(
          f.run(f.team(), "SELECT set_quest_paused($1, $2, true, $3)", [
            event,
            stage,
            randomUUID(),
          ]),
        ),
      ).toBe("AQ404");
      expect(
        await refusal(
          f.run(f.team(), "SELECT * FROM bulk_award($1, NULL, $2, NULL, 5, 'Thanks', $3, $4)", [
            event,
            stage,
            randomUUID(),
            randomUUID(),
          ]),
        ),
      ).toBe("AQ404");
      expect(
        await refusal(
          f.run(f.team(), "SELECT * FROM staff_award($1, $2, $3, NULL, 'Helped', $4, $5)", [
            event,
            enrollment,
            stage,
            randomUUID(),
            randomUUID(),
          ]),
        ),
      ).toMatch(/^QN403/);
    });

    it("removes the quest's entries with their adjusts, reverses the XP, and leaves bulk changes of live quests alone", async () => {
      const event = await f.newEvent({ phase: "live" });
      const stage = await quest(event);
      const other = await quest(event);
      const { player, enrollment } = await member(event);
      await scan(player, stage);
      await past(event, stage, 160);
      expect(await standing(enrollment)).toEqual({ score: "160", balance: "160" });
      const [gone] = await deleteQuest(event, stage, true);
      expect(gone).toMatchObject({ removed: 1, total: "160" });
      expect(await standing(enrollment)).toEqual({ score: "0", balance: "0" });
      const [xp] = await f.owner<{ xp: string; rows: number }>(
        "SELECT coalesce(sum(x.delta), 0) AS xp, count(*)::int AS rows FROM xp_entry x WHERE x.player_id = $1",
        [player],
      );
      expect(xp).toEqual({ xp: "0", rows: 2 });
      await f.owner("UPDATE category SET order_mode = 'in_order' WHERE event_id = $1", [event]);
      await f.owner("UPDATE category SET order_mode = 'any' WHERE event_id = $1", [event]);
      await f.owner(
        "UPDATE quest SET position = position + 1, qr_version = qr_version + 1 WHERE id = $1",
        [other],
      );
    });

    it("folds the adjusts into remove_award's take, score and balance on their own", async () => {
      const event = await f.newEvent({ phase: "live" });
      const stage = await quest(event);
      const { player, enrollment } = await member(event);
      const [paid] = await scan(player, stage);
      await past(event, stage, 130);
      const [entry] = await f.owner<{ id: string }>(
        "SELECT id FROM ledger_entry WHERE completion_id = $1 AND kind = 'quest'",
        [paid?.completion_id],
      );
      const [removal] = await f.removeEntry(event, entry?.id ?? "");
      expect(removal).toMatchObject({ score_delta: "-130", balance_delta: "-130" });
      expect(await standing(enrollment)).toEqual({ score: "0", balance: "0" });
      await past(event, stage, 200);
      expect(await standing(enrollment)).toEqual({ score: "0", balance: "0" });
    });

    it("duplicates an event with a deleted quest without it or any link to it", async () => {
      const event = await f.newEvent({ phase: "live" });
      const stage = await quest(event);
      const kept = await quest(event);
      const { player } = await member(event);
      await scan(player, stage);
      await f.owner(
        "INSERT INTO quest_first_bonus (quest_id, organizer_id, event_id, points, slots) SELECT id, organizer_id, event_id, 5, 3 FROM quest WHERE id = $1",
        [stage],
      );
      await deleteQuest(event, stage, false);
      const [target] = await f.owner<{ id: string }>(
        `INSERT INTO event (organizer_id, join_code, name_en, starts_at, ends_at)
         VALUES ($1, $2, 'Copy', now() + interval '30 days', now() + interval '31 days') RETURNING id`,
        [f.ids.orgA, `LVE${(counter += 1)}`],
      );
      await f.run(f.team(), "SELECT event_copy_setup($1, $2, $3)", [
        event,
        target?.id,
        randomUUID(),
      ]);
      const copied = await f.owner<{ title_en: string }>(
        "SELECT title_en FROM quest WHERE event_id = $1",
        [target?.id],
      );
      expect(copied).toHaveLength(1);
      expect(kept).not.toBe("");
      const bonuses = await f.owner("SELECT 1 FROM quest_first_bonus WHERE event_id = $1", [
        target?.id,
      ]);
      expect(bonuses).toHaveLength(0);
    });
  });

  describe("community goals (plan review MAJOR 3)", () => {
    it("counts a raise as its quest's points on a points goal, and a removal takes the folded total back", async () => {
      const event = await f.newEvent({ phase: "live" });
      const stage = await quest(event);
      const { player, enrollment } = await member(event);
      const [goal] = await f.owner<{ id: string }>(
        `INSERT INTO community_goal (organizer_id, event_id, title_en, measure, target, starts_at, ends_at, status)
         SELECT organizer_id, id, 'Together', 'points', 100000, now() - interval '1 hour', now() + interval '1 hour', 'running'
         FROM event WHERE id = $1 RETURNING id`,
        [event],
      );
      const slice = async () =>
        (
          await f.owner<{ settled: string; tail: string }>(
            `SELECT s.* FROM community_goal g,
               community_read_slice(g, g.ends_at, g.starts_at, now() + interval '1 minute', now() + interval '1 minute') s
             WHERE g.id = $1 AND s.enrollment_id = $2`,
            [goal?.id, enrollment],
          )
        )[0]?.settled;
      const [paid] = await scan(player, stage);
      await past(event, stage, 180);
      expect(await slice()).toBe("180");
      const [entry] = await f.owner<{ id: string }>(
        "SELECT id FROM ledger_entry WHERE completion_id = $1 AND kind = 'quest'",
        [paid?.completion_id],
      );
      await f.removeEntry(event, entry?.id ?? "");
      expect(await slice()).toBe("0");
    });
  });

  describe("races (plan review MAJOR 2)", () => {
    it("a scan in flight at the old points is adjusted by the edit that waited for it", async () => {
      const event = await f.newEvent({ phase: "live" });
      const stage = await quest(event);
      const { player, enrollment } = await member(event);
      const scanning = await hold(
        { playerId: player },
        "SELECT * FROM complete_quest($1, 'code', NULL, 'ABC', $2, NULL)",
        [stage, randomUUID()],
      );
      expect(scanning.rows[0]).toMatchObject({ points: "100" });
      await setPoints(stage, 150);
      const edit = await blocked(f.team(), "SELECT * FROM apply_past_points($1, $2, 100, $3, $4)", [
        event,
        stage,
        randomUUID(),
        randomUUID(),
      ]);
      expect(edit.waited).toBe(true);
      await scanning.client.query("COMMIT");
      scanning.client.release();
      expect(await edit.run).toMatchObject([{ completions: 1, raised: 1 }]);
      expect(await standing(enrollment)).toEqual({ score: "150", balance: "150" });
    });

    it("a scan behind an edit in flight pays the new points", async () => {
      const event = await f.newEvent({ phase: "live" });
      const stage = await quest(event);
      const early = await member(event);
      await scan(early.player, stage);
      const late = await member(event);
      const editing = await hold(f.team(), "UPDATE quest SET points = 170 WHERE id = $1", [stage]);
      await editing.client.query("SELECT * FROM apply_past_points($1, $2, 100, $3, $4)", [
        event,
        stage,
        randomUUID(),
        randomUUID(),
      ]);
      const scanning = await blocked(
        { playerId: late.player },
        "SELECT * FROM complete_quest($1, 'code', NULL, 'ABC', $2, NULL)",
        [stage, randomUUID()],
      );
      expect(scanning.waited).toBe(true);
      await editing.client.query("COMMIT");
      editing.client.release();
      expect(await scanning.run).toMatchObject([{ points: "170" }]);
      expect(await standing(early.enrollment)).toEqual({ score: "170", balance: "170" });
    });

    it("a delete-remove waits for a scan in flight and removes it; no completion follows the delete", async () => {
      const event = await f.newEvent({ phase: "live" });
      const stage = await quest(event, { cap: 2 });
      const { player, enrollment } = await member(event);
      await scan(player, stage);
      const scanning = await hold(
        { playerId: player },
        "SELECT * FROM complete_quest($1, 'code', NULL, 'ABC', $2, NULL)",
        [stage, randomUUID()],
      );
      const removing = await blocked(
        f.team(),
        "SELECT * FROM delete_played_quest($1, $2, true, NULL, $3)",
        [event, stage, randomUUID()],
      );
      expect(removing.waited).toBe(true);
      await scanning.client.query("COMMIT");
      scanning.client.release();
      expect(await removing.run).toMatchObject([{ removed: 2, total: "200" }]);
      expect(await standing(enrollment)).toEqual({ score: "0", balance: "0" });
      expect(await refusal(scan(player, stage))).toBe("QN403:hidden");
    });

    it("an edit and a results confirm take turns on the event", async () => {
      const event = await f.newEvent({ phase: "live" });
      const stage = await quest(event);
      const { player } = await member(event);
      await scan(player, stage);
      await setPoints(stage, 110);
      const editing = await hold(f.team(), "SELECT * FROM apply_past_points($1, $2, 100, $3, $4)", [
        event,
        stage,
        randomUUID(),
        randomUUID(),
      ]);
      await f.owner("UPDATE event SET ends_at = now() - interval '1 second' WHERE id = $1", [
        event,
      ]);
      const places = await f.run<{ enrollment_id: string }>(
        f.team(),
        "SELECT * FROM results_places($1)",
        [event],
      );
      const confirming = await blocked(f.team(), "SELECT confirm_results($1, $2, $3) AS outcome", [
        event,
        places.map((p) => p.enrollment_id),
        randomUUID(),
      ]);
      expect(confirming.waited).toBe(true);
      await editing.client.query("COMMIT");
      editing.client.release();
      expect(await confirming.run).toMatchObject([{ outcome: "confirmed" }]);
      expect(await refusal(past(event, stage, 120))).toBe("RF409:results_final");
    });

    type Door = Readonly<{ context: RequestContext; sql: string; values: unknown[] }>;

    /** The door holds its transaction open; the past edit of its quest waits for it, then runs. */
    const doorThenEdit = async (event: string, target: string, door: Door, points: number) => {
      const held = await hold(door.context, door.sql, door.values);
      const steps = pastSteps(event, target, points);
      const [sql, values] = steps.pop() as [string, unknown[]];
      const edit = await blocked(f.team(), sql, values, steps);
      expect(edit.waited).toBe(true);
      await held.client.query("COMMIT");
      held.client.release();
      return { door: held.rows, edit: await edit.run };
    };
    /** The past edit holds its transaction open; the door waits for it, then pays the new points. */
    const editThenDoor = async (event: string, target: string, door: Door, points: number) => {
      const steps = pastSteps(event, target, points);
      const [firstSql, firstValues] = steps.shift() as [string, unknown[]];
      const editing = await hold(f.team(), firstSql, firstValues);
      for (const [sql, values] of steps) await editing.client.query(sql, values);
      const doing = await blocked(door.context, door.sql, door.values);
      expect(doing.waited).toBe(true);
      await editing.client.query("COMMIT");
      editing.client.release();
      return doing.run;
    };

    it("a bulk award naming the quest and an also-past edit take turns either way", async () => {
      const event = await f.newEvent({ phase: "live" });
      const stage = await quest(event);
      const a = await member(event);
      const b = await member(event);
      await scan(a.player, stage);
      await scan(b.player, stage);
      const bulk = (): Door => ({
        context: f.team(),
        sql: "SELECT * FROM bulk_award($1, NULL, $2, NULL, 25, 'Thanks', $3, $4)",
        values: [event, stage, randomUUID(), randomUUID()],
      });
      const first = await doorThenEdit(event, stage, bulk(), 150);
      expect(first.door).toMatchObject([{ awarded: 2 }]);
      expect(first.edit).toMatchObject([{ completions: 2, raised: 2 }]);
      expect(await editThenDoor(event, stage, bulk(), 120)).toMatchObject([{ awarded: 2 }]);
      expect(await keptNets(stage)).toEqual([120, 120]);
      expect(await standing(a.enrollment)).toEqual({ score: "170", balance: "170" });
      expect(await offBooks(event)).toBe(0);
    });

    it("an approval in flight keeps its pay; the edit of its quest waits and is refused for the type", async () => {
      const event = await f.newEvent({ phase: "live" });
      const [stage] = await f.owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, type_config, visible)
         SELECT $1, id, 'submission', 'Tell us', 100, 1, $2, true FROM category WHERE event_id = $1 LIMIT 1
         RETURNING id`,
        [event, JSON.stringify({ accepts: ["text"], autoApprove: false, resubmit: false })],
      );
      const { player, enrollment } = await member(event);
      await f.owner(
        `INSERT INTO player_acceptance (player_id, document, version, method)
         VALUES ($1, 'community_guidelines', '1.0', 'submission')`,
        [player],
      );
      const [sent] = await f.asPlayer<{ submission_id: string }>(
        player,
        "SELECT * FROM submit_quest($1, 'My answer', '1.0', $2)",
        [stage?.id, randomUUID()],
      );
      const raced = await doorThenEdit(
        event,
        stage?.id ?? "",
        {
          context: f.team(),
          sql: "SELECT * FROM staff_review_submission($1, $2, 'approve', NULL, $3, $4)",
          values: [event, sent?.submission_id, randomUUID(), randomUUID()],
        },
        150,
      );
      expect(raced.door).toMatchObject([{ status: "approved" }]);
      expect(raced.edit).toMatchObject({ code: "PX422" });
      expect(await standing(enrollment)).toEqual({ score: "100", balance: "100" });
      expect(await offBooks(event)).toBe(0);
    });

    it("a passport stamp that completes the quest and an also-past edit take turns either way", async () => {
      const event = await f.newEvent({ phase: "live" });
      const made = await f.owner<{ quest: string; step: string }>(
        `WITH made AS (
           INSERT INTO quest (event_id, category_id, type, title_en, points, type_config, visible, verification)
           SELECT $1, id, 'passport', 'Booths', 100, '{"needed": 2}', true, '{}' FROM category WHERE event_id = $1
           LIMIT 1 RETURNING id)
         INSERT INTO passport_step (event_id, quest_id, name_en, position)
         SELECT $1, made.id, 'Booth ' || g, g FROM made, generate_series(1, 2) g
         RETURNING quest_id AS quest, id AS step`,
        [event],
      );
      const stage = { id: made[0]?.quest };
      const steps = made.map((row) => ({ id: row.step }));
      const stamp = (player: string, step: number): Door => ({
        context: { playerId: player },
        sql: "SELECT * FROM stamp_step($1, 1, $2, NULL)",
        values: [steps[step]?.id, randomUUID()],
      });
      const a = await member(event);
      const b = await member(event);
      for (const one of [a, b]) {
        const first = stamp(one.player, 0);
        await f.run(first.context, first.sql, first.values);
      }
      const first = await doorThenEdit(event, stage?.id ?? "", stamp(a.player, 1), 150);
      expect(first.edit).toMatchObject([{ completions: 1, raised: 1 }]);
      const second = await editThenDoor(event, stage?.id ?? "", stamp(b.player, 1), 120);
      expect(second).not.toHaveProperty("code");
      expect(await keptNets(stage?.id ?? "")).toEqual([120, 120]);
      expect(await standing(a.enrollment)).toEqual({ score: "120", balance: "120" });
      expect(await offBooks(event)).toBe(0);
    });

    it("a meet in flight and an also-past edit take turns either way, both players paid once", async () => {
      const event = await f.newEvent({ phase: "live" });
      const [stage] = await f.owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, type_config, visible)
         SELECT $1, id, 'meet', 'Meet', 100, 10, '{"dailyCap": 5}', true FROM category WHERE event_id = $1
         LIMIT 1 RETURNING id`,
        [event],
      );
      const target = stage?.id ?? "";
      const meet = async (scanner: string, shower: string): Promise<Door> => {
        const hash = randomBytes(32);
        await f.asPlayer(shower, "SELECT * FROM issue_meet_pass($1, $2, NULL)", [target, hash]);
        return {
          context: { playerId: scanner },
          sql: "SELECT * FROM meet_player($1, $2, NULL, NULL)",
          values: [hash, randomUUID()],
        };
      };
      const people = [];
      for (let i = 0; i < 4; i += 1) people.push(await member(event));
      const [a, b, c, d] = people as [Member, Member, Member, Member];
      const first = await doorThenEdit(event, target, await meet(a.player, b.player), 150);
      expect(first.edit).toMatchObject([{ replayed: false, lowered: 0 }]);
      const second = await editThenDoor(event, target, await meet(c.player, d.player), 120);
      expect(second).not.toHaveProperty("code");
      const nets = await keptNets(target);
      expect(nets.length).toBeGreaterThanOrEqual(2);
      expect(new Set(nets)).toEqual(new Set([120]));
      expect(await offBooks(event)).toBe(0);
    });

    it("a staff award of the quest and an also-past edit take turns either way", async () => {
      const event = await f.newEvent({ phase: "live" });
      const stage = await quest(event);
      const a = await member(event);
      const b = await member(event);
      const award = (enrollment: string): Door => ({
        context: f.team(),
        sql: "SELECT * FROM staff_award($1, $2, $3, NULL, 'Helped', $4, $5)",
        values: [event, enrollment, stage, randomUUID(), randomUUID()],
      });
      const first = await doorThenEdit(event, stage, award(a.enrollment), 150);
      expect(first.door).toMatchObject([{ points: "100" }]);
      expect(first.edit).toMatchObject([{ completions: 1, raised: 1 }]);
      expect(await editThenDoor(event, stage, award(b.enrollment), 120)).toMatchObject([
        { points: "120" },
      ]);
      expect(await keptNets(stage)).toEqual([120, 120]);
      expect(await offBooks(event)).toBe(0);
    });

    it("a removal in flight and an also-past edit take turns either way, nothing paid back", async () => {
      const event = await f.newEvent({ phase: "live" });
      const stage = await quest(event);
      const people = [];
      for (let i = 0; i < 3; i += 1) people.push(await member(event));
      const entries = [];
      for (const one of people) {
        const [paid] = await scan(one.player, stage);
        const [entry] = await f.owner<{ id: string }>(
          "SELECT id FROM ledger_entry WHERE completion_id = $1 AND kind = 'quest'",
          [paid?.completion_id],
        );
        entries.push(entry?.id ?? "");
      }
      const removal = (entry: string): Door => ({
        context: f.team(),
        sql: "SELECT * FROM remove_award($1, $2, 'cheat', $3, $4)",
        values: [event, entry, randomUUID(), randomUUID()],
      });
      const first = await doorThenEdit(event, stage, removal(entries[0] ?? ""), 150);
      expect(first.door).toMatchObject([{ score_delta: "-100" }]);
      expect(first.edit).toMatchObject([{ completions: 2, raised: 2 }]);
      expect(await editThenDoor(event, stage, removal(entries[1] ?? ""), 120)).toMatchObject([
        { score_delta: "-120" },
      ]);
      expect(await keptNets(stage)).toEqual([120]);
      for (const one of people.slice(0, 2)) {
        expect(await standing(one.enrollment)).toEqual({ score: "0", balance: "0" });
      }
      expect(await offBooks(event)).toBe(0);
    });

    it("runs scans, past edits and removals on one quest for a while with no deadlock and the targets met", async () => {
      const event = await f.newEvent({ phase: "live" });
      const stage = await quest(event, { cap: 50 });
      const players = [];
      for (let i = 0; i < 6; i += 1) players.push(await member(event));
      const until = Date.now() + 6000;
      let points = 100;
      let removed = 0;
      const failures: string[] = [];
      const noteFailure = (error: { code?: string }) => {
        if (error.code === "40P01") failures.push("deadlock");
      };
      const scanner = async (one: { player: string }) => {
        while (Date.now() < until) await scan(one.player, stage).catch(noteFailure);
      };
      const editor = async () => {
        while (Date.now() < until) {
          points = points === 100 ? 140 : 100;
          await past(event, stage, points).catch(noteFailure);
        }
      };
      const remover = async () => {
        while (Date.now() < until) {
          const [entry] = await f.owner<{ id: string }>(
            `SELECT l.id FROM ledger_entry l WHERE l.quest_id = $1 AND l.kind = 'quest'
               AND NOT EXISTS (SELECT 1 FROM ledger_entry r WHERE r.reverses = l.id)
             ORDER BY random() LIMIT 1`,
            [stage],
          );
          if (entry !== undefined) {
            await f.removeEntry(event, entry.id).then(() => {
              removed += 1;
            }, noteFailure);
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      };
      await Promise.all([...players.map(scanner), editor(), remover()]);
      await past(event, stage, points);
      expect(failures).toEqual([]);
      expect(removed).toBeGreaterThan(0);
      expect(new Set(await keptNets(stage))).toEqual(new Set([points]));
      expect(await offBooks(event)).toBe(0);
    });
  });
});
