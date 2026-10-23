import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext, type RequestContext } from "#src/db/context";
import {
  TEST_DATABASE_URL,
  addMember,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

type Row = Record<string, unknown>;
type Stamp = {
  quest_id: string;
  completion_id: string | null;
  stamped: boolean;
  done: number;
  needed: number;
  score: string;
  replayed: boolean;
};

const refusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
    return "none";
  } catch (error) {
    const pg = error as { code?: string; detail?: string };
    // A constraint's DETAIL names the row; only the code tells the refusal apart.
    return pg.detail === undefined || pg.detail === "" || pg.code?.startsWith("23") === true
      ? `${pg.code}`
      : `${pg.code}:${pg.detail}`;
  }
};

const as = (player: string): RequestContext => ({ playerId: player });

/**
 * Passport quests in the database (T-304b, migration 0045, ADR-203): steps in any order, paid once on the needed-th
 * stamp, the replay, every refusal, the shape held by triggers, rehearsal, erasure and delete.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("passport quests (database)", () => {
  let db: TestDatabase;
  let pool: Pool;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let ownerA = "";
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new Pool({ connectionString: db.appUrl, max: 6 });
    ids = await seedTwoTenants(db.owner);
    ownerA = await addMember(db.owner, ids.orgA, "owner");
  });
  afterAll(async () => {
    await pool.end();
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const query = async <T extends Row>(
    context: RequestContext,
    sql: string,
    values: unknown[] = [],
  ) => {
    const client: PoolClient = await pool.connect();
    try {
      return await withRequestContext(
        client,
        context,
        async () => (await client.query<T>(sql, values)).rows,
      );
    } finally {
      client.release();
    }
  };
  const team = (): RequestContext => ({ organizerId: ids.orgA, staffUserId: ownerA });

  const newEvent = async (status = "live"): Promise<string> => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Passport Fest', $3, now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
      [ids.orgA, `PAS${counter}`, status],
    );
    return event?.id ?? "";
  };
  const categoryOf = async (event: string, bonus = 0) =>
    (
      await owner<{ id: string }>(
        "UPDATE category SET completion_bonus = $2 WHERE event_id = $1 RETURNING id",
        [event, bonus],
      )
    )[0]?.id ?? "";
  /** A passport of `steps` steps needing `needed`, written in one transaction as the builder does. */
  const newPassport = async (
    event: string,
    options: { steps?: number; needed?: number; points?: number; visible?: boolean } = {},
  ) => {
    const client = db.owner;
    try {
      await client.query("BEGIN");
      const category = (
        await client.query<{ id: string }>("SELECT id FROM category WHERE event_id = $1", [event])
      ).rows[0]?.id;
      const quest = (
        await client.query<{ id: string }>(
          `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config, visible, verification)
           VALUES ($1, $2, 'passport', 'Booths', $3, $4, $5, '{}') RETURNING id`,
          [
            event,
            category,
            options.points ?? 40,
            { needed: options.needed ?? 2 },
            options.visible ?? true,
          ],
        )
      ).rows[0]?.id as string;
      const steps: string[] = [];
      for (let i = 0; i < (options.steps ?? 3); i += 1) {
        const step = await client.query<{ id: string }>(
          "INSERT INTO passport_step (event_id, quest_id, name_en, position) VALUES ($1, $2, $3, $4) RETURNING id",
          [event, quest, `Booth ${i + 1}`, i],
        );
        steps.push(step.rows[0]?.id as string);
      }
      await client.query("COMMIT");
      return { quest, steps };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  };
  const member = async (event: string, via = "code") => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`pa_player_${counter}`],
    );
    const [made] = await owner<{ id: string }>(
      "INSERT INTO enrollment (organizer_id, event_id, player_id, joined_via) VALUES ($1, $2, $3, $4) RETURNING id",
      [ids.orgA, event, player?.id, via],
    );
    return { player: player?.id ?? "", enrollment: made?.id ?? "" };
  };
  const stamp = async (player: string, step: string, key: string = randomUUID(), version = 1) =>
    (
      await query<Stamp>(as(player), "SELECT * FROM stamp_step($1, $2, $3, NULL)", [
        step,
        version,
        key,
      ])
    )[0];
  const credits = async (enrollment: string) =>
    owner<{ kind: string; score_delta: string }>(
      "SELECT kind, score_delta FROM ledger_entry WHERE enrollment_id = $1 ORDER BY id",
      [enrollment],
    );

  describe("stamping and paying", () => {
    it("reads 4 of 5 unpaid, then pays once on the fifth step, with XP and the category bonus", async () => {
      const event = await newEvent();
      await categoryOf(event, 10);
      const { quest, steps } = await newPassport(event, { steps: 8, needed: 5 });
      const { player, enrollment } = await member(event);
      for (const step of steps.slice(0, 4)) {
        expect(await stamp(player, step)).toMatchObject({ stamped: true, completion_id: null });
      }
      expect(await credits(enrollment)).toEqual([]);
      expect(
        await query(
          as(player),
          "SELECT steps_done, steps_needed, done FROM member_event_quests($1)",
          [event],
        ),
      ).toEqual([{ steps_done: 4, steps_needed: 5, done: 0 }]);
      const fifth = await stamp(player, steps[6] ?? "");
      expect(fifth).toMatchObject({
        quest_id: quest,
        stamped: true,
        done: 5,
        needed: 5,
        score: "50",
      });
      expect(fifth?.completion_id).not.toBeNull();
      expect(await credits(enrollment)).toEqual([
        { kind: "quest", score_delta: "40" },
        { kind: "bonus", score_delta: "10" },
      ]);
      expect(
        await owner(
          "SELECT method, idempotency_key FROM quest_completion WHERE enrollment_id = $1",
          [enrollment],
        ),
      ).toEqual([{ method: "passport", idempotency_key: `pass:${quest}` }]);
      expect(
        await owner(
          "SELECT count(*)::int AS n FROM xp_entry x JOIN ledger_entry l ON l.id = x.ledger_entry_id WHERE l.enrollment_id = $1",
          [enrollment],
        ),
      ).toEqual([{ n: 1 }]);
      expect(await refusal(stamp(player, steps[7] ?? ""))).toBe("QD409:1");
    });

    it("writes nothing for a step stamped before", async () => {
      const event = await newEvent();
      const { steps } = await newPassport(event);
      const { player, enrollment } = await member(event);
      await stamp(player, steps[0] ?? "");
      expect(await stamp(player, steps[0] ?? "")).toMatchObject({ stamped: false, done: 1 });
      expect(
        await owner("SELECT count(*)::int AS n FROM passport_stamp WHERE enrollment_id = $1", [
          enrollment,
        ]),
      ).toEqual([{ n: 1 }]);
    });

    it("replays a key with the first answer, the paying stamp's completion too, and refuses it on another step", async () => {
      const event = await newEvent();
      const { steps } = await newPassport(event);
      const { player } = await member(event);
      const first = await stamp(player, steps[0] ?? "", "k1");
      expect(await stamp(player, steps[0] ?? "", "k1")).toEqual({ ...first, replayed: true });
      const paying = await stamp(player, steps[1] ?? "", "k2");
      expect(paying?.completion_id).not.toBeNull();
      expect(await stamp(player, steps[1] ?? "", "k2")).toEqual({ ...paying, replayed: true });
      expect(await refusal(stamp(player, steps[2] ?? "", "k1"))).toBe("QK422");
    });

    it("pays once for two parallel last stamps", async () => {
      const event = await newEvent();
      const { steps } = await newPassport(event, { steps: 3, needed: 2 });
      const { player, enrollment } = await member(event);
      await stamp(player, steps[0] ?? "");
      const results = await Promise.allSettled([
        stamp(player, steps[1] ?? ""),
        stamp(player, steps[2] ?? ""),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(await credits(enrollment)).toEqual([{ kind: "quest", score_delta: "40" }]);
    });

    it("never pays again after the passport's credit is removed", async () => {
      const event = await newEvent();
      const { steps } = await newPassport(event, { steps: 3, needed: 1 });
      const { player, enrollment } = await member(event);
      await stamp(player, steps[0] ?? "");
      const [credit] = await owner<{ id: string }>(
        "SELECT id FROM ledger_entry WHERE enrollment_id = $1 AND kind = 'quest'",
        [enrollment],
      );
      await query(team(), "SELECT * FROM remove_award($1, $2, 'Cheating', $3, $4)", [
        event,
        credit?.id,
        randomUUID(),
        randomUUID(),
      ]);
      expect(await refusal(stamp(player, steps[1] ?? ""))).toBe("QD409:1");
    });
  });

  describe("refusals", () => {
    it("refuses an old step print, checked after a replay", async () => {
      const event = await newEvent();
      const { steps } = await newPassport(event);
      const { player } = await member(event);
      await stamp(player, steps[0] ?? "", "same");
      await owner("UPDATE passport_step SET qr_version = 2 WHERE id = $1", [steps[0]]);
      expect(await stamp(player, steps[0] ?? "", "same")).toMatchObject({ replayed: true });
      expect(await refusal(stamp(player, steps[1] ?? ""))).toBe("none");
      await owner("UPDATE passport_step SET qr_version = 2 WHERE id = $1", [steps[2]]);
      const other = await member(event);
      expect(await refusal(stamp(other.player, steps[2] ?? ""))).toBe("QV422:old");
      expect(await refusal(stamp(other.player, steps[2] ?? "", randomUUID(), 2))).toBe("none");
    });

    it("refuses the reserved key prefixes on a stamp, a completion and a submission", async () => {
      const event = await newEvent();
      const { steps } = await newPassport(event);
      const { player } = await member(event);
      for (const key of ["pass:x", "sub:x", "quiz:x", ""]) {
        expect(await refusal(stamp(player, steps[0] ?? "", key)), key).toBe("QK422");
      }
      const [quest] = await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
         SELECT $1, id, 'enter_code', 'Code', 5, '{"code":"ABC"}' FROM category WHERE event_id = $1 RETURNING id`,
        [event],
      );
      expect(
        await refusal(
          query(
            as(player),
            "SELECT * FROM complete_quest($1, 'code', NULL, 'ABC', 'pass:x', NULL)",
            [quest?.id],
          ),
        ),
      ).toBe("QK422");
      expect(
        await refusal(
          query(as(player), "SELECT * FROM submit_quest($1, 'hi', '1.0', 'pass:x')", [quest?.id]),
        ),
      ).toBe("QK422");
    });

    it("refuses every gate: not live, hidden, closed, out of the audience, a locked category, an operator", async () => {
      const event = await newEvent();
      const { quest, steps } = await newPassport(event, { steps: 3, needed: 3 });
      const { player } = await member(event);
      await owner("UPDATE quest SET visible = false WHERE id = $1", [quest]);
      expect(await refusal(stamp(player, steps[0] ?? ""))).toBe("QN403:hidden");
      await owner(
        "UPDATE quest SET visible = true, closes_at = now() - interval '1 minute', opens_at = NULL WHERE id = $1",
        [quest],
      );
      expect(await refusal(stamp(player, steps[0] ?? ""))).toBe("QN403:ended");
      await owner("UPDATE quest SET closes_at = NULL WHERE id = $1", [quest]);
      await owner("UPDATE category SET opens_at = now() + interval '1 hour' WHERE event_id = $1", [
        event,
      ]);
      expect(await refusal(stamp(player, steps[0] ?? ""))).toBe("QN403:category_not_started");
      await owner(
        "UPDATE category SET opens_at = NULL, audience_kind = 'tag', audience_values = '{vip}' WHERE event_id = $1",
        [event],
      );
      expect(await refusal(stamp(player, steps[0] ?? ""))).toBe("QN403:not_for_you");
      await owner(
        "UPDATE category SET audience_kind = NULL, audience_values = NULL WHERE event_id = $1",
        [event],
      );
      await owner(
        "INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities, can_play) VALUES ($1, $2, $3, '{review}', false)",
        [ids.orgA, event, player],
      );
      expect(await refusal(stamp(player, steps[0] ?? ""))).toBe("QP403");
      await owner("UPDATE event SET status = 'draft' WHERE id = $1", [event]);
      const other = await member(event);
      expect(await refusal(stamp(other.player, steps[0] ?? ""))).toBe("QN403:event_not_live");
    });

    it("refuses a stranger, an unknown step and a stamp after a manual award", async () => {
      const event = await newEvent();
      const { quest, steps } = await newPassport(event);
      const { player, enrollment } = await member(event);
      const stranger = await member(await newEvent());
      expect(await refusal(stamp(stranger.player, steps[0] ?? ""))).toBe("QC404");
      expect(await refusal(stamp(player, randomUUID()))).toBe("QC404");
      await query(team(), "SELECT * FROM staff_award($1, $2, $3, NULL, 'Helped', $4, $5)", [
        event,
        enrollment,
        quest,
        randomUUID(),
        randomUUID(),
      ]);
      expect(await refusal(stamp(player, steps[0] ?? ""))).toBe("QD409:1");
    });
  });

  describe("the passport's shape", () => {
    it("refuses fewer steps than needed, a 31st step, a step on another type and needed out of range", async () => {
      const event = await newEvent();
      expect(await refusal(newPassport(event, { steps: 1, needed: 2 }))).toBe("QT422:needed");
      expect(await refusal(newPassport(event, { steps: 0, needed: 1, visible: false }))).toBe(
        "QT422:needed",
      );
      expect(await refusal(newPassport(event, { steps: 31, needed: 1 }))).toBe("QT422:steps");
      expect(await refusal(newPassport(event, { steps: 1, needed: 0 }))).toBe("23514");
      expect(await refusal(newPassport(event, { steps: 1, needed: 1.5 }))).toBe("23514");
      const [code] = await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
         SELECT $1, id, 'enter_code', 'Code', 5, '{"code":"ABC"}' FROM category WHERE event_id = $1 RETURNING id`,
        [event],
      );
      expect(
        await refusal(
          owner("INSERT INTO passport_step (event_id, quest_id, name_en) VALUES ($1, $2, 'X')", [
            event,
            code?.id,
          ]),
        ),
      ).toBe("QT422:passport");
      const { quest } = await newPassport(event);
      expect(await refusal(owner("UPDATE quest SET repeat_cap = 2 WHERE id = $1", [quest]))).toBe(
        "23514",
      );
    });

    it("lets needed rise but never fall once stamped, and refuses deleting a stamped step or below needed", async () => {
      const event = await newEvent();
      const { quest, steps } = await newPassport(event, { steps: 4, needed: 2 });
      await owner(`UPDATE quest SET type_config = '{"needed":1}' WHERE id = $1`, [quest]);
      await owner(`UPDATE quest SET type_config = '{"needed":3}' WHERE id = $1`, [quest]);
      const { player } = await member(event);
      await stamp(player, steps[0] ?? "");
      expect(
        await refusal(
          owner(`UPDATE quest SET type_config = '{"needed":2}' WHERE id = $1`, [quest]),
        ),
      ).toBe("QL409");
      await owner(`UPDATE quest SET type_config = '{"needed":4}' WHERE id = $1`, [quest]);
      expect(
        await refusal(
          owner(`UPDATE quest SET type_config = '{"needed":5}' WHERE id = $1`, [quest]),
        ),
      ).toBe("QT422:needed");
      expect(await refusal(owner("DELETE FROM passport_step WHERE id = $1", [steps[0]]))).toBe(
        "23503",
      );
      expect(await refusal(owner("DELETE FROM passport_step WHERE id = $1", [steps[3]]))).toBe(
        "QT422:needed",
      );
      expect(await refusal(owner("UPDATE quest SET type = 'scan_qr' WHERE id = $1", [quest]))).toBe(
        "QL409",
      );
    });

    it("deletes a visible passport with steps and no stamps cleanly, and its category with it", async () => {
      const event = await newEvent();
      const { quest } = await newPassport(event, { steps: 3, needed: 2 });
      await owner("BEGIN");
      await owner("DELETE FROM passport_step WHERE quest_id = $1", [quest]);
      await owner("DELETE FROM quest WHERE id = $1", [quest]);
      await owner("COMMIT");
      expect(await owner("SELECT 1 FROM quest WHERE id = $1", [quest])).toEqual([]);
      const draft = await newEvent("draft");
      await newPassport(draft);
      await owner("DELETE FROM event WHERE id = $1", [draft]);
      expect(await owner("SELECT 1 FROM passport_step WHERE event_id = $1", [draft])).toEqual([]);
    });
  });

  describe("reads", () => {
    it("shows the player the steps they stamped, and nothing to a stranger or of a hidden passport", async () => {
      const event = await newEvent();
      const { quest, steps } = await newPassport(event, { steps: 2, needed: 2 });
      const { player } = await member(event);
      await stamp(player, steps[1] ?? "");
      expect(
        await query(as(player), "SELECT needed, step_id, name_en, done FROM member_passport($1)", [
          quest,
        ]),
      ).toEqual([
        { needed: 2, step_id: steps[0], name_en: "Booth 1", done: false },
        { needed: 2, step_id: steps[1], name_en: "Booth 2", done: true },
      ]);
      const stranger = await member(await newEvent());
      expect(
        await query(as(stranger.player), "SELECT * FROM member_passport($1)", [quest]),
      ).toEqual([]);
      await owner("UPDATE quest SET visible = false WHERE id = $1", [quest]);
      expect(await query(as(player), "SELECT * FROM member_passport($1)", [quest])).toEqual([]);
    });

    it("tells the team which steps were stamped, its own organizer's only", async () => {
      const event = await newEvent();
      const { quest, steps } = await newPassport(event);
      const { player } = await member(event);
      await stamp(player, steps[1] ?? "");
      expect(await query(team(), "SELECT * FROM stamped_steps($1)", [quest])).toEqual([
        { step_id: steps[1] },
      ]);
      expect(
        await query(team(), "SELECT count(*)::int AS n FROM submitters_of(ARRAY[$1]::uuid[])", [
          quest,
        ]),
      ).toEqual([{ n: 1 }]);
      expect(
        await query(
          { organizerId: ids.orgB, staffUserId: randomUUID() },
          "SELECT * FROM stamped_steps($1)",
          [quest],
        ),
      ).toEqual([]);
    });
  });

  describe("rehearsal and erasure", () => {
    it("wipes a rehearsal's stamps", async () => {
      const event = await newEvent("draft");
      await owner(
        "INSERT INTO event_rehearsal (event_id, organizer_id, code) VALUES ($1, $2, 'ABCD-EFGH')",
        [event, ids.orgA],
      );
      const { steps } = await newPassport(event, { steps: 2, needed: 1 });
      const { player } = await member(event, "rehearsal");
      await stamp(player, steps[0] ?? "");
      await owner("SELECT wipe_rehearsal($1, 'go_live', NULL)", [event]);
      expect(await owner("SELECT 1 FROM passport_stamp WHERE event_id = $1", [event])).toEqual([]);
    });

    it("deletes an erased account's stamps and keeps the ledger", async () => {
      const event = await newEvent();
      const { steps } = await newPassport(event, { steps: 2, needed: 1 });
      const { player, enrollment } = await member(event);
      await query(as(player), "SELECT * FROM stamp_step($1, 1, 'k', gen_random_uuid())", [
        steps[0],
      ]);
      await owner("SELECT erase_rows($1, ARRAY[$2]::uuid[], NULL)", [player, enrollment]);
      expect(
        await owner("SELECT 1 FROM passport_stamp WHERE enrollment_id = $1", [enrollment]),
      ).toEqual([]);
      expect(await credits(enrollment)).toHaveLength(1);
    });
  });

  describe("closed doors", () => {
    it("keeps the stamps away from the API role", async () => {
      for (const sql of ["SELECT * FROM passport_stamp", "DELETE FROM passport_stamp"]) {
        await expect(query(team(), sql), sql).rejects.toMatchObject({ code: "42501" });
      }
    });
  });
});
