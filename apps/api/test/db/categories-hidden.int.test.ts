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

const refusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
    return "none";
  } catch (error) {
    const pg = error as { code?: string; detail?: string };
    return pg.detail === undefined || pg.detail === "" ? `${pg.code}` : `${pg.code}:${pg.detail}`;
  }
};

const as = (player: string): RequestContext => ({ playerId: player });
const text = (en: string) => ({ en });
const VOTE = {
  options: [
    { id: "a", text: text("Robots") },
    { id: "b", text: text("Space") },
  ],
};
const QUIZ = {
  questions: [
    {
      id: "q1",
      text: text("Which?"),
      choices: [
        { id: "r", text: text("Right") },
        { id: "w", text: text("Wrong") },
      ],
      right: "r",
    },
  ],
};
const SURVEY = {
  questions: [{ id: "note", text: text("Anything else?"), kind: "text", required: true }],
};

/**
 * Hidden categories in the database (T-304c, migration 0046, ADR-204): unseen by every reader and the public page until
 * the player finds the category's secret code; a find pays nothing and is idempotent; a staff manual award reveals the
 * category on a fresh payment only; the rehearsal wipe, erasure and the closed doors.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("hidden categories (database)", () => {
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

  const newEvent = async (status = "live", organizer = ids.orgA): Promise<string> => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at, access)
       VALUES ($1, $2, 'Hidden Fest', $3, now() - interval '1 hour', now() + interval '1 day', 'public')
       RETURNING id`,
      [organizer, `HID${counter}`, status],
    );
    return event?.id ?? "";
  };
  const joinCode = async (event: string) =>
    (await owner<{ join_code: string }>("SELECT join_code FROM event WHERE id = $1", [event]))[0]
      ?.join_code;
  const newCategory = async (event: string, hidden = true, unlockAfter: string | null = null) =>
    (
      await owner<{ id: string }>(
        `INSERT INTO category (event_id, name_en, hidden, unlock_after, position)
         VALUES ($1, 'Secret', $2, $3, $4) RETURNING id`,
        [event, hidden, unlockAfter, (counter += 1)],
      )
    )[0]?.id ?? "";
  const newQuest = async (
    event: string,
    category: string,
    options: { type?: string; config?: object; verification?: string } = {},
  ) => {
    counter += 1;
    return (
      (
        await owner<{ id: string }>(
          `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config, position, verification)
           VALUES ($1, $2, $3, 'Play', 10, $4, $5, $6) RETURNING id`,
          [
            event,
            category,
            options.type ?? "enter_code",
            JSON.stringify(options.config ?? { code: "ABC" }),
            counter,
            options.verification ?? "{}",
          ],
        )
      )[0]?.id ?? ""
    );
  };
  const member = async (event: string, via = "code", organizer = ids.orgA) => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`hd_player_${counter}`],
    );
    const [made] = await owner<{ id: string }>(
      "INSERT INTO enrollment (organizer_id, event_id, player_id, joined_via) VALUES ($1, $2, $3, $4) RETURNING id",
      [organizer, event, player?.id, via],
    );
    return { player: player?.id ?? "", enrollment: made?.id ?? "" };
  };
  const code = async (player: string, quest: string) =>
    query(as(player), "SELECT * FROM complete_quest($1, 'code', NULL, 'ABC', $2, NULL)", [
      quest,
      randomUUID(),
    ]);
  const reveal = async (player: string, category: string, version = 1) =>
    (
      await query<{ category_id: string; name_en: string; revealed: boolean }>(
        as(player),
        "SELECT * FROM reveal_category($1, $2)",
        [category, version],
      )
    )[0];
  const award = async (event: string, enrollment: string, quest: string, key = randomUUID()) =>
    query(team(), "SELECT * FROM staff_award($1, $2, $3, NULL, 'Helped', $4, $5)", [
      event,
      enrollment,
      quest,
      key,
      randomUUID(),
    ]);
  const seen = async (player: string, event: string) =>
    (
      await query<{ category_id: string }>(
        as(player),
        "SELECT DISTINCT category_id FROM member_event_quests($1)",
        [event],
      )
    ).map((row) => row.category_id);
  const reveals = async (enrollment: string) =>
    owner("SELECT category_id FROM category_reveal WHERE enrollment_id = $1", [enrollment]);
  const score = async (enrollment: string) =>
    (await owner<{ score: string }>("SELECT score FROM enrollment WHERE id = $1", [enrollment]))[0]
      ?.score;

  describe("unseen until found", () => {
    it("keeps a hidden category out of every reader and the public page, and shut to play", async () => {
      const event = await newEvent();
      const secret = await newCategory(event);
      const quest = await newQuest(event, secret);
      const vote = await newQuest(event, secret, { type: "vote", config: VOTE });
      const quiz = await newQuest(event, secret, { type: "quiz", config: QUIZ });
      const survey = await newQuest(event, secret, { type: "survey", config: SURVEY });
      const { player } = await member(event);
      expect(await seen(player, event)).not.toContain(secret);
      expect(await query(as(player), "SELECT * FROM member_vote($1)", [vote])).toEqual([]);
      expect(await query(as(player), "SELECT * FROM member_quiz($1)", [quiz])).toEqual([]);
      expect(await query(as(player), "SELECT member_survey($1) AS s", [survey])).toEqual([
        { s: null },
      ]);
      expect(
        await db.app.query(
          "SELECT category_id FROM public_event_quests($1) WHERE category_id = $2",
          [await joinCode(event), secret],
        ),
      ).toMatchObject({ rowCount: 0 });
      expect(await refusal(code(player, quest))).toBe("QN403:not_for_you");
    });

    it("shows a found category to the finder only, and a second find writes nothing", async () => {
      const event = await newEvent();
      const secret = await newCategory(event);
      const quest = await newQuest(event, secret);
      const finder = await member(event);
      const other = await member(event);
      expect(await reveal(finder.player, secret)).toMatchObject({
        category_id: secret,
        name_en: "Secret",
        revealed: true,
      });
      expect(await seen(finder.player, event)).toContain(secret);
      expect(await seen(other.player, event)).not.toContain(secret);
      expect(await reveal(finder.player, secret)).toMatchObject({ revealed: false });
      expect(await reveals(finder.enrollment)).toHaveLength(1);
      await code(finder.player, quest);
      expect(await score(finder.enrollment)).toBe("10");
      expect(await refusal(code(other.player, quest))).toBe("QN403:not_for_you");
    });

    it("refuses an old code, a category that is not hidden, a stranger and an event not live", async () => {
      const event = await newEvent();
      const secret = await newCategory(event);
      const open = await newCategory(event, false);
      const { player, enrollment } = await member(event);
      await owner("UPDATE category SET reveal_version = 2 WHERE id = $1", [secret]);
      expect(await refusal(reveal(player, secret, 1))).toBe("QV422:old");
      expect(await refusal(reveal(player, open))).toBe("QH422");
      expect(await refusal(reveal(player, randomUUID()))).toBe("QC404");
      const stranger = await member(await newEvent());
      expect(await refusal(reveal(stranger.player, secret, 2))).toBe("QC404");
      await owner("UPDATE enrollment SET status = 'left' WHERE id = $1", [enrollment]);
      expect(await refusal(reveal(player, secret, 2))).toBe("QC403:left");
      const ended = await newEvent();
      const late = await newCategory(ended);
      const latecomer = await member(ended);
      await owner(
        "UPDATE event SET status = 'ended', ends_at = now() - interval '1 minute' WHERE id = $1",
        [ended],
      );
      expect(await refusal(reveal(latecomer.player, late))).toBe("QN403:event_not_live");
      expect(await reveals(latecomer.enrollment)).toEqual([]);
    });

    it("refuses a player outside the category's audience", async () => {
      const event = await newEvent();
      const secret = await newCategory(event);
      await owner(
        "UPDATE category SET audience_kind = 'tag', audience_values = '{vip}' WHERE id = $1",
        [secret],
      );
      const { player, enrollment } = await member(event);
      expect(await refusal(reveal(player, secret))).toBe("QN403:not_for_you");
      expect(await reveals(enrollment)).toEqual([]);
    });

    it("refuses a player of another organizer's event", async () => {
      const event = await newEvent();
      const secret = await newCategory(event);
      const elsewhere = await newEvent("live", ids.orgB);
      const { player } = await member(elsewhere, "code", ids.orgB);
      expect(await refusal(reveal(player, secret))).toBe("QC404");
    });

    it("never locks a follower behind an unfound hidden unlock category", async () => {
      const event = await newEvent();
      const secret = await newCategory(event);
      await newQuest(event, secret);
      const follower = await newCategory(event, false, secret);
      const quest = await newQuest(event, follower);
      const { player, enrollment } = await member(event);
      expect(await refusal(code(player, quest))).toBe("none");
      expect(await score(enrollment)).toBe("10");
      const finder = await member(event);
      await reveal(finder.player, secret);
      expect(await refusal(code(finder.player, quest))).toBe("QN403:category_locked");
    });
  });

  describe("a manual award", () => {
    it("pays an unfound hidden quest and reveals its category; an operator scan is refused", async () => {
      const event = await newEvent();
      const secret = await newCategory(event);
      const quest = await newQuest(event, secret, {
        type: "scan_qr",
        config: {},
        verification: "{quest_qr,my_qr}",
      });
      const { player, enrollment } = await member(event);
      const operator = await member(event);
      await owner(
        "INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities) VALUES ($1, $2, $3, '{scan_quests}')",
        [ids.orgA, event, operator.player],
      );
      expect(
        await refusal(
          query(as(operator.player), "SELECT * FROM operator_complete_quest($1, $2, 1, $3)", [
            quest,
            player,
            randomUUID(),
          ]),
        ),
      ).toBe("QN403:not_for_you");
      await award(event, enrollment, quest);
      expect(await score(enrollment)).toBe("10");
      expect(await reveals(enrollment)).toEqual([{ category_id: secret }]);
      expect(await seen(player, event)).toContain(secret);
    });

    it("reveals nothing when refused or replayed", async () => {
      const event = await newEvent();
      const secret = await newCategory(event);
      const quest = await newQuest(event, secret);
      const { player, enrollment } = await member(event);
      const key = randomUUID();
      await award(event, enrollment, quest, key);
      await owner("DELETE FROM category_reveal WHERE enrollment_id = $1", [enrollment]);
      await award(event, enrollment, quest, key);
      expect(await reveals(enrollment)).toEqual([]);
      expect(await refusal(award(event, enrollment, quest))).toBe("QD409:1");
      expect(await reveals(enrollment)).toEqual([]);
      expect(await score(enrollment)).toBe("10");
      expect(await seen(player, event)).not.toContain(secret);
    });

    it("writes no reveal for a category that is not hidden", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, await newCategory(event, false));
      const { enrollment } = await member(event);
      await award(event, enrollment, quest);
      expect(await reveals(enrollment)).toEqual([]);
    });
  });

  describe("rehearsal and erasure", () => {
    it("counts and wipes a rehearsal's reveals", async () => {
      const event = await newEvent("draft");
      await owner(
        "INSERT INTO event_rehearsal (event_id, organizer_id, code) VALUES ($1, $2, 'ABCD-EFGH')",
        [event, ids.orgA],
      );
      const secret = await newCategory(event);
      const { player } = await member(event, "rehearsal");
      expect(await reveal(player, secret)).toMatchObject({ revealed: true });
      const [wiped] = await owner<{ counts: { reveals: number } }>(
        "SELECT wipe_rehearsal($1, 'go_live', NULL) AS counts",
        [event],
      );
      expect(wiped?.counts.reveals).toBe(1);
      expect(await owner("SELECT 1 FROM category_reveal WHERE event_id = $1", [event])).toEqual([]);
    });

    it("deletes an erased account's reveals, and a deleted category's", async () => {
      const event = await newEvent();
      const secret = await newCategory(event);
      const other = await newCategory(event);
      const gone = await member(event);
      const kept = await member(event);
      await reveal(gone.player, secret);
      await reveal(kept.player, other);
      await owner("SELECT erase_rows($1, ARRAY[$2]::uuid[], NULL)", [gone.player, gone.enrollment]);
      expect(await reveals(gone.enrollment)).toEqual([]);
      await owner("DELETE FROM category WHERE id = $1", [other]);
      expect(await reveals(kept.enrollment)).toEqual([]);
    });
  });

  describe("closed doors", () => {
    it("keeps the table and the helper away from the API role", async () => {
      for (const sql of [
        "SELECT * FROM category_reveal",
        "SELECT sees_category(gen_random_uuid(), NULL::category)",
        "INSERT INTO category_reveal (organizer_id, event_id, enrollment_id, category_id) VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid())",
      ]) {
        await expect(query(team(), sql), sql).rejects.toMatchObject({ code: "42501" });
      }
    });

    it("refuses a reveal with no player", async () => {
      expect(
        await refusal(query(team(), "SELECT * FROM reveal_category(gen_random_uuid(), 1)")),
      ).toBe("42501");
    });
  });
});
