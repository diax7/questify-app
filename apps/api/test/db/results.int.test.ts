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

const refusal = async (work: Promise<unknown>): Promise<{ code: string; detail?: string }> => {
  try {
    await work;
  } catch (error) {
    const { code, detail } = error as { code: string; detail?: string };
    return detail === undefined ? { code } : { code, detail };
  }
  throw new Error("expected a refusal");
};

const HOUR = 3600 * 1000;

/**
 * Rank prizes and final results in the database (T-214, migration 0034): who wins, the owner's confirmation and its
 * freeze, the reveal and its deadline, the prize at the desk with no price, every reader of a redemption with a rank
 * prize in it, the official rules' data, and the races between confirming and removing.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("rank prizes and results (database)", () => {
  let db: TestDatabase;
  let pool: Pool;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let ownerA = "";
  let editorA = "";
  let ownerB = "";
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new Pool({ connectionString: db.appUrl, max: 8 });
    ids = await seedTwoTenants(db.owner);
    ownerA = await addMember(db.owner, ids.orgA, "owner");
    editorA = await addMember(db.owner, ids.orgA, "editor");
    ownerB = await addMember(db.owner, ids.orgB, "owner");
  });
  afterAll(async () => {
    await pool.end();
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  type Phase = "ended" | "live" | "draft" | "archived";
  /** An event in the given phase with a desk; `ended` ended an hour ago. */
  const newEvent = async (phase: Phase = "ended", organizer = ids.orgA): Promise<string> => {
    counter += 1;
    const ends =
      phase === "ended" || phase === "archived"
        ? "now() - interval '1 hour'"
        : "now() + interval '1 day'";
    const status = phase === "ended" ? "live" : phase;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at, desk_location_en)
       VALUES ($1, $2, 'Prize Fest', $3, now() - interval '2 days', ${ends}, 'Hall B') RETURNING id`,
      [organizer, `RANK${counter}`, status],
    );
    await owner("INSERT INTO category (event_id, name_en) VALUES ($1, 'General')", [event?.id]);
    return event?.id ?? "";
  };

  const organizerOf = async (event: string) =>
    (
      await owner<{ organizer_id: string }>("SELECT organizer_id FROM event WHERE id = $1", [event])
    )[0]?.organizer_id ?? "";

  const newQuest = async (event: string, points: number): Promise<string> =>
    (
      await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, visible, type_config)
         SELECT $1, id, 'scan_qr', 'Lion', $2, 100, true, '{}' FROM category WHERE event_id = $1 LIMIT 1
         RETURNING id`,
        [event, points],
      )
    )[0]?.id ?? "";

  /** Gives `points` through a quest entry; returns the entry's id (removable by remove_award). */
  const earn = async (event: string, enrollment: string, points: number): Promise<string> => {
    const organizer = await organizerOf(event);
    const quest = await newQuest(event, points);
    const [done] = await owner<{ id: string }>(
      `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                     idempotency_key, created_at)
       VALUES ($1, $2, $3, $4, 1, 'qr', $5, now() - interval '2 hours') RETURNING id`,
      [organizer, event, enrollment, quest, randomUUID()],
    );
    const [entry] = await owner<{ id: string }>(
      `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                 completion_id, quest_id, actor)
       VALUES ($1, $2, $3, 'quest', $4, $4, $5, $6, 'player') RETURNING id`,
      [organizer, event, enrollment, points, done?.id, quest],
    );
    return entry?.id ?? "";
  };

  const newPlayer = async (event: string, points = 0) => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`rank_player_${counter}`],
    );
    await owner("INSERT INTO player_contact (player_id, email) VALUES ($1, $2)", [
      player?.id,
      `p${counter}@mail${counter}.test`,
    ]);
    const [enrolled] = await owner<{ id: string }>(
      "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3) RETURNING id",
      [await organizerOf(event), event, player?.id],
    );
    const enrollment = enrolled?.id ?? "";
    const entry = points > 0 ? await earn(event, enrollment, points) : "";
    return { player: player?.id ?? "", enrollment, entry };
  };

  const newOperator = async (event: string): Promise<string> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`rank_op_${counter}`],
    );
    await owner(
      "INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities) VALUES ($1, $2, $3, $4)",
      [await organizerOf(event), event, player?.id, ["hand_over"]],
    );
    return player?.id ?? "";
  };

  const prize = async (event: string, from: number, to: number, name = "Trophy", kind = "item") =>
    (
      await owner<{ id: string }>(
        `INSERT INTO rank_prize (event_id, rank_from, rank_to, kind, name_en, name_ar)
         VALUES ($1, $2, $3, $4, $5, 'كأس') RETURNING id`,
        [event, from, to, kind, name],
      )
    )[0]?.id ?? "";

  const run = async <T extends Row>(
    context: RequestContext,
    sql: string,
    values: unknown[] = [],
  ) => {
    const client = await pool.connect();
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
  const team = (staff: string, organizer = ids.orgA): RequestContext => ({
    organizerId: organizer,
    staffUserId: staff,
  });
  const call = <T extends Row>(player: string, sql: string, values: unknown[] = []) =>
    run<T>({ playerId: player }, sql, values);

  const places = (event: string, staff = ownerA) =>
    run<{
      rank: number;
      enrollment_id: string;
      score: string;
      open_flags: number;
      flag_kinds: string[];
    }>(team(staff), "SELECT * FROM results_places($1)", [event]);
  const expectedOf = async (event: string) => (await places(event)).map((p) => p.enrollment_id);
  const confirm = async (
    event: string,
    expected?: string[],
    staff = ownerA,
    organizer = ids.orgA,
  ) =>
    (
      await run<{ outcome: string }>(
        team(staff, organizer),
        "SELECT confirm_results($1, $2, $3) AS outcome",
        [event, expected ?? (await expectedOf(event)), randomUUID()],
      )
    )[0]?.outcome;
  const reveal = async (event: string, claim = new Date(Date.now() + 24 * HOUR), staff = ownerA) =>
    (
      await run<{ outcome: string }>(team(staff), "SELECT reveal_results($1, $2, $3) AS outcome", [
        event,
        claim,
        randomUUID(),
      ])
    )[0]?.outcome;
  const stateOf = async (event: string) =>
    (await run<{ state: string }>(team(ownerA), "SELECT * FROM results_state($1)", [event]))[0];
  const remove = (event: string, entry: string, staff = ownerA) =>
    run(team(staff), "SELECT * FROM remove_award($1, $2, 'cheat', $3, $4)", [
      event,
      entry,
      randomUUID(),
      randomUUID(),
    ]);
  const winnerRedemption = async (event: string, rank: number) =>
    (
      await owner<{ redemption_id: string | null }>(
        "SELECT redemption_id FROM result_place WHERE event_id = $1 AND rank = $2",
        [event, rank],
      )
    )[0]?.redemption_id ?? null;

  describe("who wins", () => {
    it("ranks by score, then by who got there first, without operators, banned or excluded players", async () => {
      const event = await newEvent();
      const late = await newPlayer(event, 0);
      const early = await newPlayer(event, 50);
      await earn(event, late.enrollment, 50);
      const top = await newPlayer(event, 90);
      const banned = await newPlayer(event, 500);
      await owner("UPDATE enrollment SET status = 'banned' WHERE id = $1", [banned.enrollment]);
      const excluded = await newPlayer(event, 400);
      const domain = (
        await owner<{ email: string }>("SELECT email FROM player_contact WHERE player_id = $1", [
          excluded.player,
        ])
      )[0]?.email.split("@")[1];
      await owner(
        "INSERT INTO event_exclusion (organizer_id, event_id, kind, value) VALUES ($1, $2, 'email_domain', $3)",
        [ids.orgA, event, domain],
      );
      const staffer = await newPlayer(event, 300);
      await owner(
        "INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities) VALUES ($1, $2, $3, $4)",
        [ids.orgA, event, staffer.player, ["hand_over"]],
      );

      const rows = await places(event);
      expect(rows.map((r) => [r.rank, r.enrollment_id])).toEqual([
        [1, top.enrollment],
        [2, early.enrollment],
        [3, late.enrollment],
      ]);
    });

    it("keeps at least 10 places, or as many as the highest prize rank", async () => {
      const event = await newEvent();
      for (let i = 0; i < 13; i += 1) {
        await newPlayer(event, 10 + i);
      }
      expect(await places(event)).toHaveLength(10);
      await prize(event, 11, 12);
      expect(await places(event)).toHaveLength(12);
      await owner("UPDATE event SET rank_prizes = false WHERE id = $1", [event]);
      expect(await places(event)).toHaveLength(10);
    });

    it("shows each player's open flags and the prize for their rank before confirming", async () => {
      const event = await newEvent();
      const first = await newPlayer(event, 100);
      await newPlayer(event, 50);
      const trophy = await prize(event, 1, 1);
      await owner(
        "INSERT INTO flag (organizer_id, event_id, enrollment_id, kind) VALUES ($1, $2, $3, 'burst')",
        [ids.orgA, event, first.enrollment],
      );
      const rows = await run<Row>(team(editorA), "SELECT * FROM results_places($1)", [event]);
      expect(rows[0]).toMatchObject({
        rank: 1,
        open_flags: 1,
        flag_kinds: ["burst"],
        prize_id: trophy,
      });
      expect(rows[1]).toMatchObject({ rank: 2, open_flags: 0, flag_kinds: [], prize_id: null });
      expect(await stateOf(event)).toMatchObject({ state: "open" });
    });
  });

  describe("confirming", () => {
    it("is the owner's, once the event has ended, against the places the owner saw", async () => {
      const live = await newEvent("live");
      await newPlayer(live, 10);
      expect(await stateOf(live)).toMatchObject({ state: "not_ended" });
      expect(await refusal(confirm(live))).toEqual({ code: "RF409", detail: "not_ended" });
      for (const phase of ["draft", "archived"] as const) {
        expect(await refusal(confirm(await newEvent(phase), []))).toEqual({
          code: "RF409",
          detail: "not_ended",
        });
      }

      const event = await newEvent();
      const a = await newPlayer(event, 20);
      const b = await newPlayer(event, 10);
      expect(await confirm(event, undefined, editorA)).toBe("not_owner");
      expect(await refusal(confirm(event, [b.enrollment, a.enrollment]))).toEqual({
        code: "RF409",
        detail: "results_changed",
      });
      expect(await refusal(confirm(event, [a.enrollment]))).toEqual({
        code: "RF409",
        detail: "results_changed",
      });
      expect(
        (await refusal(run(team(ownerA), "SELECT confirm_results($1, NULL, NULL)", [event]))).code,
      ).toBe("22023");
      expect(await refusal(confirm(event, [], ownerB, ids.orgB))).toEqual({ code: "AN404" });
      expect(await owner("SELECT 1 FROM event_result WHERE event_id = $1", [event])).toHaveLength(
        0,
      );

      expect(await confirm(event, [a.enrollment, b.enrollment])).toBe("confirmed");
      expect(await confirm(event, [])).toBe("replayed");
      expect(await stateOf(event)).toMatchObject({ state: "confirmed" });
      const audit = await owner<{ action: string; after: Row }>(
        "SELECT action, after FROM audit_log WHERE event_id = $1 AND action = 'event.results_confirmed'",
        [event],
      );
      expect(audit).toEqual([
        { action: "event.results_confirmed", after: { places: 2, flagged: 0 } },
      ]);
    });

    it("confirms with nobody placed", async () => {
      const event = await newEvent();
      expect(await confirm(event, [])).toBe("confirmed");
    });

    it("freezes the places: removals are refused; a ban, a new flag and more points change nothing", async () => {
      const event = await newEvent();
      const a = await newPlayer(event, 30);
      const b = await newPlayer(event, 20);
      await prize(event, 1, 2);
      await owner(
        "INSERT INTO flag (organizer_id, event_id, enrollment_id, kind) VALUES ($1, $2, $3, 'burst')",
        [ids.orgA, event, b.enrollment],
      );
      expect(await confirm(event)).toBe("confirmed");

      expect(await refusal(remove(event, a.entry))).toEqual({
        code: "RF409",
        detail: "results_final",
      });
      await run(team(ownerA), "SELECT set_enrollment_ban($1, $2, true, $3)", [
        event,
        a.enrollment,
        randomUUID(),
      ]);
      await earn(event, b.enrollment, 100);
      const rows = await places(event);
      expect(rows.map((r) => [r.rank, r.enrollment_id, Number(r.score), r.open_flags])).toEqual([
        [1, a.enrollment, 30, 0],
        [2, b.enrollment, 20, 1],
      ]);
    });

    it("locks the prizes and the switch once results are confirmed", async () => {
      const event = await newEvent();
      const trophy = await prize(event, 1, 1);
      await confirm(event, []);
      expect(
        await refusal(
          run(team(ownerA), "UPDATE rank_prize SET name_en = 'Cup' WHERE id = $1", [trophy]),
        ),
      ).toEqual({ code: "RF409", detail: "results_final" });
    });
  });

  describe("races", () => {
    /** Runs `first` in a transaction held open, starts `second`, then commits `first`. */
    const holdThen = async (
      first: (client: PoolClient) => Promise<unknown>,
      second: () => Promise<unknown>,
      firstContext: RequestContext,
    ) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await withRequestContext(client, firstContext, () => first(client));
        const later = second().then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({
            ok: false as const,
            error: error as { code: string; detail?: string },
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
        await client.query("COMMIT");
        return await later;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    };

    it("a removal holding the event makes the confirm wait, and the confirm sees the lower score", async () => {
      const event = await newEvent();
      const a = await newPlayer(event, 30);
      await earn(event, a.enrollment, 5);
      const b = await newPlayer(event, 20);
      const removedFirst = [b.enrollment, a.enrollment];
      const result = await holdThen(
        (client) =>
          client.query("SELECT * FROM remove_award($1, $2, 'cheat', $3, $4)", [
            event,
            a.entry,
            randomUUID(),
            randomUUID(),
          ]),
        () => confirm(event, removedFirst),
        team(ownerA),
      );
      expect(result).toEqual({ ok: true, value: "confirmed" });
    });

    it("a confirm holding the event makes the removal wait, and the removal is refused", async () => {
      const event = await newEvent();
      const a = await newPlayer(event, 30);
      const b = await newPlayer(event, 20);
      const result = await holdThen(
        (client) =>
          client.query("SELECT confirm_results($1, $2, $3)", [
            event,
            [a.enrollment, b.enrollment],
            randomUUID(),
          ]),
        () => remove(event, a.entry),
        team(ownerA),
      );
      expect(result.ok).toBe(false);
      expect(result.ok ? null : { code: result.error.code, detail: result.error.detail }).toEqual({
        code: "RF409",
        detail: "results_final",
      });
    });

    it("two confirms at once: one confirms, the other replays", async () => {
      const event = await newEvent();
      await newPlayer(event, 30);
      const seen = await expectedOf(event);
      const outcomes = await Promise.all([confirm(event, seen), confirm(event, seen)]);
      expect(outcomes.sort()).toEqual(["confirmed", "replayed"]);
      expect(await owner("SELECT 1 FROM result_place WHERE event_id = $1", [event])).toHaveLength(
        1,
      );
    });

    it("a ban committed after the owner looked makes their list stale", async () => {
      const event = await newEvent();
      const a = await newPlayer(event, 30);
      await newPlayer(event, 20);
      const seen = await expectedOf(event);
      await run(team(ownerA), "SELECT set_enrollment_ban($1, $2, true, $3)", [
        event,
        a.enrollment,
        randomUUID(),
      ]);
      expect(await refusal(confirm(event, seen))).toEqual({
        code: "RF409",
        detail: "results_changed",
      });
    });

    it("two overlapping prizes written at once: one is refused", async () => {
      const event = await newEvent("draft");
      const insert = (from: number, to: number) =>
        run(
          team(ownerA),
          "INSERT INTO rank_prize (event_id, rank_from, rank_to, kind, name_en) VALUES ($1, $2, $3, 'experience', 'Tour')",
          [event, from, to],
        ).then(
          () => "ok",
          (error: { detail?: string }) => error.detail,
        );
      const outcomes = await Promise.all([insert(1, 3), insert(3, 5)]);
      expect(outcomes.sort()).toEqual(["ok", "overlap"]);
    });
  });

  describe("prizes", () => {
    const write = (sql: string, values: unknown[], staff = ownerA) => run(team(staff), sql, values);

    it("organizers write prizes in their events; overlaps, a desk-less item and edits of removed ones are refused", async () => {
      const event = await newEvent("draft");
      await write(
        "INSERT INTO rank_prize (event_id, rank_from, rank_to, kind, name_en) VALUES ($1, 1, 3, 'item', 'Cup')",
        [event],
      );
      expect(
        await refusal(
          write(
            "INSERT INTO rank_prize (event_id, rank_from, rank_to, kind, name_en) VALUES ($1, 3, 4, 'item', 'Pin')",
            [event],
          ),
        ),
      ).toEqual({ code: "RF409", detail: "overlap" });
      await owner("UPDATE event SET desk_location_en = NULL WHERE id = $1", [event]).catch(
        () => undefined,
      );
      const bare = await newEvent("draft");
      await owner("UPDATE event SET desk_location_en = NULL WHERE id = $1", [bare]);
      expect(
        await refusal(
          write(
            "INSERT INTO rank_prize (event_id, rank_from, rank_to, kind, name_en) VALUES ($1, 1, 1, 'item', 'Cup')",
            [bare],
          ),
        ),
      ).toEqual({ code: "DL409" });
      await write(
        "INSERT INTO rank_prize (event_id, rank_from, rank_to, kind, name_en) VALUES ($1, 1, 1, 'experience', 'Tour')",
        [bare],
      );
      const [made] = await owner<{ id: string }>("SELECT id FROM rank_prize WHERE event_id = $1", [
        event,
      ]);
      await write("UPDATE rank_prize SET status = 'removed' WHERE id = $1", [made?.id]);
      expect(
        await refusal(write("UPDATE rank_prize SET name_en = 'X' WHERE id = $1", [made?.id])),
      ).toEqual({
        code: "RF409",
        detail: "removed",
      });
      expect(
        await refusal(
          write(
            "INSERT INTO rank_prize (event_id, rank_from, rank_to, kind, name_en) VALUES ($1, 3, 1, 'item', 'Cup')",
            [event],
          ),
        ),
      ).toMatchObject({ code: "23514" });
      expect(
        await run(team(ownerB, ids.orgB), "SELECT * FROM rank_prize WHERE event_id = $1", [event]),
      ).toEqual([]);
      expect(
        await refusal(
          write(
            "INSERT INTO rank_prize (event_id, rank_from, rank_to, kind, name_en) VALUES ($1, 9, 9, 'experience', 'X')",
            [event],
            ownerB,
          ),
        ),
      ).toMatchObject({ code: expect.stringMatching(/^(42501|AN404)$/) });
    });

    it("locks ranges, adding, removing and the switch once live; names stay editable", async () => {
      const event = await newEvent("live");
      const cup = await prize(event, 1, 1);
      expect(
        await refusal(
          write(
            "INSERT INTO rank_prize (event_id, rank_from, rank_to, kind, name_en) VALUES ($1, 2, 2, 'item', 'Pin')",
            [event],
          ),
        ),
      ).toEqual({ code: "RF409", detail: "prizes_locked" });
      for (const change of ["rank_to = 2", "rank_from = 1, rank_to = 3", "status = 'removed'"]) {
        expect(
          await refusal(write(`UPDATE rank_prize SET ${change} WHERE id = $1`, [cup])),
        ).toEqual({
          code: "RF409",
          detail: "prizes_locked",
        });
      }
      await write(
        "UPDATE rank_prize SET name_en = 'Gold cup', description_en = 'Shiny' WHERE id = $1",
        [cup],
      );
      expect(
        await refusal(write("UPDATE event SET rank_prizes = false WHERE id = $1", [event])),
      ).toEqual({
        code: "RF409",
        detail: "prizes_locked",
      });
      await write("UPDATE event SET rules_en = 'Be kind.' WHERE id = $1", [event]);
      const draft = await newEvent("draft");
      await write("UPDATE event SET rank_prizes = false WHERE id = $1", [draft]);
    });

    it("keeps the desk's place while an item prize needs it", async () => {
      const event = await newEvent("draft");
      await prize(event, 1, 1);
      expect(
        await refusal(write("UPDATE event SET desk_location_en = NULL WHERE id = $1", [event])),
      ).toEqual({
        code: "DL409",
      });
    });

    it("is never in the shop", async () => {
      const event = await newEvent("live");
      const cup = await prize(event, 1, 1);
      const p = await newPlayer(event, 100);
      expect(await call(p.player, "SELECT * FROM shop_rewards($1)", [event])).toEqual([]);
      expect(
        await refusal(call(p.player, "SELECT * FROM reserve_reward($1, $2)", [cup, randomUUID()])),
      ).toEqual({
        code: "RN404",
      });
    });
  });

  describe("the reveal", () => {
    const confirmed = async (withSwitch = true) => {
      const event = await newEvent();
      if (!withSwitch) {
        await owner("UPDATE event SET rank_prizes = false WHERE id = $1", [event]);
      }
      const first = await newPlayer(event, 300);
      const second = await newPlayer(event, 200);
      const third = await newPlayer(event, 100);
      const gold = await prize(event, 1, 1, "Gold");
      const silver = await prize(event, 2, 2, "Silver", "experience");
      await confirm(event);
      return { event, first, second, third, gold, silver };
    };

    it("needs confirmed results and a deadline from 1 hour to 60 days away with the desk open before it", async () => {
      const event = await newEvent();
      expect(await refusal(reveal(event))).toEqual({ code: "RF409", detail: "not_confirmed" });
      await confirm(event, []);
      expect(await reveal(event, undefined, editorA)).toBe("not_owner");
      expect(await refusal(reveal(event, new Date(Date.now() + 30 * 60 * 1000)))).toEqual({
        code: "RF409",
        detail: "bad_deadline",
      });
      expect(await refusal(reveal(event, new Date(Date.now() + 61 * 24 * HOUR)))).toEqual({
        code: "RF409",
        detail: "bad_deadline",
      });
      await owner(
        "UPDATE event SET desk_hours = tstzmultirange(tstzrange(now() + interval '3 days', now() + interval '4 days')) WHERE id = $1",
        [event],
      );
      expect(await refusal(reveal(event, new Date(Date.now() + 2 * 24 * HOUR)))).toEqual({
        code: "RF409",
        detail: "desk_closed_until_deadline",
      });
      expect(await reveal(event, new Date(Date.now() + 5 * 24 * HOUR))).toBe("revealed");
      expect(await stateOf(event)).toMatchObject({ state: "revealed" });
    });

    it("offers the desk's last closing, else the shop's closing, as the default deadline", async () => {
      const event = await newEvent();
      const [{ ends_at } = { ends_at: new Date() }] = await owner<{ ends_at: Date }>(
        "SELECT ends_at FROM event WHERE id = $1",
        [event],
      );
      expect((await stateOf(event)) as Row).toMatchObject({
        default_claim_until: new Date(ends_at.getTime() + 3 * 24 * HOUR),
      });
      await owner(
        "UPDATE event SET desk_hours = tstzmultirange(tstzrange('2030-01-01 08:00Z', '2030-01-01 12:00Z')) WHERE id = $1",
        [event],
      );
      expect((await stateOf(event)) as Row).toMatchObject({
        default_claim_until: new Date("2030-01-01T12:00:00Z"),
      });
    });

    it("gives each prize rank's winner a reserved item with no price, once", async () => {
      const { event, first, second, third, gold, silver } = await confirmed();
      const claim = new Date(Date.now() + 48 * HOUR);
      expect(await reveal(event, claim)).toBe("revealed");
      const made = await owner<Row>(
        `SELECT enrollment_id, rank_prize_id, price, status, reserved_until FROM redemption
         WHERE event_id = $1 ORDER BY price, rank_prize_id = $2 DESC`,
        [event, gold],
      );
      expect(made).toEqual([
        {
          enrollment_id: first.enrollment,
          rank_prize_id: gold,
          price: 0,
          status: "reserved",
          reserved_until: claim,
        },
        {
          enrollment_id: second.enrollment,
          rank_prize_id: silver,
          price: 0,
          status: "reserved",
          reserved_until: claim,
        },
      ]);
      expect(await winnerRedemption(event, 3)).toBeNull();
      expect(await reveal(event)).toBe("replayed");
      expect(await owner("SELECT 1 FROM redemption WHERE event_id = $1", [event])).toHaveLength(2);
      expect(
        await owner(
          "SELECT 1 FROM ledger_entry WHERE event_id = $1 AND redemption_id IS NOT NULL",
          [event],
        ),
      ).toHaveLength(0);
      const balances = await owner<{ score: string; balance: string }>(
        "SELECT score, balance FROM enrollment WHERE id = ANY ($1) ORDER BY score DESC",
        [[first.enrollment, second.enrollment, third.enrollment]],
      );
      expect(balances.map((b) => [Number(b.score), Number(b.balance)])).toEqual([
        [300, 300],
        [200, 200],
        [100, 100],
      ]);
      const [audit] = await owner<{ after: Row }>(
        "SELECT after FROM audit_log WHERE event_id = $1 AND action = 'event.results_revealed'",
        [event],
      );
      expect(audit?.after).toMatchObject({ prizes: 2 });
    });

    it("gives nothing when prizes were switched off", async () => {
      const { event } = await confirmed(false);
      expect(await reveal(event)).toBe("revealed");
      expect(await owner("SELECT 1 FROM redemption WHERE event_id = $1", [event])).toHaveLength(0);
    });

    it("is not stopped by a key the winner already used", async () => {
      const event = await newEvent();
      const first = await newPlayer(event, 300);
      await prize(event, 1, 1);
      const reward = (
        await owner<{ id: string }>(
          "INSERT INTO reward (event_id, kind, name_en, price, stock_total, units_out) VALUES ($1, 'item', 'Cap', 5, 9, 1) RETURNING id",
          [event],
        )
      )[0]?.id;
      await owner(
        `INSERT INTO redemption (organizer_id, event_id, enrollment_id, reward_id, price, idempotency_key, reserved_until)
         VALUES ($1, $2, $3, $4, 5, 'rank prize 1', now() + interval '1 hour')`,
        [ids.orgA, event, first.enrollment, reward],
      );
      await confirm(event);
      expect(await reveal(event)).toBe("revealed");
      expect(await winnerRedemption(event, 1)).not.toBeNull();
    });

    it("a reservation key that names the rank prize's redemption is refused as another reward's", async () => {
      const { event, first } = await confirmed();
      await reveal(event);
      const [{ idempotency_key: key } = { idempotency_key: "" }] = await owner<{
        idempotency_key: string;
      }>("SELECT idempotency_key FROM redemption WHERE enrollment_id = $1", [first.enrollment]);
      expect(key).toMatch(/^rank prize [0-9a-f-]{36}$/);
      const reward = (
        await owner<{ id: string }>(
          "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, 'item', 'Cap', 5, 9) RETURNING id",
          [event],
        )
      )[0]?.id;
      expect(
        await refusal(call(first.player, "SELECT * FROM reserve_reward($1, $2)", [reward, key])),
      ).toEqual({
        code: "RK422",
      });
    });
  });

  describe("the prize at the desk", () => {
    const revealed = async () => {
      const event = await newEvent();
      const winner = await newPlayer(event, 300);
      await prize(event, 1, 1, "Gold");
      await confirm(event);
      await reveal(event);
      const redemption = (await winnerRedemption(event, 1)) ?? "";
      const operator = await newOperator(event);
      return { event, winner, redemption, operator };
    };

    it("is handed over like any item, with a 0/0 entry and nothing taken", async () => {
      const { event, winner, redemption, operator } = await revealed();
      const [seen] = await call<Row>(operator, "SELECT * FROM desk_lookup($1, $2, 1)", [
        event,
        winner.player,
      ]);
      expect(seen).toMatchObject({
        redemption_id: redemption,
        kind: "item",
        name_en: "Gold",
        rank: 1,
      });
      const [found] = await call<Row>(operator, "SELECT * FROM desk_find($1, $2, NULL)", [
        event,
        (
          await owner<{ username: string }>("SELECT username FROM player WHERE id = $1", [
            winner.player,
          ])
        )[0]?.username,
      ]);
      expect(found).toMatchObject({ redemption_id: redemption, rank: 1 });
      const [mine] = await call<Row>(winner.player, "SELECT * FROM my_redemptions($1)", [event]);
      expect(mine).toMatchObject({
        id: redemption,
        reward_id: null,
        name_en: "Gold",
        price: 0,
        rank: 1,
      });

      await call(winner.player, "SELECT start_collect($1)", [redemption]);
      const [ready] = await call<Row>(winner.player, "SELECT * FROM my_desk_items()");
      expect(ready).toMatchObject({
        redemption_id: redemption,
        kind: "item",
        name_en: "Gold",
        state: "collecting",
      });
      await call(operator, "SELECT * FROM desk_hand_over($1)", [redemption]);

      const entries = await owner<Row>(
        "SELECT kind, score_delta, balance_delta FROM ledger_entry WHERE redemption_id = $1",
        [redemption],
      );
      expect(entries).toEqual([{ kind: "handover", score_delta: "0", balance_delta: "0" }]);
      const [after] = await owner<{ score: string; balance: string }>(
        "SELECT score, balance FROM enrollment WHERE id = $1",
        [winner.enrollment],
      );
      expect(after).toEqual({ score: "300", balance: "300" });
      const history = await call<Row>(
        winner.player,
        "SELECT * FROM member_activity($1, NULL, 10)",
        [event],
      );
      expect(history[0]).toMatchObject({ kind: "handover", title_en: "Gold" });
    });

    it("cannot be cancelled by its winner; an operator's cancel and the timeout give nothing back", async () => {
      const first = await revealed();
      expect(
        await refusal(
          call(first.winner.player, "SELECT * FROM cancel_redemption($1)", [first.redemption]),
        ),
      ).toEqual({ code: "RZ409" });
      const [cancelled] = await call<Row>(
        first.operator,
        "SELECT * FROM operator_cancel_redemption($1)",
        [first.redemption],
      );
      expect(cancelled).toMatchObject({ status: "cancelled", price: 0, replayed: false });

      const second = await revealed();
      await owner(
        "UPDATE redemption SET reserved_until = now() - interval '1 minute' WHERE id = $1",
        [second.redemption],
      );
      let outcome: string | null | undefined = "expired";
      while (outcome !== null && outcome !== undefined) {
        outcome = (await owner<{ o: string | null }>("SELECT expire_one_reservation() AS o"))[0]?.o;
      }
      expect(
        (
          await owner<{ status: string }>("SELECT status FROM redemption WHERE id = $1", [
            second.redemption,
          ])
        )[0],
      ).toEqual({ status: "expired" });
      expect(
        await owner("SELECT 1 FROM ledger_entry WHERE redemption_id = ANY ($1)", [
          [first.redemption, second.redemption],
        ]),
      ).toHaveLength(0);
    });

    it("is held for a flag or a ban, and the flag's case lists it", async () => {
      const { event, winner, redemption, operator } = await revealed();
      await call(winner.player, "SELECT start_collect($1)", [redemption]);
      const [flag] = await owner<{ id: string }>(
        "INSERT INTO flag (organizer_id, event_id, enrollment_id, kind) VALUES ($1, $2, $3, 'burst') RETURNING id",
        [ids.orgA, event, winner.enrollment],
      );
      expect(
        await refusal(call(operator, "SELECT * FROM desk_hand_over($1)", [redemption])),
      ).toEqual({
        code: "RH409",
        detail: "held",
      });
      const [detail] = await run<{ waiting: Row[] }>(
        team(ownerA),
        "SELECT waiting FROM flag_detail($1, $2)",
        [event, flag?.id],
      );
      expect(detail?.waiting).toEqual([expect.objectContaining({ nameEn: "Gold", nameAr: "كأس" })]);
      await owner(
        "UPDATE flag SET status = 'cleared', resolution = 'cleared', resolved_at = now() WHERE id = $1",
        [flag?.id],
      );
      await run(team(ownerA), "SELECT set_enrollment_ban($1, $2, true, $3)", [
        event,
        winner.enrollment,
        randomUUID(),
      ]);
      expect(
        await refusal(call(operator, "SELECT * FROM desk_hand_over($1)", [redemption])),
      ).toEqual({
        code: "RH409",
        detail: "held",
      });
    });
  });

  describe("what players read", () => {
    it("sees the results only after the reveal, and their own prize", async () => {
      const event = await newEvent();
      const winner = await newPlayer(event, 300);
      const other = await newPlayer(event, 100);
      const stranger = await newPlayer(await newEvent(), 50);
      await prize(event, 1, 1, "Gold");
      await confirm(event);
      expect(await call(winner.player, "SELECT * FROM event_results($1)", [event])).toEqual([]);
      const claim = new Date(Date.now() + 24 * HOUR);
      await reveal(event, claim);
      const mine = await call<Row>(winner.player, "SELECT * FROM event_results($1)", [event]);
      expect(mine).toEqual([
        expect.objectContaining({
          rank: 1,
          prize_name_en: "Gold",
          mine: true,
          redemption_status: "reserved",
          claim_until: claim,
        }),
        expect.objectContaining({ rank: 2, prize_name_en: null, mine: false, redemption_id: null }),
      ]);
      const theirs = await call<Row>(other.player, "SELECT * FROM event_results($1)", [event]);
      expect(theirs[0]).toMatchObject({
        mine: false,
        redemption_id: null,
        redemption_status: null,
      });
      expect(await call(stranger.player, "SELECT * FROM event_results($1)", [event])).toEqual([]);
    });

    it("reads the rules' data by code with the join card's visibility, and as a member", async () => {
      const event = await newEvent("live");
      await prize(event, 2, 3, "Silver");
      await prize(event, 1, 1, "Gold");
      await owner("UPDATE event SET rules_en = 'Play fair.' WHERE id = $1", [event]);
      const [code] = await owner<{ join_code: string }>(
        "SELECT join_code FROM event WHERE id = $1",
        [event],
      );
      const [{ rules } = { rules: null }] = await run<{ rules: Row }>(
        {},
        "SELECT public_event_rules($1) AS rules",
        [code?.join_code.toLowerCase()],
      );
      expect(rules).toMatchObject({
        rankPrizes: true,
        prizes: [
          { rankFrom: 1, rankTo: 1, kind: "item", nameEn: "Gold" },
          { rankFrom: 2, rankTo: 3, kind: "item", nameEn: "Silver" },
        ],
        claimUntil: null,
        rulesAr: null,
        rulesEn: "Play fair.",
        timezone: "Asia/Riyadh",
      });
      for (const phase of ["draft", "archived"] as const) {
        const hidden = await newEvent(phase);
        const [c] = await owner<{ join_code: string }>(
          "SELECT join_code FROM event WHERE id = $1",
          [hidden],
        );
        expect(await run({}, "SELECT public_event_rules($1) AS rules", [c?.join_code])).toEqual([
          { rules: null },
        ]);
      }
      const member = await newPlayer(event);
      const [mine] = await call<{ rules: Row }>(member.player, "SELECT event_rules($1) AS rules", [
        event,
      ]);
      expect(mine?.rules).toMatchObject({ rulesEn: "Play fair." });
      const outsider = await newPlayer(await newEvent("live"));
      expect(await call(outsider.player, "SELECT event_rules($1) AS rules", [event])).toEqual([
        { rules: null },
      ]);
    });

    it("lists no prizes in the rules with the switch off", async () => {
      const event = await newEvent("draft");
      await prize(event, 1, 1);
      await owner("UPDATE event SET rank_prizes = false WHERE id = $1", [event]);
      const member = await newPlayer(event);
      const [mine] = await call<{ rules: Row }>(member.player, "SELECT event_rules($1) AS rules", [
        event,
      ]);
      expect(mine?.rules).toMatchObject({ rankPrizes: false, prizes: [] });
    });
  });

  it("the API role cannot read results or places directly", async () => {
    for (const table of ["event_result", "result_place"]) {
      expect(await refusal(run(team(ownerA), `SELECT * FROM ${table}`))).toEqual({ code: "42501" });
      expect(await refusal(run({}, `SELECT * FROM ${table}`))).toEqual({ code: "42501" });
    }
  });
});
