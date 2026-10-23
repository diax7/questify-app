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

const noop = (): void => undefined;

const refusal = async (work: Promise<unknown>): Promise<{ code: string; detail?: string }> => {
  try {
    await work;
  } catch (error) {
    const { code, detail } = error as { code: string; detail?: string };
    return detail === undefined ? { code } : { code, detail };
  }
  throw new Error("expected a refusal");
};

/**
 * Flags, the desk's hold and the owner's pause in the database (T-209, migration 0031): both detectors on every
 * completion path, the hold in every handover path (never naming a ban), the case actions and who may take them, the
 * pause on the player's side, and the races between them.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("flags and the desk hold (database)", () => {
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

  const newEvent = async (organizer = ids.orgA, mode = "collect_first"): Promise<string> => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at, desk_location_en,
                          handover_confirm)
       VALUES ($1, $2, 'Flag Fest', 'live', now() - interval '1 hour', now() + interval '2 days', 'Hall B', $3)
       RETURNING id`,
      [organizer, `FLAG${counter}`, mode],
    );
    await owner("INSERT INTO category (event_id, name_en) VALUES ($1, 'General')", [event?.id]);
    return event?.id ?? "";
  };

  const newQuest = async (event: string, points = 10): Promise<string> => {
    const [quest] = await owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, visible, type_config)
       SELECT $1, id, 'scan_qr', 'Lion', $2, 100, true, '{}' FROM category WHERE event_id = $1 LIMIT 1
       RETURNING id`,
      [event, points],
    );
    return quest?.id ?? "";
  };

  const organizerOf = async (event: string) =>
    (
      await owner<{ organizer_id: string }>("SELECT organizer_id FROM event WHERE id = $1", [event])
    )[0]?.organizer_id ?? "";

  /** A player enrolled in the event, holding `points` from one quest with no device (it raises nothing). */
  const newPlayer = async (event: string, points = 1000) => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`flag_player_${counter}`],
    );
    const organizer = await organizerOf(event);
    const [enrolled] = await owner<{ id: string }>(
      "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3) RETURNING id",
      [organizer, event, player?.id],
    );
    if (points > 0) {
      const quest = await newQuest(event, points);
      const [done] = await owner<{ id: string }>(
        `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                       idempotency_key, created_at)
         VALUES ($1, $2, $3, $4, 1, 'qr', $5, now() - interval '1 hour') RETURNING id`,
        [organizer, event, enrolled?.id, quest, randomUUID()],
      );
      await owner(
        `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                   completion_id, quest_id, actor)
         VALUES ($1, $2, $3, 'quest', $4, $4, $5, $6, 'player')`,
        [organizer, event, enrolled?.id, points, done?.id, quest],
      );
    }
    return { player: player?.id ?? "", enrollment: enrolled?.id ?? "" };
  };

  const newOperator = async (event: string, abilities = ["hand_over"]): Promise<string> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`flag_op_${counter}`],
    );
    await owner(
      "INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities) VALUES ($1, $2, $3, $4)",
      [await organizerOf(event), event, player?.id, abilities],
    );
    return player?.id ?? "";
  };

  const newReward = async (event: string): Promise<string> =>
    (
      await owner<{ id: string }>(
        "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, 'item', 'Hoodie', 100, 9) RETURNING id",
        [event],
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
  const call = <T extends Row>(player: string, sql: string, values: unknown[] = []) =>
    run<T>({ playerId: player }, sql, values);
  const team = (staff: string, organizer = ids.orgA): RequestContext => ({
    organizerId: organizer,
    staffUserId: staff,
  });

  /** The player's own scan through the completion engine, from an install (or none, like a station). */
  const scan = (player: string, quest: string, device: string | null) =>
    call(player, "SELECT * FROM complete_quest($1, 'qr', 1, NULL, $2, $3)", [
      quest,
      randomUUID(),
      device,
    ]);

  const reserve = async (player: string, reward: string, key = randomUUID()): Promise<string> =>
    (
      await call<{ redemption_id: string }>(player, "SELECT * FROM reserve_reward($1, $2)", [
        reward,
        key,
      ])
    )[0]?.redemption_id ?? "";
  const collect = (player: string, redemption: string) =>
    call(player, "SELECT start_collect($1) AS until", [redemption]);
  const handOver = (operator: string, redemption: string) =>
    call(operator, "SELECT * FROM desk_hand_over($1)", [redemption]);
  const statusOf = async (redemption: string) =>
    (
      await owner<{ status: string }>("SELECT status FROM redemption WHERE id = $1", [redemption])
    )[0]?.status;

  const flagsOf = (enrollment: string) =>
    owner<{
      id: string;
      kind: string;
      status: string;
      resolution: string | null;
      evidence: { completions?: number[] };
    }>(
      "SELECT id, kind, status, resolution, evidence FROM flag WHERE enrollment_id = $1 ORDER BY id",
      [enrollment],
    );

  /** A player with an open burst case: ten scans of ten quests within the window. */
  const burst = async (event: string, player: string, scans = 10) => {
    for (let i = 0; i < scans; i += 1) {
      await scan(player, await newQuest(event), null);
    }
  };

  /** A player with a collected item waiting at the desk. */
  const atDesk = async (mode = "collect_first") => {
    const event = await newEvent(ids.orgA, mode);
    const desk = await newOperator(event);
    const { player, enrollment } = await newPlayer(event);
    const id = await reserve(player, await newReward(event));
    if (mode === "collect_first") {
      await collect(player, id);
    }
    return { event, desk, player, enrollment, id };
  };

  const lookup = async (desk: string, event: string, player: string) => {
    const [version] = await owner<{ my_qr_version: number }>(
      "SELECT my_qr_version FROM player WHERE id = $1",
      [player],
    );
    return call<{ active: boolean; hold: string | null; redemption_id: string | null }>(
      desk,
      "SELECT * FROM desk_lookup($1, $2, $3)",
      [event, player, version?.my_qr_version],
    );
  };

  /**
   * Runs `first` holding its transaction open while `second` starts and waits for it; then commits `first`. Both
   * settle, in that order.
   */
  const race = async (
    first: [RequestContext, string, unknown[]],
    second: [RequestContext, string, unknown[]],
  ): Promise<PromiseSettledResult<unknown>[]> => {
    const a: PoolClient = await pool.connect();
    const b: PoolClient = await pool.connect();
    let release = noop;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ran = noop;
    const started = new Promise<void>((resolve) => {
      ran = resolve;
    });
    try {
      const firstWork = withRequestContext(a, first[0], async () => {
        const result = await a.query(first[1], first[2]);
        ran();
        await gate;
        return result;
      });
      await Promise.race([started, firstWork]);
      const secondWork = Promise.allSettled([
        withRequestContext(b, second[0], () => b.query(second[1], second[2])),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 150));
      release();
      return [...(await Promise.allSettled([firstWork])), ...(await secondWork)];
    } finally {
      a.release();
      b.release();
    }
  };

  const pause = (event: string, enrollment: string, paused: boolean, staff = ownerA) =>
    run<{ outcome: string }>(team(staff), "SELECT set_redeem_pause($1, $2, $3, $4) AS outcome", [
      event,
      enrollment,
      paused,
      randomUUID(),
    ]);

  const resolve = (
    staff: string,
    event: string,
    flag: string | undefined,
    outcome: string,
    note: string | null = null,
  ) =>
    run(team(staff), "SELECT * FROM resolve_flag($1, $2, $3, $4, $5)", [
      event,
      flag,
      outcome,
      note,
      randomUUID(),
    ]);

  const find = (desk: string, event: string, username: string | null, phone: string | null) =>
    call<{ username: string; hold: string | null }>(desk, "SELECT * FROM desk_find($1, $2, $3)", [
      event,
      username,
      phone,
    ]);

  describe("same phone (FR-330, FR-1745)", () => {
    it("flags every account of the event seen on one install, once each, and never one alone", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const phone = randomUUID();
      const first = await newPlayer(event, 0);
      const second = await newPlayer(event, 0);
      await scan(first.player, quest, phone);
      expect(await flagsOf(first.enrollment)).toEqual([]);
      await scan(second.player, quest, phone);
      await scan(second.player, await newQuest(event), phone);
      for (const who of [first, second]) {
        expect((await flagsOf(who.enrollment)).map((f) => [f.kind, f.status])).toEqual([
          ["shared_device", "open"],
        ]);
      }
    });

    it("raises nothing for the same two accounts on one phone in different events", async () => {
      const one = await newEvent();
      const two = await newEvent();
      const phone = randomUUID();
      const here = await newPlayer(one, 0);
      const there = await newPlayer(two, 0);
      await scan(here.player, await newQuest(one), phone);
      await scan(there.player, await newQuest(two), phone);
      expect([...(await flagsOf(here.enrollment)), ...(await flagsOf(there.enrollment))]).toEqual(
        [],
      );
    });

    it("never matches station scans or manual awards, which carry no install of the player", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const first = await newPlayer(event, 0);
      const second = await newPlayer(event, 0);
      await scan(first.player, quest, null);
      await scan(second.player, quest, null);
      const organizer = await organizerOf(event);
      await owner(
        `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                       idempotency_key, device_id)
         VALUES ($1, $2, $3, $4, 2, 'manual', $5, $6), ($1, $2, $7, $4, 2, 'manual', $8, $6)`,
        [
          organizer,
          event,
          first.enrollment,
          quest,
          randomUUID(),
          randomUUID(),
          second.enrollment,
          randomUUID(),
        ],
      );
      expect([...(await flagsOf(first.enrollment)), ...(await flagsOf(second.enrollment))]).toEqual(
        [],
      );
    });

    it("keeps a cleared case cleared, and gives a third account on that phone its own case", async () => {
      const event = await newEvent();
      const phone = randomUUID();
      const first = await newPlayer(event, 0);
      const second = await newPlayer(event, 0);
      await scan(first.player, await newQuest(event), phone);
      await scan(second.player, await newQuest(event), phone);
      const [case1] = await flagsOf(first.enrollment);
      await run(team(ownerA), "SELECT * FROM resolve_flag($1, $2, 'cleared', 'siblings', $3)", [
        event,
        case1?.id,
        randomUUID(),
      ]);
      await scan(first.player, await newQuest(event), phone);
      const third = await newPlayer(event, 0);
      await scan(third.player, await newQuest(event), phone);
      expect((await flagsOf(first.enrollment)).map((f) => f.status)).toEqual(["cleared"]);
      expect((await flagsOf(third.enrollment)).map((f) => f.status)).toEqual(["open"]);
    });

    it("sees the other account when two scan at once on one phone: the second waits on the phone's lock", async () => {
      const event = await newEvent();
      const phone = randomUUID();
      const first = await newPlayer(event, 0);
      const second = await newPlayer(event, 0);
      const sql = "SELECT * FROM complete_quest($1, 'qr', 1, NULL, $2, $3)";
      const settled = await race(
        [{ playerId: first.player }, sql, [await newQuest(event), randomUUID(), phone]],
        [{ playerId: second.player }, sql, [await newQuest(event), randomUUID(), phone]],
      );
      expect(settled.map((s) => s.status)).toEqual(["fulfilled", "fulfilled"]);
      expect((await flagsOf(first.enrollment)).length).toBe(1);
      expect((await flagsOf(second.enrollment)).length).toBe(1);
    });
  });

  describe("bursts (FR-333)", () => {
    it("flags the tenth scan within five minutes, not the ninth, and adds later scans to the open case", async () => {
      const event = await newEvent();
      const { player, enrollment } = await newPlayer(event, 0);
      await burst(event, player, 9);
      expect(await flagsOf(enrollment)).toEqual([]);
      await scan(player, await newQuest(event), null);
      expect(
        (await flagsOf(enrollment)).map((f) => [f.kind, f.evidence.completions?.length]),
      ).toEqual([["burst", 10]]);
      await scan(player, await newQuest(event), null);
      expect((await flagsOf(enrollment)).map((f) => f.evidence.completions?.length)).toEqual([11]);
    });

    it("counts only the window: older scans and manual awards do not count", async () => {
      const event = await newEvent();
      const { player, enrollment } = await newPlayer(event, 0);
      await burst(event, player, 5);
      await owner(
        "UPDATE quest_completion SET created_at = now() - interval '6 minutes' WHERE enrollment_id = $1",
        [enrollment],
      );
      const quest = await newQuest(event);
      const organizer = await organizerOf(event);
      for (let i = 1; i <= 5; i += 1) {
        await owner(
          `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                         idempotency_key)
           VALUES ($1, $2, $3, $4, $5, 'manual', $6)`,
          [organizer, event, enrollment, quest, i, randomUUID()],
        );
      }
      await burst(event, player, 9);
      expect(await flagsOf(enrollment)).toEqual([]);
    });

    it("counts again only after a resolved case, then opens a new one", async () => {
      const event = await newEvent();
      const { player, enrollment } = await newPlayer(event, 0);
      await burst(event, player);
      const [open] = await flagsOf(enrollment);
      await run(team(editorA), "SELECT * FROM resolve_flag($1, $2, 'cleared', NULL, $3)", [
        event,
        open?.id,
        randomUUID(),
      ]);
      await burst(event, player, 9);
      expect((await flagsOf(enrollment)).map((f) => f.status)).toEqual(["cleared"]);
      await scan(player, await newQuest(event), null);
      expect((await flagsOf(enrollment)).map((f) => f.status)).toEqual(["cleared", "open"]);
    });

    it("never changes play, points or the shop (FR-329)", async () => {
      const event = await newEvent();
      const { player, enrollment } = await newPlayer(event, 1000);
      await burst(event, player);
      const [sums] = await owner<{ score: string; balance: string }>(
        "SELECT score, balance FROM enrollment WHERE id = $1",
        [enrollment],
      );
      expect(sums).toEqual({ score: "1100", balance: "1100" });
      await scan(player, await newQuest(event), null);
      expect(await reserve(player, await newReward(event))).not.toBe("");
    });
  });

  describe("the desk's hold (FR-1815, FR-1747)", () => {
    it("holds a flagged player's handover until the case is cleared", async () => {
      const state = await atDesk();
      await burst(state.event, state.player);
      expect(await refusal(handOver(state.desk, state.id))).toEqual({
        code: "RH409",
        detail: "held",
      });
      expect((await lookup(state.desk, state.event, state.player))[0]).toMatchObject({
        active: true,
        hold: "held",
      });
      const [open] = await flagsOf(state.enrollment);
      await run(team(ownerA), "SELECT * FROM resolve_flag($1, $2, 'cleared', NULL, $3)", [
        state.event,
        open?.id,
        randomUUID(),
      ]);
      await handOver(state.desk, state.id);
      expect(await statusOf(state.id)).toBe("handed_over");
    });

    it("hands over to a flagged player while the event's hold is off, and the case stays open", async () => {
      const state = await atDesk();
      await burst(state.event, state.player);
      expect(
        await run(team(ownerA), "SELECT set_flag_hold($1, false, $2) AS outcome", [
          state.event,
          randomUUID(),
        ]),
      ).toEqual([{ outcome: "changed" }]);
      await handOver(state.desk, state.id);
      expect(await statusOf(state.id)).toBe("handed_over");
      expect((await flagsOf(state.enrollment)).map((f) => f.status)).toEqual(["open"]);
    });

    it("holds the desk offer and the player's accept the same way", async () => {
      const state = await atDesk("desk_offer");
      await handOver(state.desk, state.id);
      await burst(state.event, state.player);
      expect(
        await refusal(call(state.player, "SELECT * FROM accept_handover($1)", [state.id])),
      ).toEqual({
        code: "RH409",
        detail: "held",
      });
      expect(await refusal(handOver(state.desk, state.id))).toEqual({
        code: "RH409",
        detail: "held",
      });
    });

    it("answers a banned player exactly like a flagged one, and lifting the ban releases the items", async () => {
      const state = await atDesk();
      await owner("UPDATE enrollment SET status = 'banned' WHERE id = $1", [state.enrollment]);
      const rows = await lookup(state.desk, state.event, state.player);
      expect(rows[0]).toMatchObject({ active: true, hold: "held" });
      expect(JSON.stringify(rows)).not.toContain("banned");
      const refused = await refusal(handOver(state.desk, state.id));
      expect(refused).toEqual({ code: "RH409", detail: "held" });
      await run(team(ownerA), "SELECT set_enrollment_ban($1, $2, false, $3)", [
        state.event,
        state.enrollment,
        randomUUID(),
      ]);
      await handOver(state.desk, state.id);
      expect(await statusOf(state.id)).toBe("handed_over");
    });

    it("shows a player who left as not active, with no hold", async () => {
      const state = await atDesk();
      await owner("UPDATE enrollment SET status = 'left' WHERE id = $1", [state.enrollment]);
      expect((await lookup(state.desk, state.event, state.player))[0]).toMatchObject({
        active: false,
        hold: null,
      });
      expect(await refusal(handOver(state.desk, state.id))).toEqual({
        code: "RA403",
        detail: "left",
      });
    });

    it("keeps the desk's Cancel for a held player", async () => {
      const state = await atDesk();
      await burst(state.event, state.player);
      await call(state.desk, "SELECT * FROM operator_cancel_redemption($1)", [state.id]);
      expect(await statusOf(state.id)).toBe("cancelled");
    });
  });

  describe("the owner's pause (FR-518, FR-1604)", () => {
    it("blocks new reservations, Collect and the handover, says paused first, and lifts on resume", async () => {
      const state = await atDesk();
      const second = await reserve(state.player, await newReward(state.event));
      await burst(state.event, state.player);
      expect(await pause(state.event, state.enrollment, true)).toEqual([{ outcome: "changed" }]);
      expect(await pause(state.event, state.enrollment, true)).toEqual([{ outcome: "unchanged" }]);
      expect(await refusal(reserve(state.player, await newReward(state.event)))).toEqual({
        code: "RP403",
      });
      expect(await refusal(collect(state.player, second))).toEqual({ code: "RP403" });
      expect(await refusal(handOver(state.desk, state.id))).toEqual({
        code: "RH409",
        detail: "paused",
      });
      expect((await lookup(state.desk, state.event, state.player))[0]?.hold).toBe("paused");
      await pause(state.event, state.enrollment, false);
      await collect(state.player, second);
      expect(await refusal(handOver(state.desk, state.id))).toEqual({
        code: "RH409",
        detail: "held",
      });
    });

    it("still answers a replayed reservation after a pause, and lets the player cancel", async () => {
      const event = await newEvent();
      const { player, enrollment } = await newPlayer(event);
      const reward = await newReward(event);
      const key = randomUUID();
      const id = await reserve(player, reward, key);
      await pause(event, enrollment, true);
      expect(await reserve(player, reward, key)).toBe(id);
      await call(player, "SELECT * FROM cancel_redemption($1)", [id]);
      expect(await statusOf(id)).toBe("cancelled");
    });

    it("is the owner's only, inside the organizer", async () => {
      const event = await newEvent();
      const { enrollment } = await newPlayer(event, 0);
      expect(await pause(event, enrollment, true, editorA)).toEqual([{ outcome: "not_owner" }]);
      expect(await pause(event, randomUUID(), true)).toEqual([{ outcome: "not_found" }]);
      expect(
        await refusal(
          run(team(ownerB, ids.orgB), "SELECT set_redeem_pause($1, $2, true, $3)", [
            event,
            enrollment,
            randomUUID(),
          ]),
        ),
      ).toEqual({ code: "AN404" });
      expect(
        await run(team(editorA), "SELECT set_flag_hold($1, false, $2) AS outcome", [
          event,
          randomUUID(),
        ]),
      ).toEqual([{ outcome: "not_owner" }]);
      expect(
        await owner<{ action: string }>("SELECT action FROM audit_log WHERE target_id = $1", [
          enrollment,
        ]),
      ).toEqual([]);
    });
  });

  describe("cases (FR-335, FR-336)", () => {
    it("closes once, as points removed only after a removal, and audits each action", async () => {
      const event = await newEvent();
      const { player, enrollment } = await newPlayer(event, 0);
      await burst(event, player);
      const [open] = await flagsOf(enrollment);
      expect(await refusal(resolve(editorA, event, open?.id, "points_removed"))).toEqual({
        code: "FN409",
        detail: "no_removal",
      });
      const [entry] = await owner<{ id: string }>(
        "SELECT id FROM ledger_entry WHERE enrollment_id = $1 AND kind = 'quest' ORDER BY id DESC LIMIT 1",
        [enrollment],
      );
      await run(team(editorA), "SELECT * FROM remove_award($1, $2, 'cheat', $3, $4)", [
        event,
        entry?.id,
        randomUUID(),
        randomUUID(),
      ]);
      expect(
        await resolve(editorA, event, open?.id, "points_removed", "  took them  "),
      ).toMatchObject([{ status: "confirmed", resolution: "points_removed" }]);
      expect(await refusal(resolve(ownerA, event, open?.id, "cleared"))).toEqual({
        code: "FN409",
        detail: "resolved",
      });
      const [detail] = await run<{ note: string; removals: unknown[]; resolved_by: string }>(
        team(ownerA),
        "SELECT * FROM flag_detail($1, $2)",
        [event, open?.id],
      );
      expect(detail?.note).toBe("took them");
      expect(detail?.removals).toHaveLength(1);
      expect(
        await owner<{ action: string }>(
          "SELECT action FROM audit_log WHERE target_type = 'flag' AND target_id = $1",
          [open?.id],
        ),
      ).toEqual([{ action: "event.flag_confirmed" }]);
    });

    it("refuses a bad outcome or note, another event's case and another organizer", async () => {
      const event = await newEvent();
      const other = await newEvent();
      const { player, enrollment } = await newPlayer(event, 0);
      await burst(event, player);
      const [open] = await flagsOf(enrollment);
      expect(await refusal(resolve(ownerA, event, open?.id, "banned"))).toEqual({ code: "FV400" });
      expect(await refusal(resolve(ownerA, event, open?.id, "cleared", "x".repeat(301)))).toEqual({
        code: "FV400",
      });
      expect(await refusal(resolve(ownerA, other, open?.id, "cleared"))).toEqual({ code: "FN404" });
      expect(await refusal(resolve(ownerB, event, open?.id, "cleared"))).toEqual({ code: "AN404" });
      const scoped = await addMember(db.owner, ids.orgA, "editor", [other]);
      expect(await refusal(resolve(scoped, event, open?.id, "cleared"))).toEqual({ code: "AN404" });
      expect((await flagsOf(enrollment)).map((f) => f.status)).toEqual(["open"]);
    });

    it("closes every open case on a ban, with one audit entry each carrying the request id", async () => {
      const event = await newEvent();
      const phone = randomUUID();
      const { player, enrollment } = await newPlayer(event, 0);
      const twin = await newPlayer(event, 0);
      await scan(player, await newQuest(event), phone);
      await scan(twin.player, await newQuest(event), phone);
      await burst(event, player);
      const request = randomUUID();
      await run(team(ownerA), "SELECT set_enrollment_ban($1, $2, true, $3)", [
        event,
        enrollment,
        request,
      ]);
      expect((await flagsOf(enrollment)).map((f) => [f.status, f.resolution])).toEqual([
        ["confirmed", "banned"],
        ["confirmed", "banned"],
      ]);
      expect((await flagsOf(twin.enrollment)).map((f) => f.status)).toEqual(["open"]);
      const audits = await owner<{ action: string; actor_id: string }>(
        "SELECT action, actor_id FROM audit_log WHERE request_id = $1 ORDER BY id",
        [request],
      );
      expect(audits.map((a) => a.action)).toEqual([
        "event.player_ban",
        "event.flag_confirmed",
        "event.flag_confirmed",
      ]);
      expect(new Set(audits.map((a) => a.actor_id))).toEqual(new Set([ownerA]));
    });

    it("lists open and closed cases with their size and shows the evidence without the install id", async () => {
      const event = await newEvent();
      const phone = randomUUID();
      const { player, enrollment } = await newPlayer(event, 0);
      const twin = await newPlayer(event, 0);
      await scan(player, await newQuest(event), phone);
      await scan(twin.player, await newQuest(event), phone);
      await burst(event, player);
      const open = await run<{
        kind: string;
        accounts: number | null;
        scans: number | null;
        username: string;
      }>(team(editorA), "SELECT * FROM event_flags($1, true, NULL, 50)", [event]);
      expect(open.map((f) => [f.kind, f.accounts, f.scans])).toEqual([
        ["burst", null, 11],
        ["shared_device", 2, null],
        ["shared_device", 2, null],
      ]);
      expect(
        await run(team(editorA), "SELECT * FROM event_flags($1, false, NULL, 50)", [event]),
      ).toEqual([]);
      const [device] = await flagsOf(enrollment);
      const [detail] = await run<{ evidence: { username: string }[] }>(
        team(editorA),
        "SELECT * FROM flag_detail($1, $2)",
        [event, device?.id],
      );
      const names = await owner<{ username: string }>(
        "SELECT username FROM player WHERE id = ANY ($1::uuid[]) ORDER BY username",
        [[player, twin.player]],
      );
      expect(detail?.evidence.map((a) => a.username).toSorted()).toEqual(
        names.map((n) => n.username),
      );
      expect(JSON.stringify(detail)).not.toContain(phone);
      expect(
        await run(team(ownerB, ids.orgB), "SELECT * FROM flag_detail($1, $2)", [
          event,
          device?.id,
        ]).catch((error: { code: string }) => error.code),
      ).toBe("AN404");
    });

    it("shows the open case and the pause on the players list", async () => {
      const event = await newEvent();
      const { player, enrollment } = await newPlayer(event, 0);
      await burst(event, player);
      await run(team(ownerA), "SELECT set_redeem_pause($1, $2, true, $3)", [
        event,
        enrollment,
        randomUUID(),
      ]);
      const [row] = await run<{ open_flag: string | null; redeem_paused: boolean }>(
        team(editorA),
        "SELECT * FROM event_players($1, NULL, 10, NULL)",
        [event],
      );
      expect(row?.open_flag).toBe((await flagsOf(enrollment))[0]?.id);
      expect(row?.redeem_paused).toBe(true);
    });
  });

  describe("the desk's find (FR-1848)", () => {
    it("finds a member by folded username or phone, never a removed one, and never yourself", async () => {
      const event = await newEvent();
      const desk = await newOperator(event);
      const { player, enrollment } = await newPlayer(event, 0);
      const [named] = await owner<{ username: string }>(
        "SELECT username FROM player WHERE id = $1",
        [player],
      );
      await owner(
        "INSERT INTO player_contact (player_id, phone_e164) VALUES ($1, '+966512345678')",
        [player],
      );
      expect(
        (await find(desk, event, named?.username.toUpperCase() ?? "", null))[0]?.username,
      ).toBe(named?.username);
      expect((await find(desk, event, null, "+966512345678"))[0]?.username).toBe(named?.username);
      expect(await find(desk, event, "nobody_here", null)).toEqual([]);
      await owner("UPDATE enrollment SET status = 'removed' WHERE id = $1", [enrollment]);
      expect(await find(desk, event, named?.username ?? "", null)).toEqual([]);
      await owner("UPDATE staff_assignment SET can_play = true WHERE player_id = $1", [desk]);
      await owner(
        "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)",
        [ids.orgA, event, desk],
      );
      const [me] = await owner<{ username: string }>("SELECT username FROM player WHERE id = $1", [
        desk,
      ]);
      expect(await refusal(find(desk, event, me?.username ?? "", null))).toEqual({ code: "OY409" });
    });

    it("needs the hand-over ability and exactly one of username and phone", async () => {
      const event = await newEvent();
      const awarder = await newOperator(event, ["award"]);
      const desk = await newOperator(event);
      expect(await refusal(find(awarder, event, "x", null))).toEqual({ code: "OA403" });
      expect(await refusal(find(desk, await newEvent(), "x", null))).toEqual({ code: "OP403" });
      expect(await refusal(find(desk, event, null, null))).toEqual({ code: "22023" });
      expect(await refusal(find(desk, event, "x", "+966512345678"))).toEqual({ code: "22023" });
    });
  });

  describe("races", () => {
    it("a burst committing first holds the handover that waited for it", async () => {
      const state = await atDesk();
      await burst(state.event, state.player, 9);
      const settled = await race(
        [
          { playerId: state.player },
          "SELECT * FROM complete_quest($1, 'qr', 1, NULL, $2, NULL)",
          [await newQuest(state.event), randomUUID()],
        ],
        [{ playerId: state.desk }, "SELECT * FROM desk_hand_over($1)", [state.id]],
      );
      expect(settled[0]?.status).toBe("fulfilled");
      expect(settled[1]).toMatchObject({ status: "rejected", reason: { code: "RH409" } });
      expect(await statusOf(state.id)).toBe("reserved");
    });

    it("a clear committing first lets the waiting handover through", async () => {
      const state = await atDesk();
      await burst(state.event, state.player);
      const [open] = await flagsOf(state.enrollment);
      const settled = await race(
        [
          team(ownerA),
          "SELECT * FROM resolve_flag($1, $2, 'cleared', NULL, $3)",
          [state.event, open?.id, randomUUID()],
        ],
        [{ playerId: state.desk }, "SELECT * FROM desk_hand_over($1)", [state.id]],
      );
      expect(settled.map((s) => s.status)).toEqual(["fulfilled", "fulfilled"]);
      expect(await statusOf(state.id)).toBe("handed_over");
    });

    it("a pause committing first refuses the reservation that waited for it", async () => {
      const event = await newEvent();
      const { player, enrollment } = await newPlayer(event);
      const reward = await newReward(event);
      const settled = await race(
        [
          team(ownerA),
          "SELECT set_redeem_pause($1, $2, true, $3)",
          [event, enrollment, randomUUID()],
        ],
        [{ playerId: player }, "SELECT * FROM reserve_reward($1, $2)", [reward, randomUUID()]],
      );
      expect(settled[1]).toMatchObject({ status: "rejected", reason: { code: "RP403" } });
    });
  });

  describe("deny by default", () => {
    it("keeps the flag table and the internal bodies away from the API role", async () => {
      const event = await newEvent();
      const { player } = await newPlayer(event, 0);
      expect(await refusal(call(player, "SELECT * FROM flag"))).toEqual({ code: "42501" });
      expect(await refusal(run(team(ownerA), "SELECT * FROM flag"))).toEqual({ code: "42501" });
      for (const sql of [
        "SELECT flag_tuning()",
        "SELECT desk_hold(NULL::enrollment, NULL::event)",
        "SELECT * FROM desk_items(NULL::enrollment, NULL)",
      ]) {
        expect(await refusal(call(player, sql))).toEqual({ code: "42501" });
      }
      expect(
        await refusal(
          run(team(ownerA), "UPDATE enrollment SET redeem_paused_at = now() WHERE event_id = $1", [
            event,
          ]),
        ),
      ).toEqual({ code: "42501" });
      expect(
        await refusal(
          run(team(ownerA), "UPDATE event SET flag_hold = false WHERE id = $1", [event]),
        ),
      ).toEqual({
        code: "42501",
      });
    });
  });
});
