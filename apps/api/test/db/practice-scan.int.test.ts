import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setLocalSettings } from "#src/db/connection";
import { withRequestContext, type RequestContext } from "#src/db/context";
import { newRehearsalCode } from "#src/rehearsal/rehearsal";
import { fingerprint } from "#test/db/fingerprint";
import {
  TEST_DATABASE_URL,
  addMember,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

type Row = Record<string, unknown>;

/** What a scan answered, in one shape for the practice door and the real one. */
type Answer =
  | Readonly<{ outcome: "completed"; points: number; occurrence: number }>
  | Readonly<{ outcome: "refused"; refusal: string; detail: string | null }>;

type PracticeRow = {
  outcome: "completed" | "refused";
  points: string | null;
  occurrence: number | null;
  refusal: string | null;
  refusal_detail: string | null;
};

const HOUR = 3_600_000;

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);

const answerOf = (row: PracticeRow): Answer =>
  row.outcome === "completed"
    ? { outcome: "completed", points: Number(row.points), occurrence: Number(row.occurrence) }
    : { outcome: "refused", refusal: String(row.refusal), detail: row.refusal_detail };

/**
 * Practice scans and My station today in the database (T-311, migration 0060, ADR-249, ADR-251): every practice
 * answer equals the real door's for the same case, run afterwards, and the whole database is unchanged by it, with the
 * transaction around it committing (the database wall alone); the locks it took are gone before it returns; keys,
 * crossed scans and the owed go-live wipe; the station's counts by the event's day.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)(
  "practice scans and station today (database)",
  () => {
    let db: TestDatabase;
    let pool: Pool;
    let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
    let ownerA = "";
    let counter = 0;

    beforeAll(async () => {
      db = await createTestDatabase();
      pool = new Pool({ connectionString: db.appUrl, max: 4 });
      ids = await seedTwoTenants(db.owner);
      ownerA = await addMember(db.owner, ids.orgA, "owner");
    });
    afterAll(async () => {
      await pool.end();
      await db.close();
    });

    const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
      (await db.owner.query<T>(sql, values)).rows;
    const as = async <T extends Row>(
      context: RequestContext,
      sql: string,
      values: unknown[] = [],
    ) => withRequestContext(db.app, context, async () => (await db.app.query<T>(sql, values)).rows);

    const newEvent = async (
      status = "live",
      times: Readonly<{ starts: string; ends: string }> = { starts: "-1 hour", ends: "1 day" },
    ): Promise<string> => {
      counter += 1;
      const [event] = await owner<{ id: string }>(
        `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Practice Fest', $3, now() + $4::interval, now() + $5::interval) RETURNING id`,
        [ids.orgA, `PRC${counter}`, status, times.starts, times.ends],
      );
      return event?.id ?? "";
    };

    const newCategory = async (event: string, bonus = 0): Promise<string> => {
      counter += 1;
      const [category] = await owner<{ id: string }>(
        `INSERT INTO category (event_id, name_en, completion_bonus, position) VALUES ($1, 'Gate', $2, $3)
       RETURNING id`,
        [event, bonus, counter],
      );
      return category?.id ?? "";
    };

    const newQuest = async (
      event: string,
      fields: Readonly<{
        type?: string;
        verification?: string[];
        repeatCap?: number;
        category?: string;
      }> = {},
    ): Promise<string> => {
      const category = fields.category ?? (await newCategory(event));
      const [quest] = await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, visible, type_config, verification)
       VALUES ($1, $2, $3, 'Station', 15, $4, true, '{}', $5) RETURNING id`,
        [
          event,
          category,
          fields.type ?? "scan_qr",
          fields.repeatCap ?? 1,
          fields.verification ?? ["my_qr"],
        ],
      );
      return quest?.id ?? "";
    };

    const newPlayer = async (): Promise<string> => {
      counter += 1;
      const [player] = await owner<{ id: string }>(
        "INSERT INTO player (username) VALUES ($1) RETURNING id",
        [`practice_${counter}`],
      );
      return player?.id ?? "";
    };

    const enroll = async (event: string, player: string, status = "active"): Promise<string> => {
      const [row] = await owner<{ id: string }>(
        `INSERT INTO enrollment (organizer_id, event_id, player_id, status, joined_via, card_version)
       VALUES ($1, $2, $3, $4, 'code', '1') RETURNING id`,
        [ids.orgA, event, player, status],
      );
      return row?.id ?? "";
    };

    /** A player enrolled in the event. */
    const member = async (event: string, status = "active") => {
      const player = await newPlayer();
      return { player, enrollment: await enroll(event, player, status) };
    };

    /** An operator of the event with these abilities, limited to `quests` when any are given. */
    const newOperator = async (
      event: string,
      fields: Readonly<{ abilities?: string[]; quests?: string[]; canPlay?: boolean }> = {},
    ): Promise<string> => {
      const player = await newPlayer();
      const [assignment] = await owner<{ id: string }>(
        `INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities, can_play)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [ids.orgA, event, player, fields.abilities ?? ["scan_quests"], fields.canPlay ?? false],
      );
      for (const quest of fields.quests ?? []) {
        await owner(
          "INSERT INTO staff_assignment_quest (assignment_id, event_id, quest_id) VALUES ($1, $2, $3)",
          [assignment?.id, event, quest],
        );
      }
      return player;
    };

    const practice = async (operator: string, quest: string, scanned: string, version = 1) => {
      const [row] = await as<PracticeRow>(
        { playerId: operator },
        "SELECT * FROM operator_practice_scan($1, $2, $3)",
        [quest, scanned, version],
      );
      return answerOf(row as PracticeRow);
    };

    const real = async (
      operator: string,
      quest: string,
      scanned: string,
      fields: Readonly<{ version?: number; key?: string }> = {},
    ): Promise<Answer> => {
      try {
        const [row] = await as<{ points: string; occurrence: number }>(
          { playerId: operator },
          "SELECT points, occurrence FROM operator_complete_quest($1, $2, $3, $4)",
          [quest, scanned, fields.version ?? 1, fields.key ?? randomUUID()],
        );
        return {
          outcome: "completed",
          points: Number(row?.points),
          occurrence: Number(row?.occurrence),
        };
      } catch (error) {
        const pg = error as { code?: string; detail?: string };
        return { outcome: "refused", refusal: String(pg.code), detail: pg.detail ?? null };
      }
    };

    /**
     * The practice answer for this case, with the whole database unchanged by it; then the real door's answer for the
     * same case, which must be the same.
     */
    const practisedAsReal = async (
      operator: string,
      quest: string,
      scanned: string,
      version = 1,
    ) => {
      const before = await fingerprint(db.owner);
      const practised = await practice(operator, quest, scanned, version);
      expect(await fingerprint(db.owner)).toEqual(before);
      expect(await real(operator, quest, scanned, { version })).toEqual(practised);
      return practised;
    };

    const score = async (enrollment: string) =>
      (
        await owner<{ score: string; balance: string; entries: string; completions: string }>(
          `SELECT n.score, n.balance,
                (SELECT count(*) FROM ledger_entry l WHERE l.enrollment_id = n.id) AS entries,
                (SELECT count(*) FROM quest_completion c WHERE c.enrollment_id = n.id) AS completions
         FROM enrollment n WHERE n.id = $1`,
          [enrollment],
        )
      )[0];

    /** A Scheduled event starting tomorrow with an open rehearsal, a station and a rehearsal account in it. */
    const rehearsing = async () => {
      const event = await newEvent("scheduled", { starts: "1 day", ends: "3 days" });
      const quest = await newQuest(event);
      const operator = await newOperator(event);
      const [opened] = await as<{ code: string }>(
        { organizerId: ids.orgA, staffUserId: ownerA },
        "SELECT open_rehearsal($1, $2) AS code",
        [event, newRehearsalCode()],
      );
      const player = await newPlayer();
      const [joined] = await as<{ enrollment_id: string }>(
        { playerId: player },
        "SELECT * FROM join_rehearsal($1, '1')",
        [opened?.code],
      );
      return { event, quest, operator, player, enrollment: joined?.enrollment_id ?? "" };
    };

    /** A live event in Riyadh's zone whose day began at the hour about three hours ago, in the event's own clock. */
    const dayEvent = async () => {
      const event = await newEvent();
      const dayStart = new Date(Math.floor((Date.now() - 3 * HOUR) / HOUR) * HOUR);
      await owner("UPDATE event SET timezone = 'Asia/Riyadh', day_start_hour = $2 WHERE id = $1", [
        event,
        (dayStart.getUTCHours() + 3) % 24,
      ]);
      return { event, dayStart };
    };
    /** `count` completions of the quest by one player, at one moment. */
    const doneAt = async (event: string, quest: string, at: Date | string, count = 1) => {
      const { enrollment } = await member(event);
      await owner(
        `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                     idempotency_key, created_at)
       SELECT $1, $2, $3, $4, n, 'code', 'today-' || n, $5::timestamptz FROM generate_series(1, $6) n`,
        [ids.orgA, event, enrollment, quest, at, count],
      );
      return enrollment;
    };
    const today = async (operator: string, event: string, quest: string) =>
      (
        await as<{ today: string; last_hour: string }>(
          { playerId: operator },
          "SELECT today, last_hour FROM operator_station_today($1, $2)",
          [event, quest],
        )
      ).map((row) => [Number(row.today), Number(row.last_hour)]);
    const refusal = (operator: string, event: string, quest: string) =>
      today(operator, event, quest).then(
        () => undefined,
        (error: { code?: string }) => error.code,
      );

    /** A running community goal counting the quest's completions; its goal step pays points or unlocks a quest. */
    const goal = async (event: string, quest: string, unlocks: string | null) => {
      const [made] = await owner<{ id: string }>(
        `INSERT INTO community_goal (organizer_id, event_id, title_en, measure, quest_id, target, starts_at, ends_at,
                                   status)
       VALUES ($1, $2, 'Together', 'completions', $3, 1, now() - interval '10 minutes', now() + interval '1 hour',
               'running') RETURNING id`,
        [ids.orgA, event, quest],
      );
      await owner(
        `INSERT INTO community_step (event_id, goal_id, threshold, is_goal, reward, points, unlock_quest_id)
       VALUES ($1, $2, 1, true, $3, $4, $5)`,
        [
          event,
          made?.id,
          unlocks === null ? "points" : "unlock",
          unlocks === null ? 5 : null,
          unlocks,
        ],
      );
    };

    describe("green, and nothing is written", () => {
      it("fingerprints only as a superuser (CTO code review, MINOR-3)", async () => {
        await expect(fingerprint(db.app)).rejects.toThrow(/superuser/);
      });

      it("shows a scan station's points, and a real scan afterwards pays them (the positive control)", async () => {
        const event = await newEvent();
        const quest = await newQuest(event);
        const operator = await newOperator(event);
        const { player, enrollment } = await member(event);
        const before = await fingerprint(db.owner);
        expect(await practice(operator, quest, player)).toEqual({
          outcome: "completed",
          points: 15,
          occurrence: 1,
        });
        expect(await fingerprint(db.owner)).toEqual(before);
        expect(await score(enrollment)).toEqual({
          score: "0",
          balance: "0",
          entries: "0",
          completions: "0",
        });
        expect(await real(operator, quest, player)).toEqual({
          outcome: "completed",
          points: 15,
          occurrence: 1,
        });
        expect(await fingerprint(db.owner)).not.toEqual(before);
        expect(await score(enrollment)).toMatchObject({ score: "15", completions: "1" });
      });

      it("shows a challenge station's green", async () => {
        const event = await newEvent();
        const quest = await newQuest(event, { type: "challenge" });
        const operator = await newOperator(event);
        const { player } = await member(event);
        expect(await practisedAsReal(operator, quest, player)).toEqual({
          outcome: "completed",
          points: 15,
          occurrence: 1,
        });
      });

      it("shows a repeatable quest's next occurrence and stores none", async () => {
        const event = await newEvent();
        const quest = await newQuest(event, { repeatCap: 3 });
        const operator = await newOperator(event);
        const colleague = await newOperator(event);
        const { player } = await member(event);
        await real(colleague, quest, player);
        expect(await practisedAsReal(operator, quest, player)).toEqual({
          outcome: "completed",
          points: 15,
          occurrence: 2,
        });
      });

      it("shows a running flash boost's doubled points and writes no bonus, XP or ledger entry", async () => {
        const event = await newEvent();
        const category = await newCategory(event, 40);
        const quest = await newQuest(event, { category });
        await owner(
          `INSERT INTO boost (organizer_id, event_id, category_id, starts_at, ends_at)
         VALUES ($1, $2, $3, now() - interval '5 minutes', now() + interval '30 minutes')`,
          [ids.orgA, event, category],
        );
        const operator = await newOperator(event);
        const { player, enrollment } = await member(event);
        expect(await practisedAsReal(operator, quest, player)).toEqual({
          outcome: "completed",
          points: 30,
          occurrence: 1,
        });
        // The real scan afterwards paid the boosted points and the category's bonus: the practice wrote neither.
        const kinds = await owner<{ kind: string }>(
          "SELECT kind FROM ledger_entry WHERE enrollment_id = $1 ORDER BY kind",
          [enrollment],
        );
        expect(kinds.map((row) => row.kind)).toEqual(["bonus", "quest"]);
      });
    });

    describe("orange and red, each the real door's answer", () => {
      it("is orange for a player who already completed it", async () => {
        const event = await newEvent();
        const quest = await newQuest(event);
        const operator = await newOperator(event);
        const { player } = await member(event);
        await real(operator, quest, player);
        expect(await practisedAsReal(operator, quest, player)).toMatchObject({ refusal: "QD409" });
      });

      it("refuses an unknown quest (OQ404), a non-operator (OP403) and an operator without scanning (OA403)", async () => {
        const event = await newEvent();
        const quest = await newQuest(event);
        const { player } = await member(event);
        const operator = await newOperator(event);
        expect(await practisedAsReal(operator, randomUUID(), player)).toMatchObject({
          refusal: "OQ404",
        });
        expect(await practisedAsReal(await newPlayer(), quest, player)).toMatchObject({
          refusal: "OP403",
        });
        const awarder = await newOperator(event, { abilities: ["award"] });
        expect(await practisedAsReal(awarder, quest, player)).toMatchObject({ refusal: "OA403" });
      });

      it("refuses outside the quest limit (OS403), a self-scan (OY409) and an earlier My QR (OM422)", async () => {
        const event = await newEvent();
        const quest = await newQuest(event);
        const other = await newQuest(event);
        const { player } = await member(event);
        const limited = await newOperator(event, { quests: [other] });
        expect(await practisedAsReal(limited, quest, player)).toMatchObject({ refusal: "OS403" });
        const operator = await newOperator(event);
        expect(await practisedAsReal(operator, quest, operator)).toMatchObject({
          refusal: "OY409",
        });
        expect(await practisedAsReal(operator, quest, player, 2)).toMatchObject({
          refusal: "OM422",
        });
      });

      it("refuses a player not in the event (QC404) and one who left or was banned (QC403)", async () => {
        const event = await newEvent();
        const quest = await newQuest(event);
        const operator = await newOperator(event);
        expect(await practisedAsReal(operator, quest, await newPlayer())).toMatchObject({
          refusal: "QC404",
        });
        for (const status of ["left", "banned"]) {
          const { player } = await member(event, status);
          expect(await practisedAsReal(operator, quest, player)).toMatchObject({
            refusal: "QC403",
            detail: status,
          });
        }
      });

      it("refuses a quest that is not open (QN403): a scheduled and an ended event", async () => {
        const scheduled = await newEvent("scheduled", { starts: "1 day", ends: "2 days" });
        const ended = await newEvent("ended", { starts: "-2 days", ends: "-1 day" });
        for (const event of [scheduled, ended]) {
          const quest = await newQuest(event);
          const operator = await newOperator(event);
          const { player } = await member(event);
          expect(await practisedAsReal(operator, quest, player)).toMatchObject({
            refusal: "QN403",
          });
        }
      });

      it("refuses a quest without My QR (QV422) and an operator who may not play (QP403)", async () => {
        const event = await newEvent();
        const operator = await newOperator(event);
        const { player } = await member(event);
        const byCode = await newQuest(event, { verification: ["quest_qr"] });
        expect(await practisedAsReal(operator, byCode, player)).toMatchObject({ refusal: "QV422" });
        // QP403 is raised by the ledger's trigger, after the completion row was written: the undo removes that too.
        const quest = await newQuest(event);
        const colleague = await newOperator(event);
        await enroll(event, colleague);
        expect(await practisedAsReal(operator, quest, colleague)).toMatchObject({
          refusal: "QP403",
        });
      });
    });

    describe("community and passport effects (CTO code review, MINOR-2)", () => {
      it("practises a scan a running community goal counts, and writes no step, reach or contributor", async () => {
        const event = await newEvent();
        const quest = await newQuest(event);
        await goal(event, quest, null);
        const operator = await newOperator(event);
        const { player } = await member(event);
        expect(await practisedAsReal(operator, quest, player)).toMatchObject({
          outcome: "completed",
        });
      });

      it("refuses a community-locked station (QN403 community_locked), as the real door does", async () => {
        const event = await newEvent();
        const counted = await newQuest(event);
        const locked = await newQuest(event);
        await goal(event, counted, locked);
        const operator = await newOperator(event);
        const { player } = await member(event);
        expect(await practisedAsReal(operator, locked, player)).toEqual({
          outcome: "refused",
          refusal: "QN403",
          detail: "community_locked",
        });
      });

      it("refuses a passport quest (QV422): it cannot take My QR, so a station never stamps, and no stamp is written", async () => {
        const event = await newEvent();
        const category = await newCategory(event);
        // A passport and its step in one transaction: its step count is checked at the commit.
        await owner("BEGIN");
        const [made] = await owner<{ id: string }>(
          `INSERT INTO quest (event_id, category_id, type, title_en, points, visible, type_config, verification)
         VALUES ($1, $2, 'passport', 'Booths', 15, true, '{"needed":1}', '{}') RETURNING id`,
          [event, category],
        );
        const passport = made?.id ?? "";
        await owner(
          "INSERT INTO passport_step (event_id, quest_id, name_en) VALUES ($1, $2, 'Gate')",
          [event, passport],
        );
        await owner("COMMIT");
        const operator = await newOperator(event);
        const { enrollment, player } = await member(event);
        expect(await practisedAsReal(operator, passport, player)).toMatchObject({
          refusal: "QV422",
        });
        expect(
          await owner("SELECT 1 FROM passport_stamp WHERE enrollment_id = $1", [enrollment]),
        ).toEqual([]);
      });
    });

    describe("FR-929's two cases, keys and locks", () => {
      it("practises green with nothing paid, pays for real with practice off, then practises orange", async () => {
        const event = await newEvent();
        const quest = await newQuest(event);
        const operator = await newOperator(event);
        const { player, enrollment } = await member(event);
        expect(await practice(operator, quest, player)).toMatchObject({ outcome: "completed" });
        expect(await score(enrollment)).toMatchObject({ score: "0", entries: "0" });
        expect(await real(operator, quest, player)).toMatchObject({
          outcome: "completed",
          points: 15,
        });
        expect(await score(enrollment)).toMatchObject({ score: "15", entries: "1" });
        expect(await practice(operator, quest, player)).toMatchObject({ refusal: "QD409" });
      });

      it("leaves a real scan's key to replay its first answer after a practice scan", async () => {
        const event = await newEvent();
        const quest = await newQuest(event, { repeatCap: 5 });
        const operator = await newOperator(event);
        const { player, enrollment } = await member(event);
        const key = randomUUID();
        const first = await as<{ completion_id: string; replayed: boolean }>(
          { playerId: operator },
          "SELECT completion_id, replayed FROM operator_complete_quest($1, $2, 1, $3)",
          [quest, player, key],
        );
        expect(await practice(operator, quest, player)).toMatchObject({ refusal: "QD409" });
        const retry = await as<{ completion_id: string; replayed: boolean }>(
          { playerId: operator },
          "SELECT completion_id, replayed FROM operator_complete_quest($1, $2, 1, $3)",
          [quest, player, key],
        );
        expect(retry).toEqual([{ completion_id: first[0]?.completion_id, replayed: true }]);
        expect(await score(enrollment)).toMatchObject({ completions: "1" });
      });

      it("holds no advisory lock and no row lock once it returns, inside the still-open transaction (MINOR-2)", async () => {
        const event = await newEvent();
        const quest = await newQuest(event);
        const operator = await newOperator(event);
        const { player, enrollment } = await member(event);
        const client = await pool.connect();
        const nowait = () =>
          db.owner.query("SELECT 1 FROM enrollment WHERE id = $1 FOR UPDATE NOWAIT", [enrollment]);
        try {
          await client.query("BEGIN");
          await setLocalSettings(client, [["app.player_id", operator]]);
          const { rows } = await client.query<PracticeRow>(
            "SELECT * FROM operator_practice_scan($1, $2, 1)",
            [quest, player],
          );
          expect(rows[0]?.outcome).toBe("completed");
          const advisory = await client.query(
            "SELECT 1 FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'advisory'",
          );
          expect(advisory.rows).toEqual([]);
          await db.owner.query("BEGIN");
          await expect(nowait()).resolves.toBeDefined();
          await db.owner.query("ROLLBACK");
          // The positive control: the real door in the same open transaction keeps the enrollment locked.
          await client.query("SELECT * FROM operator_complete_quest($1, $2, 1, $3)", [
            quest,
            player,
            randomUUID(),
          ]);
          await db.owner.query("BEGIN");
          await expect(nowait()).rejects.toMatchObject({ code: "55P03" });
          await db.owner.query("ROLLBACK");
        } finally {
          await client.query("ROLLBACK");
          client.release();
        }
      });

      it("crossed with a real scan of the same player: one completion, and the practice changes nothing", async () => {
        const event = await newEvent();
        const quest = await newQuest(event);
        const operator = await newOperator(event);
        const colleague = await newOperator(event);
        const { player, enrollment } = await member(event);
        const realClient = await pool.connect();
        const practiceClient = await pool.connect();
        try {
          await realClient.query("BEGIN");
          await setLocalSettings(realClient, [["app.player_id", colleague]]);
          await realClient.query("SELECT * FROM operator_complete_quest($1, $2, 1, $3)", [
            quest,
            player,
            randomUUID(),
          ]);
          await practiceClient.query("BEGIN");
          await setLocalSettings(practiceClient, [["app.player_id", operator]]);
          const waiting = practiceClient.query<PracticeRow>(
            "SELECT * FROM operator_practice_scan($1, $2, 1)",
            [quest, player],
          );
          await waitForLockWait();
          await realClient.query("COMMIT");
          const afterReal = await fingerprint(db.owner);
          const { rows } = await waiting;
          expect(answerOf(rows[0] as PracticeRow)).toMatchObject({ refusal: "QD409" });
          await practiceClient.query("COMMIT");
          expect(await fingerprint(db.owner)).toEqual(afterReal);
          expect(await score(enrollment)).toMatchObject({ completions: "1", entries: "1" });
        } finally {
          realClient.release();
          practiceClient.release();
        }
      });

      it("crossed the other way: a practice in an open transaction does not hold up the real scan", async () => {
        const event = await newEvent();
        const quest = await newQuest(event);
        const operator = await newOperator(event);
        const colleague = await newOperator(event);
        const { player, enrollment } = await member(event);
        const practiceClient = await pool.connect();
        try {
          await practiceClient.query("BEGIN");
          await setLocalSettings(practiceClient, [["app.player_id", operator]]);
          const { rows } = await practiceClient.query<PracticeRow>(
            "SELECT * FROM operator_practice_scan($1, $2, 1)",
            [quest, player],
          );
          expect(rows[0]?.outcome).toBe("completed");
          expect(await real(colleague, quest, player)).toMatchObject({ outcome: "completed" });
          const afterReal = await fingerprint(db.owner);
          await practiceClient.query("COMMIT");
          expect(await fingerprint(db.owner)).toEqual(afterReal);
          expect(await score(enrollment)).toMatchObject({ completions: "1" });
        } finally {
          practiceClient.release();
        }
      });
    });

    /** Waits until some backend of this database waits on a lock (the second scan queued behind the first). */
    const waitForLockWait = async () => {
      for (let tries = 0; tries < 200; tries += 1) {
        const { rows } = await db.owner.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        );
        if ((rows[0]?.n ?? 0) > 0) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("the second scan never waited on the first");
    };

    describe("rehearsal", () => {
      it("practises a green on a rehearsal account before the event opens, and stores nothing", async () => {
        const state = await rehearsing();
        expect(await practisedAsReal(state.operator, state.quest, state.player)).toEqual({
          outcome: "completed",
          points: 15,
          occurrence: 1,
        });
      });

      it("answers PW409 while the go-live wipe is owed, wipes nothing, and the next real call wipes (MINOR-3)", async () => {
        const state = await rehearsing();
        const guest = await member(state.event);
        await real(state.operator, state.quest, state.player);
        await owner("UPDATE event SET status = 'live' WHERE id = $1", [state.event]);
        const before = await fingerprint(db.owner);
        expect(await practice(state.operator, state.quest, state.player)).toEqual({
          outcome: "refused",
          refusal: "PW409",
          detail: null,
        });
        expect(await fingerprint(db.owner)).toEqual(before);
        // Only an operator of the event learns the wipe is owed; anyone else gets the door's own refusal.
        expect(await practice(await newPlayer(), state.quest, state.player)).toMatchObject({
          refusal: "OP403",
        });
        expect(await real(state.operator, state.quest, guest.player)).toMatchObject({
          outcome: "completed",
        });
        const [wiped] = await owner<{ live_wiped_at: Date | null }>(
          "SELECT live_wiped_at FROM event_rehearsal WHERE event_id = $1",
          [state.event],
        );
        expect(wiped?.live_wiped_at).not.toBeNull();
        expect(await owner("SELECT 1 FROM enrollment WHERE id = $1", [state.enrollment])).toEqual(
          [],
        );
      });
    });

    describe("across organizers", () => {
      it("gives an operator of one organizer's event nothing of another's: no practice, no numbers", async () => {
        const event = await newEvent();
        const operator = await newOperator(event);
        const category = await owner<{ id: string }>(
          "INSERT INTO category (event_id, name_en, position) VALUES ($1, 'B gate', 0) RETURNING id",
          [ids.eventB],
        );
        const questB = await newQuest(ids.eventB, { category: category[0]?.id ?? "" });
        const before = await fingerprint(db.owner);
        expect(await practice(operator, questB, ids.playerB)).toMatchObject({ refusal: "OP403" });
        expect(await fingerprint(db.owner)).toEqual(before);
        const read = await as(
          { playerId: operator },
          "SELECT * FROM operator_station_today($1, $2)",
          [ids.eventB, questB],
        ).then(
          () => undefined,
          (error: { code?: string }) => error.code,
        );
        expect(read).toBe("OP403");
      });
    });

    describe("My station today (FR-928)", () => {
      it("counts 40 today and 6 in the last hour, by every method and operator", async () => {
        const { event } = await dayEvent();
        const quest = await newQuest(event, { repeatCap: 100 });
        const operator = await newOperator(event);
        await doneAt(event, quest, ago(120), 33);
        await doneAt(event, quest, ago(10), 6);
        const { player } = await member(event);
        await real(await newOperator(event), quest, player);
        // The real scan just now is in the last hour as well.
        expect(await today(operator, event, quest)).toEqual([[40, 7]]);
      });

      it("starts the day at the event's day start hour in its zone, and the hour at 60 minutes", async () => {
        const { event, dayStart } = await dayEvent();
        const quest = await newQuest(event, { repeatCap: 100 });
        const operator = await newOperator(event);
        await doneAt(event, quest, new Date(dayStart.getTime() - 60_000));
        await doneAt(event, quest, new Date(dayStart.getTime() + 60_000));
        expect(await today(operator, event, quest)).toEqual([[1, 0]]);
        await doneAt(event, quest, ago(61));
        await doneAt(event, quest, ago(59));
        expect(await today(operator, event, quest)).toEqual([[3, 1]]);
      });

      it("counts no other quest's completions", async () => {
        const { event } = await dayEvent();
        const quest = await newQuest(event);
        const other = await newQuest(event);
        const operator = await newOperator(event);
        await doneAt(event, other, ago(5), 4);
        expect(await today(operator, event, quest)).toEqual([[0, 0]]);
      });

      it("counts a rehearsal completion while it exists, and not after the go-live wipe", async () => {
        const event = await newEvent("scheduled", { starts: "1 day", ends: "3 days" });
        const quest = await newQuest(event);
        const operator = await newOperator(event);
        const [opened] = await as<{ code: string }>(
          { organizerId: ids.orgA, staffUserId: ownerA },
          "SELECT open_rehearsal($1, $2) AS code",
          [event, newRehearsalCode()],
        );
        const player = await newPlayer();
        await as({ playerId: player }, "SELECT * FROM join_rehearsal($1, '1')", [opened?.code]);
        expect(await real(operator, quest, player)).toMatchObject({ outcome: "completed" });
        expect(await today(operator, event, quest)).toEqual([[1, 1]]);
        await owner("UPDATE event SET status = 'live' WHERE id = $1", [event]);
        await as({}, "SELECT ensure_rehearsal_wiped($1)", [event]);
        expect(await today(operator, event, quest)).toEqual([[0, 0]]);
      });

      it("refuses a non-operator (OP403), a non-station or another event's quest (OQ404), outside the limit (OS403)", async () => {
        const { event } = await dayEvent();
        const quest = await newQuest(event);
        const other = await newQuest(event);
        const byCode = await newQuest(event, { verification: ["quest_qr"] });
        const elsewhere = await newQuest(await newEvent());
        const operator = await newOperator(event);
        expect(await refusal(await newPlayer(), event, quest)).toBe("OP403");
        expect(await refusal(operator, event, byCode)).toBe("OQ404");
        expect(await refusal(operator, event, elsewhere)).toBe("OQ404");
        expect(await refusal(operator, event, randomUUID())).toBe("OQ404");
        const limited = await newOperator(event, { quests: [other] });
        expect(await refusal(limited, event, quest)).toBe("OS403");
        expect(await today(limited, event, other)).toEqual([[0, 0]]);
        expect(await today(operator, event, other)).toEqual([[0, 0]]);
      });
    });
  },
);
