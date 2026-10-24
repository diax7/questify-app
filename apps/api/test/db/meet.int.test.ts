import { randomBytes, randomUUID } from "node:crypto";
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
type Met = {
  completion_id: string;
  points: string;
  occurrence: number;
  score: string;
  balance: string;
  replayed: boolean;
  quest_id: string;
  other_completion: string;
  other_player: string;
  other_username: string;
  other_avatar: string;
};
type Member = { player: string; enrollment: string };
type Pass = { id: string; hash: Buffer };

const refusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
    return "none";
  } catch (error) {
    const pg = error as { code?: string; detail?: string; hint?: string };
    const hint = pg.hint === undefined ? "" : `:${pg.hint}`;
    return pg.detail === undefined || pg.detail === "" || !String(pg.code).startsWith("Q")
      ? `${pg.code}`
      : `${pg.code}:${pg.detail}${hint}`;
  }
};

const as = (player: string): RequestContext => ({ playerId: player });
const READING = { lat: 24.7136, lng: 46.6753, accuracyM: 10, ageS: 5 };

/**
 * Meet-someone quests in the database (T-303c, migration 0049, ADR-209 to ADR-211): both players paid or neither, the
 * pair rule, both caps, every refusal, the replay, the races, the flags, erasure, the wipe and the closed doors.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("meet quests (database)", () => {
  let db: TestDatabase;
  let pool: Pool;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let ownerA = "";
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new Pool({ connectionString: db.appUrl, max: 8 });
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

  const newEvent = async (options: Readonly<{ status?: string; tz?: string }> = {}) => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at, timezone)
       VALUES ($1, $2, 'Meet Fest', $3, now() - interval '1 hour', now() + interval '3 days', $4) RETURNING id`,
      [ids.orgA, `MEET${counter}`, options.status ?? "live", options.tz ?? "Asia/Riyadh"],
    );
    return event?.id ?? "";
  };
  const newCategory = async (event: string) =>
    (
      await owner<{ id: string }>(
        "INSERT INTO category (event_id, name_en) VALUES ($1, 'People') RETURNING id",
        [event],
      )
    )[0]?.id ?? "";
  const newQuest = async (
    event: string,
    options: Readonly<{
      repeatCap?: number;
      dailyCap?: number;
      category?: string;
      points?: number;
      type?: string;
    }> = {},
  ) => {
    const category = options.category ?? (await newCategory(event));
    const type = options.type ?? "meet";
    const [quest] = await owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, type_config)
       VALUES ($1, $2, $3, 'Meet', $4, $5, $6) RETURNING id`,
      [
        event,
        category,
        type,
        options.points ?? 50,
        options.repeatCap ?? 10,
        JSON.stringify(type === "meet" ? { dailyCap: options.dailyCap ?? 5 } : {}),
      ],
    );
    return quest?.id ?? "";
  };
  const member = async (event: string, via = "code"): Promise<Member> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`meet_player_${counter}`],
    );
    const [made] = await owner<{ id: string }>(
      "INSERT INTO enrollment (organizer_id, event_id, player_id, joined_via) VALUES ($1, $2, $3, $4) RETURNING id",
      [ids.orgA, event, player?.id, via],
    );
    return { player: player?.id ?? "", enrollment: made?.id ?? "" };
  };
  const enroll = async (event: string, player: string): Promise<Member> => {
    const [made] = await owner<{ id: string }>(
      "INSERT INTO enrollment (organizer_id, event_id, player_id, joined_via) VALUES ($1, $2, $3, 'code') RETURNING id",
      [ids.orgA, event, player],
    );
    return { player, enrollment: made?.id ?? "" };
  };
  /** A code written straight to the table, for a player who could not ask for one now. */
  const rawPass = async (who: Member, quest: string): Promise<Pass> => {
    const hash = randomBytes(32);
    const [row] = await owner<{ id: string }>(
      `INSERT INTO meet_pass (organizer_id, event_id, quest_id, enrollment_id, token_hash, expires_at)
       SELECT n.organizer_id, n.event_id, $2, n.id, $3, now() + interval '60 seconds' FROM enrollment n WHERE n.id = $1
       RETURNING id`,
      [who.enrollment, quest, hash],
    );
    return { id: row?.id ?? "", hash };
  };
  const issue = async (who: Member, quest: string, device: string | null = null): Promise<Pass> => {
    const hash = randomBytes(32);
    const [row] = await query<{ pass_id: string }>(
      as(who.player),
      "SELECT * FROM issue_meet_pass($1, $2, $3)",
      [quest, hash, device],
    );
    return { id: row?.pass_id ?? "", hash };
  };
  const meet = async (
    who: Member,
    pass: Pass,
    options: Readonly<{ key?: string; device?: string | null; reading?: unknown }> = {},
  ) =>
    (
      await query<Met>(as(who.player), "SELECT * FROM meet_player($1, $2, $3, $4)", [
        pass.hash,
        options.key ?? randomUUID(),
        options.device ?? null,
        options.reading === undefined ? null : JSON.stringify(options.reading),
      ])
    )[0] as Met;
  /** B shows a code, A scans it. */
  const meets = async (a: Member, b: Member, quest: string, key?: string) =>
    meet(a, await issue(b, quest), key === undefined ? {} : { key });
  const completions = (enrollment: string) =>
    owner<{ method: string; idempotency_key: string; device_id: string | null }>(
      "SELECT method, idempotency_key, device_id FROM quest_completion WHERE enrollment_id = $1 ORDER BY id",
      [enrollment],
    );
  const score = async (enrollment: string) =>
    (await owner<{ score: string }>("SELECT score FROM enrollment WHERE id = $1", [enrollment]))[0]
      ?.score;
  const meetings = (quest: string) =>
    owner("SELECT scanner_enrollment, shown_enrollment FROM meeting WHERE quest_id = $1", [quest]);
  const kinds = async (who: Member) =>
    (
      await owner<{ kind: string }>("SELECT kind FROM flag WHERE enrollment_id = $1", [
        who.enrollment,
      ])
    ).map((row) => row.kind);
  const state = async (who: Member, pass: Pass) =>
    query(as(who.player), "SELECT * FROM meet_pass_state($1)", [pass.id]);

  const setup = async (options: Parameters<typeof newQuest>[1] = {}) => {
    const event = await newEvent();
    const quest = await newQuest(event, options);
    return { event, quest, a: await member(event), b: await member(event) };
  };

  describe("meeting (FR-212, FR-213)", () => {
    it("pays both players once with the quest's points, and answers the scanner with the other's name only", async () => {
      const { quest, a, b } = await setup();
      const met = await meet(a, await issue(b, quest, "00000000-0000-4000-8000-00000000000b"), {
        device: "00000000-0000-4000-8000-00000000000a",
      });
      expect(met).toMatchObject({ points: "50", occurrence: 1, score: "50", replayed: false });
      expect(met.quest_id).toBe(quest);
      expect(met.other_player).toBe(b.player);
      expect(met.other_username).toMatch(/^meet_player_/);
      expect(met.other_avatar).toBe("falcon");
      expect(await score(a.enrollment)).toBe("50");
      expect(await score(b.enrollment)).toBe("50");
      const [mine] = await completions(a.enrollment);
      const [theirs] = await completions(b.enrollment);
      expect(mine).toMatchObject({
        method: "meet_scan",
        device_id: "00000000-0000-4000-8000-00000000000a",
      });
      expect(theirs).toMatchObject({
        method: "meet_shown",
        device_id: "00000000-0000-4000-8000-00000000000b",
      });
      expect(mine?.idempotency_key).toBe(theirs?.idempotency_key);
      expect(mine?.idempotency_key).toMatch(/^meet:\d+$/);
      expect(await meetings(quest)).toEqual([
        { scanner_enrollment: a.enrollment, shown_enrollment: b.enrollment },
      ]);
    });

    it("pays both sides the quest's item and the category bonus", async () => {
      const event = await newEvent();
      const [item] = await owner<{ id: string }>(
        "INSERT INTO quest_item (event_id, name_en, stock_total) VALUES ($1, 'Pin', 10) RETURNING id",
        [event],
      );
      const [group] = await owner<{ id: string }>(
        "INSERT INTO category (event_id, name_en, completion_bonus) VALUES ($1, 'People', 7) RETURNING id",
        [event],
      );
      const quest = await newQuest(event, { category: group?.id ?? "", repeatCap: 1, dailyCap: 1 });
      await owner("UPDATE quest SET item_id = $2 WHERE id = $1", [quest, item?.id]);
      const [a, b] = [await member(event), await member(event)];
      await meets(a, b, quest);
      for (const side of [a, b]) {
        expect(await score(side.enrollment)).toBe("57");
        expect(
          await owner("SELECT 1 FROM redemption WHERE enrollment_id = $1 AND quest_item_id = $2", [
            side.enrollment,
            item?.id,
          ]),
        ).toHaveLength(1);
      }
    });

    it("refuses the same pair again in either direction, on any day, and pays nothing", async () => {
      const { quest, a, b } = await setup();
      await meets(a, b, quest);
      expect(await refusal(meets(b, a, quest))).toMatch(/^QM409:already_met:meet_player_/);
      expect(await refusal(meets(a, b, quest))).toMatch(/^QM409:already_met:/);
      await owner("UPDATE quest_completion SET created_at = created_at - interval '2 days'");
      expect(await refusal(meets(b, a, quest))).toMatch(/^QM409:already_met:/);
      expect(await score(a.enrollment)).toBe("50");
      expect(await score(b.enrollment)).toBe("50");
    });

    it("treats two meet quests of one event as two separate pairs", async () => {
      const { event, quest, a, b } = await setup();
      const other = await newQuest(event);
      await meets(a, b, quest);
      await meets(b, a, other);
      expect(await score(a.enrollment)).toBe("100");
    });

    it("stops the scanner at the daily cap and refuses a capped shown player; the next event day pays again", async () => {
      const { event, quest, a } = await setup({ dailyCap: 2 });
      const [b, c, d] = [await member(event), await member(event), await member(event)];
      await meets(a, b, quest);
      await meets(c, a, quest);
      expect(await refusal(meets(a, d, quest))).toBe("QM409:daily_cap:2");
      // The issuer refuses a capped player first; a code they showed before the cap still meets the payer's check.
      expect(await refusal(meet(d, await rawPass(a, quest)))).toBe("QM409:their_daily_cap");
      expect(await score(d.enrollment)).toBe("0");
      const [day] = await owner<{ start: Date }>(
        "SELECT event_day_start(e, event_day(now(), e)) AS start FROM event e WHERE e.id = $1",
        [event],
      );
      // One second before today's event day began: yesterday's, not counted.
      await owner(
        "UPDATE quest_completion SET created_at = $2::timestamptz - interval '1 second' WHERE enrollment_id = $1",
        [a.enrollment, day?.start],
      );
      expect(await meets(a, d, quest)).toMatchObject({ points: "50" });
      await owner(
        "UPDATE quest_completion SET created_at = $2::timestamptz WHERE enrollment_id = $1 AND method = 'meet_shown'",
        [a.enrollment, day?.start],
      );
      expect(await refusal(meets(a, await member(event), quest))).toBe("QM409:daily_cap:2");
    });

    it("counts the day in the event's time zone", async () => {
      const event = await newEvent({ tz: "Pacific/Kiritimati" });
      await owner("UPDATE event SET day_start_hour = 4 WHERE id = $1", [event]);
      const quest = await newQuest(event, { dailyCap: 1 });
      const [a, b, c] = [await member(event), await member(event), await member(event)];
      await meets(a, b, quest);
      const [day] = await owner<{ start: Date }>(
        "SELECT event_day_start(e, event_day(now(), e)) AS start FROM event e WHERE e.id = $1",
        [event],
      );
      await owner(
        "UPDATE quest_completion SET created_at = $2::timestamptz + interval '1 second' WHERE enrollment_id = $1",
        [a.enrollment, day?.start],
      );
      expect(await refusal(meets(a, c, quest))).toBe("QM409:daily_cap:1");
      await owner(
        "UPDATE quest_completion SET created_at = $2::timestamptz - interval '1 second' WHERE enrollment_id = $1",
        [a.enrollment, day?.start],
      );
      expect(await meets(a, c, quest)).toMatchObject({ points: "50" });
    });

    it("stops either side at the quest's repeat cap", async () => {
      const { event, quest, a, b } = await setup({ repeatCap: 1, dailyCap: 1 });
      const [c, d] = [await member(event), await member(event)];
      await meets(a, b, quest);
      expect(await refusal(meets(a, c, quest))).toBe("QM409:done");
      expect(await refusal(meet(d, await rawPass(a, quest)))).toBe("QM409:their_done");
      expect(await refusal(issue(a, quest))).toBe("QD409:1");
    });

    it("keeps the daily cap for the scanner after the shown player's account is erased (CTO 6)", async () => {
      const { event, quest, a, b } = await setup({ dailyCap: 1 });
      await meets(a, b, quest);
      await owner("SELECT erase_rows($1, ARRAY[$2]::uuid[], NULL)", [b.player, b.enrollment]);
      expect(await meetings(quest)).toEqual([]);
      expect(await refusal(meets(a, await member(event), quest))).toBe("QM409:daily_cap:1");
    });
  });

  describe("refusals", () => {
    it("refuses the player's own code, the same device, an expired, a used and an unknown code", async () => {
      const { event, quest, a, b } = await setup();
      const own = await issue(a, quest);
      expect(await refusal(meet(a, own))).toBe("QM422:self");
      const phone = randomUUID();
      expect(await refusal(meet(a, await issue(b, quest, phone), { device: phone }))).toBe(
        "QM422:same_device",
      );
      const old = await issue(b, quest);
      await owner("UPDATE meet_pass SET expires_at = now() - interval '1 second' WHERE id = $1", [
        old.id,
      ]);
      expect(await refusal(meet(a, old))).toBe("QM422:expired");
      const used = await issue(b, quest);
      await meet(a, used);
      expect(await refusal(meet(await member(event), used))).toBe("QM422:used");
      expect(await refusal(meet(a, { id: "0", hash: randomBytes(32) }))).toBe("QM422:bad_code");
      expect(await score(a.enrollment)).toBe("50");
    });

    it("refuses a scanner not in the code's event without naming anyone", async () => {
      const { quest, b } = await setup();
      const stranger = await member(await newEvent());
      expect(await refusal(meet(stranger, await issue(b, quest)))).toBe("QM403:not_in_event");
    });

    it("answers not_for_them for every reason the shown player cannot play, and pays nobody", async () => {
      const { event, quest, a } = await setup();
      const banned = await member(event);
      const pass = await issue(banned, quest);
      await owner("UPDATE enrollment SET status = 'banned' WHERE id = $1", [banned.enrollment]);
      expect(await refusal(meet(a, pass))).toBe("QM403:not_for_them");

      const left = await member(event);
      const leftPass = await issue(left, quest);
      await owner("UPDATE enrollment SET status = 'left' WHERE id = $1", [left.enrollment]);
      expect(await refusal(meet(a, leftPass))).toBe("QM403:not_for_them");

      const suspended = await member(event);
      const suspendedPass = await issue(suspended, quest);
      await owner("UPDATE player SET status = 'banned' WHERE id = $1", [suspended.player]);
      expect(await refusal(meet(a, suspendedPass))).toBe("QM403:not_for_them");

      const operator = await member(event);
      const operatorPass = await issue(operator, quest);
      await owner(
        "INSERT INTO staff_assignment (organizer_id, event_id, player_id, can_play) VALUES ($1, $2, $3, false)",
        [ids.orgA, event, operator.player],
      );
      expect(await refusal(meet(a, operatorPass))).toBe("QM403:not_for_them");
      expect(await score(a.enrollment)).toBe("0");
    });

    it("answers not_for_them for a shown player outside the audience or behind a category lock", async () => {
      const event = await newEvent();
      const [field] = await owner<{ id: string }>(
        "INSERT INTO event_join_field (organizer_id, event_id, kind, position) VALUES ($1, $2, 'company', 0) RETURNING id",
        [ids.orgA, event],
      );
      const group = await newCategory(event);
      await owner(
        "UPDATE category SET audience_kind = 'answer', audience_field_id = $2, audience_values = '{Nafes}' WHERE id = $1",
        [group, field?.id],
      );
      const quest = await newQuest(event, { category: group });
      const [a, b] = [await member(event), await member(event)];
      for (const who of [a, b]) {
        await owner(
          "INSERT INTO join_answer (enrollment_id, field_id, organizer_id, event_id, value) VALUES ($1, $2, $3, $4, 'Nafes')",
          [who.enrollment, field?.id, ids.orgA, event],
        );
      }
      const pass = await issue(b, quest);
      await owner("DELETE FROM join_answer WHERE enrollment_id = $1", [b.enrollment]);
      expect(await refusal(meet(a, pass))).toBe("QM403:not_for_them");

      const first = await newCategory(event);
      const gate = await newQuest(event, { category: first, type: "scan_qr" });
      const [after] = await owner<{ id: string }>(
        "INSERT INTO category (event_id, name_en, unlock_after) VALUES ($1, 'After', $2) RETURNING id",
        [event, first],
      );
      const later = await newQuest(event, { category: after?.id ?? "" });
      const [c, d] = [await member(event), await member(event)];
      await query(as(c.player), "SELECT * FROM complete_quest($1, 'qr', 1, NULL, $2, NULL)", [
        gate,
        randomUUID(),
      ]);
      expect(await refusal(meet(c, await rawPass(d, later)))).toBe("QM403:not_for_them");
      expect(await score(c.enrollment)).toBe("50");
    });

    it("refuses the scanner with their own codes, and the issuer the same way (CTO 4)", async () => {
      const { event, quest, a, b } = await setup();
      await owner(
        "INSERT INTO staff_assignment (organizer_id, event_id, player_id, can_play) VALUES ($1, $2, $3, false)",
        [ids.orgA, event, a.player],
      );
      expect(await refusal(meet(a, await issue(b, quest)))).toBe("QP403");
      expect(await refusal(issue(a, quest))).toBe("QP403");
      await owner("UPDATE staff_assignment SET can_play = true WHERE player_id = $1", [a.player]);
      expect(await meet(a, await issue(b, quest))).toMatchObject({ points: "50" });

      const c = await member(event);
      await owner("UPDATE enrollment SET status = 'banned' WHERE id = $1", [c.enrollment]);
      expect(await refusal(issue(c, quest))).toBe("QC403:banned");
      expect(await refusal(meet(c, await issue(await member(event), quest)))).toBe("QC403:banned");
      const d = await member(event);
      await owner("UPDATE player SET status = 'banned' WHERE id = $1", [d.player]);
      expect(await refusal(issue(d, quest))).toBe("QC404");
    });

    it("refuses issuing for a capped player, a closed or unknown quest, or another type", async () => {
      const { event, quest, a, b } = await setup({ dailyCap: 1 });
      await meets(a, b, quest);
      expect(await refusal(issue(a, quest))).toBe("QM409:daily_cap:1");
      expect(await refusal(issue(b, quest))).toBe("QM409:daily_cap:1");
      expect(await refusal(issue(a, randomUUID()))).toBe("QC404");
      const scan = await newQuest(event, { type: "scan_qr" });
      expect(await refusal(issue(a, scan))).toBe("QT422:meet");
      const ended = await newQuest(event);
      await owner("UPDATE quest SET closes_at = now() - interval '1 minute' WHERE id = $1", [
        ended,
      ]);
      expect(await refusal(issue(await member(event), ended))).toBe("QN403:ended");
      expect(await refusal(issue(await member(await newEvent()), quest))).toBe("QC404");
    });

    it("refuses issuing and meeting while the event's switch is off", async () => {
      const { event, quest, a, b } = await setup();
      const pass = await issue(b, quest);
      await owner(
        `UPDATE event SET config = jsonb_set(config, '{features}', '{"meetSomeone": false}') WHERE id = $1`,
        [event],
      );
      expect(await refusal(issue(b, quest))).toBe("QF403");
      expect(await refusal(meet(a, pass))).toBe("QF403");
    });
  });

  describe("codes and replays", () => {
    it("ends the earlier open code when a new one is shown, and shows the owner only their own code's state", async () => {
      const { event, quest, a, b } = await setup();
      const first = await issue(b, quest);
      expect(await state(b, first)).toEqual([
        { state: "open", username: null, avatar: null, points: null },
      ]);
      const second = await issue(b, quest);
      expect(await state(b, first)).toMatchObject([{ state: "expired" }]);
      expect(await refusal(meet(a, first))).toBe("QM422:expired");
      expect(await state(a, second)).toEqual([]);
      await meet(a, second);
      expect(await state(b, second)).toEqual([
        {
          state: "used",
          username: expect.stringMatching(/^meet_player_/),
          avatar: "falcon",
          points: "50",
        },
      ]);
      expect(await state(await member(event), second)).toEqual([]);
      expect(
        await owner(
          "SELECT count(*)::int AS open FROM meet_pass WHERE enrollment_id = $1 AND ended_at IS NULL",
          [b.enrollment],
        ),
      ).toEqual([{ open: 0 }]);
    });

    it("deletes a player's codes older than a day that no meeting names, at their next issue", async () => {
      const { quest, a, b } = await setup();
      const used = await issue(b, quest);
      await meet(a, used);
      const stale = await issue(b, quest);
      await owner(
        "UPDATE meet_pass SET created_at = now() - interval '2 days' WHERE enrollment_id = $1",
        [b.enrollment],
      );
      await issue(b, quest);
      const left = await owner<{ id: string }>(
        "SELECT id FROM meet_pass WHERE enrollment_id = $1",
        [b.enrollment],
      );
      expect(left.map((row) => row.id)).toContain(used.id);
      expect(left.map((row) => row.id)).not.toContain(stale.id);
    });

    it("answers a replay with the first meeting and pays nothing; the same key on another code is QK422", async () => {
      const { event, quest, a, b } = await setup();
      const pass = await issue(b, quest);
      const key = randomUUID();
      const first = await meet(a, pass, { key });
      const again = await meet(a, pass, { key });
      expect(again).toMatchObject({
        completion_id: first.completion_id,
        replayed: true,
        points: "50",
        other_username: first.other_username,
      });
      expect(await score(a.enrollment)).toBe("50");
      expect(await refusal(meet(a, await issue(await member(event), quest), { key }))).toBe(
        "QK422",
      );
      expect(await refusal(meet(a, pass, { key: "" }))).toBe("QK422");
    });

    it("refuses a player's own key under the reserved meet prefix", async () => {
      const { event } = await setup();
      const scan = await newQuest(event, { type: "scan_qr" });
      const c = await member(event);
      expect(
        await refusal(
          query(as(c.player), "SELECT * FROM complete_quest($1, 'qr', 1, NULL, 'meet:1', NULL)", [
            scan,
          ]),
        ),
      ).toBe("QK422");
    });
  });

  describe("other ways in", () => {
    it("pays one side by a manual award, counting towards the repeat cap only", async () => {
      const { event, quest, a, b } = await setup({ repeatCap: 1, dailyCap: 1 });
      await query(team(), "SELECT * FROM staff_award($1, $2, $3, NULL, 'Helped', $4, $5)", [
        event,
        a.enrollment,
        quest,
        randomUUID(),
        randomUUID(),
      ]);
      expect(await score(a.enrollment)).toBe("50");
      expect(await score(b.enrollment)).toBe("0");
      expect(await refusal(meets(a, b, quest))).toBe("QM409:done");
    });

    it("refuses a meet quest by complete_quest and by the operator's My QR scan", async () => {
      const { event, quest, a } = await setup();
      expect(
        await refusal(
          query(as(a.player), "SELECT * FROM complete_quest($1, 'qr', 1, NULL, $2, NULL)", [
            quest,
            randomUUID(),
          ]),
        ),
      ).toBe("QV422:wrong_method");
      const operator = await member(event);
      await owner(
        "INSERT INTO staff_assignment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)",
        [ids.orgA, event, operator.player],
      );
      expect(
        await refusal(
          query(as(operator.player), "SELECT * FROM operator_complete_quest($1, $2, 1, $3)", [
            quest,
            a.player,
            randomUUID(),
          ]),
        ),
      ).toBe("QV422:wrong_method");
      expect(await score(a.enrollment)).toBe("0");
    });

    it("keeps the pair used after one side's payment is removed", async () => {
      const { event, quest, a, b } = await setup();
      const met = await meets(a, b, quest);
      const [entry] = await owner<{ id: string }>(
        "SELECT id FROM ledger_entry WHERE completion_id = $1 AND kind = 'quest'",
        [met.completion_id],
      );
      await query(team(), "SELECT * FROM remove_award($1, $2, 'Cheating', $3, $4)", [
        event,
        entry?.id,
        randomUUID(),
        randomUUID(),
      ]);
      expect(await score(a.enrollment)).toBe("0");
      expect(await score(b.enrollment)).toBe("50");
      expect(await refusal(meets(b, a, quest))).toMatch(/^QM409:already_met/);
    });

    it("pays with no device, and needs every caller to say when the points were fixed (T-307, CTO 2)", async () => {
      const { event, b } = await setup();
      const scan = await newQuest(event, { type: "scan_qr", points: 5 });
      await expect(
        owner(
          "SELECT pay_completion(n, $2, 5, 'qr', 'seven', NULL, NULL) FROM enrollment n WHERE n.id = $1",
          [b.enrollment, scan],
        ),
      ).rejects.toThrow(/does not exist/);
      await expect(
        owner(
          "SELECT pay_completion(n, $2, 5, 'qr', 'seven', NULL, NULL, NULL, NULL) FROM enrollment n WHERE n.id = $1",
          [b.enrollment, scan],
        ),
      ).rejects.toMatchObject({ code: "22004" });
      await owner(
        "SELECT pay_completion(n, $2, 5, 'qr', 'seven', NULL, NULL, NULL, now()) FROM enrollment n WHERE n.id = $1",
        [b.enrollment, scan],
      );
      expect(await completions(b.enrollment)).toEqual([
        { method: "qr", idempotency_key: "seven", device_id: null },
      ]);
      expect(await score(b.enrollment)).toBe("5");
    });
  });

  describe("flags (ADR-211)", () => {
    it("counts the scanner's side in the burst and both sides in the shared device", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, { dailyCap: 50, repeatCap: 50 });
      const scanner = await member(event);
      const shown = await member(event);
      for (let round = 0; round < 10; round += 1) {
        await meet(scanner, await issue(await member(event), quest));
        await meet(await member(event), await issue(shown, quest));
      }
      expect(await kinds(scanner)).toEqual(["burst"]);
      expect(await kinds(shown)).toEqual([]);
      const phone = randomUUID();
      const [c, d, e] = [await member(event), await member(event), await member(event)];
      await meet(c, await issue(d, quest, phone));
      await meet(c, await issue(e, quest, phone));
      expect(await kinds(d)).toEqual(["shared_device"]);
      expect(await kinds(e)).toEqual(["shared_device"]);
    });

    it("keeps the scanner's reading and raises far-from-venue; the shown side keeps none", async () => {
      const event = await newEvent();
      await owner("UPDATE event SET venue_lat = 21.0, venue_lng = 39.0 WHERE id = $1", [event]);
      const quest = await newQuest(event);
      const [a, b] = [await member(event), await member(event)];
      const met = await meet(a, await issue(b, quest), { reading: READING });
      expect(
        await owner(
          "SELECT completion_id::text AS id FROM completion_position WHERE enrollment_id IN ($1, $2)",
          [a.enrollment, b.enrollment],
        ),
      ).toEqual([{ id: met.completion_id }]);
      expect(await owner("SELECT kind FROM flag WHERE enrollment_id = $1", [a.enrollment])).toEqual(
        [{ kind: "far_from_venue" }],
      );
      const [c, d] = [await member(event), await member(event)];
      await meet(c, await issue(d, quest), { reading: "junk" });
      expect(
        await owner("SELECT 1 FROM completion_position WHERE enrollment_id = $1", [c.enrollment]),
      ).toEqual([]);
    });
  });

  describe("races (ADR-211)", () => {
    it("pays one meeting when two players scan each other at once", async () => {
      for (let round = 0; round < 50; round += 1) {
        const { quest, a, b } = await setup();
        const [codeA, codeB] = [await issue(a, quest), await issue(b, quest)];
        const results = await Promise.allSettled([meet(a, codeB), meet(b, codeA)]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        for (const result of results) {
          if (result.status === "rejected") {
            expect((result.reason as { detail?: string }).detail).toBe("already_met");
          }
        }
        expect(await meetings(quest)).toHaveLength(1);
        expect([await score(a.enrollment), await score(b.enrollment)]).toEqual(["50", "50"]);
      }
    });

    it("pays one of two meetings on a daily cap of 1, and one of two scanners of one code", async () => {
      for (let round = 0; round < 50; round += 1) {
        const { event, quest, a, b } = await setup({ dailyCap: 1 });
        const c = await member(event);
        const results = await Promise.allSettled([
          meet(a, await issue(b, quest)),
          meet(a, await issue(c, quest)),
        ]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(await score(a.enrollment)).toBe("50");
        const shared = await issue(await member(event), quest);
        const [d, e] = [await member(event), await member(event)];
        const scans = await Promise.allSettled([meet(d, shared), meet(e, shared)]);
        expect(scans.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        const lost = scans.find((result) => result.status === "rejected");
        expect((lost as PromiseRejectedResult).reason.detail).toBe("used");
      }
    });

    it("answers the same request sent twice at once with one meeting and a replay, never used (CTO 2)", async () => {
      for (let round = 0; round < 50; round += 1) {
        const { quest, a, b } = await setup();
        const pass = await issue(b, quest);
        const key = randomUUID();
        const [one, two] = await Promise.all([meet(a, pass, { key }), meet(a, pass, { key })]);
        expect([one.replayed, two.replayed].toSorted()).toEqual([false, true]);
        expect(one.completion_id).toBe(two.completion_id);
        expect(await score(a.enrollment)).toBe("50");
      }
    });

    it("never deadlocks: A–B with B–C, two phones crosswise, a meeting beside a QR scan, and two events", async () => {
      for (let round = 0; round < 50; round += 1) {
        const event = await newEvent();
        const quest = await newQuest(event, { dailyCap: 10 });
        const scan = await newQuest(event, { type: "scan_qr", repeatCap: 5 });
        const [a, b, c, d] = [
          await member(event),
          await member(event),
          await member(event),
          await member(event),
        ];
        const [x, y] = [randomUUID(), randomUUID()];
        const work = [
          meet(a, await issue(b, quest)),
          meet(b, await issue(c, quest)),
          meet(a, await issue(d, quest, y), { device: x }),
          meet(c, await issue(await member(event), quest, x), { device: y }),
          query(as(d.player), "SELECT * FROM complete_quest($1, 'qr', 1, NULL, $2, $3)", [
            scan,
            randomUUID(),
            y,
          ]),
        ];
        const other = await newEvent();
        const otherQuest = await newQuest(other);
        const [a2, b2] = [await enroll(other, a.player), await enroll(other, b.player)];
        work.push(meet(b2, await issue(a2, otherQuest)));
        const results = await Promise.allSettled(work);
        for (const result of results) {
          if (result.status === "rejected") {
            expect(String((result.reason as { code?: string }).code)).not.toBe("40P01");
          }
        }
        expect(results.every((result) => result.status === "fulfilled")).toBe(true);
      }
    });
  });

  describe("erasure, the rehearsal wipe and the closed doors", () => {
    it("deletes the erased player's codes and every meeting they were in; the other keeps their points", async () => {
      const { event, quest, a, b } = await setup();
      await meets(a, b, quest);
      await issue(b, quest);
      await meets(b, await member(event), quest);
      await owner("SELECT erase_rows($1, ARRAY[$2]::uuid[], NULL)", [b.player, b.enrollment]);
      expect(
        await owner("SELECT 1 FROM meet_pass WHERE enrollment_id = $1", [b.enrollment]),
      ).toEqual([]);
      expect(
        await owner(
          "SELECT 1 FROM meeting WHERE scanner_enrollment = $1 OR shown_enrollment = $1",
          [b.enrollment],
        ),
      ).toEqual([]);
      expect(await score(a.enrollment)).toBe("50");
    });

    it("wipes a rehearsal account's codes and meetings with its completions", async () => {
      const event = await newEvent({ status: "draft" });
      await owner(
        "INSERT INTO event_rehearsal (event_id, organizer_id, code) VALUES ($1, $2, 'MEET-REHR')",
        [event, ids.orgA],
      );
      const quest = await newQuest(event);
      const [a, b] = [await member(event, "rehearsal"), await member(event, "rehearsal")];
      await meets(a, b, quest);
      await issue(a, quest);
      await owner("SELECT wipe_rehearsal($1, 'go_live', $2)", [event, randomUUID()]);
      expect(await owner("SELECT 1 FROM meet_pass WHERE event_id = $1", [event])).toEqual([]);
      expect(await meetings(quest)).toEqual([]);
    });

    it("refuses a meet quest's daily cap out of range", async () => {
      const event = await newEvent();
      for (const config of [
        "{}",
        '{"dailyCap": 0}',
        '{"dailyCap": 51}',
        '{"dailyCap": "5"}',
        '{"dailyCap": 2.5}',
      ]) {
        expect(
          await refusal(
            owner(
              `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
               VALUES ($1, $2, 'meet', 'Meet', 5, $3)`,
              [event, await newCategory(event), config],
            ),
          ),
          config,
        ).toBe("23514");
      }
    });

    it("lets the API role run only the three doors", async () => {
      const runnable = await owner<{ proname: string }>(
        `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND (p.proname LIKE 'meet%' OR p.proname IN ('issue_meet_pass', 'pay_meeting', 'pay_completion'))
           AND has_function_privilege('questify_app', p.oid, 'EXECUTE')
         ORDER BY 1`,
      );
      expect(runnable.map((row) => row.proname)).toEqual([
        "issue_meet_pass",
        "meet_pass_state",
        "meet_player",
      ]);
    });

    it("refuses a scanner from another organizer's event as not_in_event", async () => {
      const { quest, b } = await setup();
      const [elsewhere] = await owner<{ id: string }>(
        `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
         VALUES ($1, 'MEETB', 'B Fest', 'live', now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
        [ids.orgB],
      );
      const [player] = await owner<{ id: string }>(
        "INSERT INTO player (username) VALUES ('meet_tenant_b') RETURNING id",
      );
      await owner(
        "INSERT INTO enrollment (organizer_id, event_id, player_id, joined_via) VALUES ($1, $2, $3, 'code')",
        [ids.orgB, elsewhere?.id, player?.id],
      );
      const stranger = { player: player?.id ?? "", enrollment: "" };
      expect(await refusal(meet(stranger, await issue(b, quest)))).toBe("QM403:not_in_event");
    });

    it("keeps the tables and the helpers away from the API role", async () => {
      for (const sql of [
        "SELECT * FROM meet_pass",
        "SELECT * FROM meeting",
        "SELECT meet_on(gen_random_uuid())",
        "SELECT meet_today(gen_random_uuid(), NULL::quest)",
        "SELECT meet_caps(NULL::enrollment, NULL::quest)",
        "SELECT meet_may_play(NULL::enrollment, NULL::quest)",
        "SELECT meet_pass_for('\\x00')",
        "SELECT meet_replay(gen_random_uuid(), 'k', 1)",
        "SELECT * FROM meet_answer(NULL::meeting, false)",
        "SELECT meet_refusal(NULL::meet_pass, NULL::enrollment, NULL::enrollment, NULL::quest)",
        "SELECT pay_meeting(NULL::meet_pass, NULL::enrollment, NULL::enrollment, NULL::quest, 'k', NULL, NULL)",
        "SELECT pay_completion(NULL::enrollment, gen_random_uuid(), 1, 'qr', 'k', NULL, NULL, NULL, now())",
      ]) {
        await expect(db.app.query(sql), sql).rejects.toThrow(/permission denied/);
      }
    });
  });
});
