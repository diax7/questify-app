import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext } from "#src/db/context";
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

/**
 * The prize desk in the database (T-206, migration 0029): both ways a player confirms, the one handover body and its
 * gates, the operator's cancel, desk hours, the FR-1716 guard, deadlines and the races between every two paths.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("prize desk (database)", () => {
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

  const newEvent = async (
    fields: { mode?: string; hours?: string | null; organizer?: string } = {},
  ): Promise<string> => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at, desk_location_en,
                          desk_hours, handover_confirm)
       VALUES ($1, $2, 'Desk Fest', 'live', now() - interval '1 hour', now() + interval '2 days', 'Hall B',
               $3::tstzmultirange, $4)
       RETURNING id`,
      [
        fields.organizer ?? ids.orgA,
        `DESK${counter}`,
        fields.hours ?? null,
        fields.mode ?? "collect_first",
      ],
    );
    return event?.id ?? "";
  };

  const fund = async (event: string, enrollment: string, points: number): Promise<void> => {
    const [category] = await owner<{ id: string }>(
      "INSERT INTO category (event_id, name_en) VALUES ($1, 'General') RETURNING id",
      [event],
    );
    const [quest] = await owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points) VALUES ($1, $2, 'scan_qr', 'Q', $3)
       RETURNING id`,
      [event, category?.id, points],
    );
    const [org] = await owner<{ organizer_id: string }>(
      "SELECT organizer_id FROM event WHERE id = $1",
      [event],
    );
    const [done] = await owner<{ id: string }>(
      `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                     idempotency_key)
       VALUES ($1, $2, $3, $4, 1, 'qr', $5) RETURNING id`,
      [org?.organizer_id, event, enrollment, quest?.id, randomUUID()],
    );
    await owner(
      `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                 completion_id, quest_id, actor)
       VALUES ($1, $2, $3, 'quest', $4, $4, $5, $6, 'player')`,
      [org?.organizer_id, event, enrollment, points, done?.id, quest?.id],
    );
  };

  const newPlayer = async (event: string, points = 1000) => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`desk_player_${counter}`],
    );
    const [org] = await owner<{ organizer_id: string }>(
      "SELECT organizer_id FROM event WHERE id = $1",
      [event],
    );
    const [enrolled] = await owner<{ id: string }>(
      "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3) RETURNING id",
      [org?.organizer_id, event, player?.id],
    );
    if (points > 0) {
      await fund(event, enrolled?.id ?? "", points);
    }
    return { player: player?.id ?? "", enrollment: enrolled?.id ?? "" };
  };

  const newOperator = async (event: string, abilities = ["hand_over"]): Promise<string> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`desk_op_${counter}`],
    );
    const [org] = await owner<{ organizer_id: string }>(
      "SELECT organizer_id FROM event WHERE id = $1",
      [event],
    );
    await owner(
      "INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities) VALUES ($1, $2, $3, $4)",
      [org?.organizer_id, event, player?.id, abilities],
    );
    return player?.id ?? "";
  };

  const newReward = async (
    event: string,
    kind = "item",
    price = 200,
    stock = 5,
  ): Promise<string> => {
    const [row] = await owner<{ id: string }>(
      `INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, $2, 'Hoodie', $3, $4)
       RETURNING id`,
      [event, kind, price, stock],
    );
    return row?.id ?? "";
  };

  const as = async <T>(player: string, work: (client: PoolClient) => Promise<T>) => {
    const client = await pool.connect();
    try {
      return await withRequestContext(client, { playerId: player }, () => work(client));
    } finally {
      client.release();
    }
  };
  const call = <T extends Row>(player: string, sql: string, values: unknown[] = []) =>
    as(player, async (client) => (await client.query<T>(sql, values)).rows);

  const reserve = async (player: string, reward: string): Promise<string> => {
    const [row] = await call<{ redemption_id: string }>(
      player,
      "SELECT * FROM reserve_reward($1, $2)",
      [reward, randomUUID()],
    );
    return row?.redemption_id ?? "";
  };
  const collect = (player: string, redemption: string) =>
    call(player, "SELECT start_collect($1) AS until", [redemption]);
  const handOver = async (operator: string, redemption: string) =>
    (
      await call<{ status: string; offer_until: Date | null; replayed: boolean }>(
        operator,
        "SELECT * FROM desk_hand_over($1)",
        [redemption],
      )
    )[0];
  const accept = async (player: string, redemption: string) =>
    (
      await call<{ status: string; replayed: boolean }>(
        player,
        "SELECT * FROM accept_handover($1)",
        [redemption],
      )
    )[0];
  const opCancel = async (operator: string, redemption: string) =>
    (
      await call<{ status: string; replayed: boolean }>(
        operator,
        "SELECT * FROM operator_cancel_redemption($1)",
        [redemption],
      )
    )[0];
  const redemption = async (id: string) =>
    (
      await owner<{
        status: string;
        ended_by: string | null;
        operator_id: string | null;
        collect_until: Date | null;
        offer_by: string | null;
      }>(
        "SELECT status, ended_by, operator_id, collect_until, offer_by FROM redemption WHERE id = $1",
        [id],
      )
    )[0];
  const entries = (id: string) =>
    owner<{
      kind: string;
      actor: string;
      operator_id: string | null;
      score_delta: string;
      balance_delta: string;
    }>(
      `SELECT kind, actor, operator_id, score_delta, balance_delta FROM ledger_entry WHERE redemption_id = $1
       ORDER BY id`,
      [id],
    );
  const sums = async (enrollment: string) =>
    (
      await owner<{ score: string; balance: string }>(
        "SELECT score, balance FROM enrollment WHERE id = $1",
        [enrollment],
      )
    )[0];
  const unitsOut = async (reward: string) =>
    (await owner<{ units_out: number }>("SELECT units_out FROM reward WHERE id = $1", [reward]))[0]
      ?.units_out;
  const myQr = async (player: string) =>
    (
      await owner<{ my_qr_version: number }>("SELECT my_qr_version FROM player WHERE id = $1", [
        player,
      ])
    )[0]?.my_qr_version;
  const pastDeadline = (id: string) =>
    owner("UPDATE redemption SET reserved_until = now() - interval '1 minute' WHERE id = $1", [id]);

  const asTeam = (sql: string, values: unknown[]) =>
    withRequestContext(db.app, { organizerId: ids.orgA, staffUserId: ownerA }, () =>
      db.app.query(sql, values),
    );

  /** Runs `first` holding its transaction open while `second` starts, then commits; both settle. */
  const race = async (
    first: [string, string, unknown[]],
    second: [string, string, unknown[]],
  ): Promise<PromiseSettledResult<unknown>[]> => {
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query("BEGIN");
      await a.query("SELECT set_config('app.player_id', $1, true)", [first[0]]);
      const firstWork = a.query(first[1], first[2]);
      await firstWork;
      await b.query("BEGIN");
      await b.query("SELECT set_config('app.player_id', $1, true)", [second[0]]);
      // Settled at once: the second call may be refused before anything awaits it.
      const secondWork = Promise.allSettled([b.query(second[1], second[2])]);
      await new Promise((resolve) => setTimeout(resolve, 150));
      await a.query("COMMIT");
      const settled = [...(await Promise.allSettled([firstWork])), ...(await secondWork)];
      await b.query(settled[1]?.status === "fulfilled" ? "COMMIT" : "ROLLBACK");
      return settled;
    } finally {
      a.release();
      b.release();
    }
  };

  const setup = async (mode = "collect_first") => {
    const event = await newEvent({ mode });
    const desk = await newOperator(event);
    const { player, enrollment } = await newPlayer(event);
    const reward = await newReward(event);
    const id = await reserve(player, reward);
    return { event, desk, player, enrollment, reward, id };
  };

  const consistent = async (state: Awaited<ReturnType<typeof setup>>, expected: string) => {
    const row = await redemption(state.id);
    expect(row?.status).toBe(expected);
    const kinds = (await entries(state.id)).map((entry) => entry.kind);
    expect(kinds).toEqual(
      expected === "handed_over" ? ["redeem", "handover"] : ["redeem", "redeem_return"],
    );
    expect(await unitsOut(state.reward)).toBe(expected === "handed_over" ? 1 : 0);
  };

  describe("collect first (the default)", () => {
    it("hands over a collected item once, writes one handover entry and keeps the unit out", async () => {
      const event = await newEvent();
      const desk = await newOperator(event);
      const { player, enrollment } = await newPlayer(event);
      const reward = await newReward(event);
      const id = await reserve(player, reward);
      const before = await sums(enrollment);

      expect(await refusal(handOver(desk, id))).toEqual({ code: "RC409" });
      await collect(player, id);
      expect(await handOver(desk, id)).toMatchObject({ status: "handed_over", replayed: false });
      expect(await handOver(desk, id)).toMatchObject({ status: "handed_over", replayed: true });

      expect(await redemption(id)).toMatchObject({
        status: "handed_over",
        ended_by: "handover",
        operator_id: desk,
        collect_until: null,
      });
      expect(
        (await entries(id)).map((entry) => [entry.kind, entry.actor, entry.operator_id]),
      ).toEqual([
        ["redeem", "player", null],
        ["handover", "operator", desk],
      ]);
      expect(await sums(enrollment)).toEqual(before);
      expect(await unitsOut(reward)).toBe(1);
      expect(await refusal(call(player, "SELECT * FROM cancel_redemption($1)", [id]))).toEqual({
        code: "RE409",
        detail: "handed_over",
      });
    });

    it("confirms an experience the same way (FR-509)", async () => {
      const event = await newEvent();
      const desk = await newOperator(event);
      const { player } = await newPlayer(event);
      const id = await reserve(player, await newReward(event, "experience"));
      await collect(player, id);
      expect(await handOver(desk, id)).toMatchObject({ status: "handed_over" });
    });

    it("lets another desk see the result but not replay it", async () => {
      const event = await newEvent();
      const deskOne = await newOperator(event);
      const deskTwo = await newOperator(event);
      const { player } = await newPlayer(event);
      const id = await reserve(player, await newReward(event));
      await collect(player, id);
      await handOver(deskOne, id);
      expect(await refusal(handOver(deskTwo, id))).toEqual({
        code: "RE409",
        detail: "handed_over",
      });
    });

    it("counts handed-over rewards against the per-player limit", async () => {
      const event = await newEvent();
      const desk = await newOperator(event);
      const { player } = await newPlayer(event);
      const reward = await newReward(event);
      await owner("UPDATE reward SET per_player_limit = 1 WHERE id = $1", [reward]);
      const id = await reserve(player, reward);
      await collect(player, id);
      await handOver(desk, id);
      expect(await refusal(reserve(player, reward))).toEqual({ code: "RL409", detail: "1" });
      const [shop] = await call<{ held_by_me: number }>(
        player,
        "SELECT held_by_me FROM shop_rewards($1)",
        [event],
      );
      expect(shop?.held_by_me).toBe(1);
    });

    it("refuses Collect in a desk-offer event and an accept in a collect-first one", async () => {
      const offerEvent = await newEvent({ mode: "desk_offer" });
      const first = await newPlayer(offerEvent);
      const offered = await reserve(first.player, await newReward(offerEvent));
      expect(await refusal(collect(first.player, offered))).toEqual({ code: "RM409" });

      const collectEvent = await newEvent();
      const second = await newPlayer(collectEvent);
      const held = await reserve(second.player, await newReward(collectEvent));
      expect(await refusal(accept(second.player, held))).toEqual({ code: "RM409" });
    });

    it("refuses a switched mode while a Collect is live, clearing nothing", async () => {
      const event = await newEvent();
      const desk = await newOperator(event);
      const { player } = await newPlayer(event);
      const id = await reserve(player, await newReward(event));
      await collect(player, id);
      await owner("UPDATE event SET handover_confirm = 'desk_offer' WHERE id = $1", [event]);
      expect(await handOver(desk, id)).toMatchObject({ status: "offered" });
      expect((await redemption(id))?.collect_until).not.toBeNull();
      await owner("UPDATE event SET handover_confirm = 'collect_first' WHERE id = $1", [event]);
      expect(await refusal(accept(player, id))).toEqual({ code: "RM409" });
    });

    it("refuses Collect on someone else's, an ended or an overdue reservation", async () => {
      const event = await newEvent();
      const { player } = await newPlayer(event);
      const stranger = await newPlayer(event);
      const reward = await newReward(event);
      const id = await reserve(player, reward);
      expect(await refusal(collect(stranger.player, id))).toEqual({ code: "RN404" });
      await pastDeadline(id);
      expect(await refusal(collect(player, id))).toEqual({ code: "RE409", detail: "expired" });
      const other = await reserve(player, reward);
      await call(player, "SELECT * FROM cancel_redemption($1)", [other]);
      expect(await refusal(collect(player, other))).toEqual({ code: "RE409", detail: "cancelled" });
    });

    it("answers a second Collect past the deadline without renewing it", async () => {
      const event = await newEvent();
      const { player } = await newPlayer(event);
      const id = await reserve(player, await newReward(event));
      await collect(player, id);
      await pastDeadline(id);
      await owner(
        "UPDATE redemption SET collect_until = now() + interval '1 minute' WHERE id = $1",
        [id],
      );
      const before = (await redemption(id))?.collect_until;
      const [again] = await collect(player, id);
      expect((again?.["until"] as Date | undefined)?.getTime()).toBe(before?.getTime());
      expect((await redemption(id))?.collect_until?.getTime()).toBe(before?.getTime());
    });

    it("lets another desk take over a live offer past the deadline, never extending it", async () => {
      const event = await newEvent({ mode: "desk_offer" });
      const deskOne = await newOperator(event);
      const deskTwo = await newOperator(event);
      const { player } = await newPlayer(event);
      const id = await reserve(player, await newReward(event));
      await handOver(deskOne, id);
      await pastDeadline(id);
      await owner(
        "UPDATE redemption SET offer_until = now() + interval '30 seconds' WHERE id = $1",
        [id],
      );
      const [row] = await owner<{ offer_until: Date }>(
        "SELECT offer_until FROM redemption WHERE id = $1",
        [id],
      );
      const taken = await handOver(deskTwo, id);
      expect(taken?.offer_until?.getTime()).toBe(row?.offer_until.getTime());
      expect((await redemption(id))?.offer_by).toBe(deskTwo);
    });

    it("lets a live Collect finish past the deadline", async () => {
      const event = await newEvent();
      const desk = await newOperator(event);
      const { player } = await newPlayer(event);
      const id = await reserve(player, await newReward(event));
      await collect(player, id);
      await pastDeadline(id);
      expect(await handOver(desk, id)).toMatchObject({ status: "handed_over" });
    });
  });

  describe("desk offer", () => {
    it("offers for 2 minutes and hands over when the player accepts", async () => {
      const event = await newEvent({ mode: "desk_offer" });
      const desk = await newOperator(event);
      const { player } = await newPlayer(event);
      const id = await reserve(player, await newReward(event));

      expect(await refusal(accept(player, id))).toEqual({ code: "RO410" });
      const offer = await handOver(desk, id);
      expect(offer?.status).toBe("offered");
      const seconds = ((offer?.offer_until?.getTime() ?? 0) - Date.now()) / 1000;
      expect(seconds).toBeGreaterThan(100);
      expect(seconds).toBeLessThanOrEqual(120);

      const [poll] = await call<{ status: string; offered: boolean }>(
        desk,
        "SELECT * FROM desk_redemption($1)",
        [id],
      );
      expect(poll).toMatchObject({ status: "reserved", offered: true });
      const [item] = await call<{ state: string }>(player, "SELECT * FROM my_desk_items()");
      expect(item?.state).toBe("offered");
      await owner("UPDATE enrollment SET status = 'banned' WHERE player_id = $1", [player]);
      expect(await call(player, "SELECT * FROM my_desk_items()")).toEqual([]);
      await owner("UPDATE enrollment SET status = 'active' WHERE player_id = $1", [player]);
      const [watch] = await call<{ my_desk_watch: boolean }>(player, "SELECT my_desk_watch()");
      expect(watch?.my_desk_watch).toBe(true);

      expect(await accept(player, id)).toEqual({ status: "handed_over", replayed: false });
      expect(await accept(player, id)).toEqual({ status: "handed_over", replayed: true });
      expect(await redemption(id)).toMatchObject({
        status: "handed_over",
        operator_id: desk,
        offer_by: null,
      });
      expect((await entries(id)).map((entry) => entry.kind)).toEqual(["redeem", "handover"]);
    });

    it("lets the player decline, and an expired offer cannot be accepted", async () => {
      const event = await newEvent({ mode: "desk_offer" });
      const desk = await newOperator(event);
      const { player } = await newPlayer(event);
      const id = await reserve(player, await newReward(event));
      await handOver(desk, id);
      const [declined] = await call<{ decline_handover: boolean }>(
        player,
        "SELECT decline_handover($1)",
        [id],
      );
      expect(declined?.decline_handover).toBe(true);
      expect((await redemption(id))?.offer_by).toBeNull();

      await handOver(desk, id);
      await owner("UPDATE redemption SET offer_until = now() - interval '1 second' WHERE id = $1", [
        id,
      ]);
      expect(await refusal(accept(player, id))).toEqual({ code: "RO410" });
    });

    it("shows a desk only its own offer when another desk replaced it", async () => {
      const event = await newEvent({ mode: "desk_offer" });
      const deskOne = await newOperator(event);
      const deskTwo = await newOperator(event);
      const { player } = await newPlayer(event);
      const id = await reserve(player, await newReward(event));
      await handOver(deskOne, id);
      await handOver(deskTwo, id);
      const [poll] = await call<{ offered: boolean }>(
        deskOne,
        "SELECT * FROM desk_redemption($1)",
        [id],
      );
      expect(poll?.offered).toBe(false);
      await accept(player, id);
      expect((await redemption(id))?.operator_id).toBe(deskTwo);
    });

    it("refuses an accept once the offering operator was removed (FR-905)", async () => {
      const event = await newEvent({ mode: "desk_offer" });
      const desk = await newOperator(event);
      const { player } = await newPlayer(event);
      const id = await reserve(player, await newReward(event));
      await handOver(desk, id);
      await owner("DELETE FROM staff_assignment WHERE player_id = $1", [desk]);
      expect(await refusal(accept(player, id))).toEqual({ code: "OP403" });
    });

    it("refuses an accept after a ban or once the desk closed", async () => {
      const event = await newEvent({ mode: "desk_offer" });
      const desk = await newOperator(event);
      const first = await newPlayer(event);
      const second = await newPlayer(event);
      const reward = await newReward(event);
      const banned = await reserve(first.player, reward);
      const closing = await reserve(second.player, reward);
      await handOver(desk, banned);
      await handOver(desk, closing);
      await owner("UPDATE enrollment SET status = 'banned' WHERE id = $1", [first.enrollment]);
      expect(await refusal(accept(first.player, banned))).toEqual({
        code: "RH409",
        detail: "held",
      });
      await owner(
        `UPDATE event SET desk_hours = tstzmultirange(tstzrange(now() + interval '1 hour', now() + interval '2 hours'))
         WHERE id = $1`,
        [event],
      );
      expect(await refusal(accept(second.player, closing))).toEqual({
        code: "RS403",
        detail: "desk_closed",
      });
    });

    it("does not watch for offers in collect-first events", async () => {
      const event = await newEvent();
      const { player } = await newPlayer(event);
      await reserve(player, await newReward(event));
      const [watch] = await call<{ my_desk_watch: boolean }>(player, "SELECT my_desk_watch()");
      expect(watch?.my_desk_watch).toBe(false);
    });
  });

  describe("the operator's gates", () => {
    it("refuses a non-operator, an operator without hand_over and an operator of another event", async () => {
      const event = await newEvent();
      const other = await newEvent();
      const scanner = await newOperator(event, ["scan_quests"]);
      const elsewhere = await newOperator(other);
      const { player } = await newPlayer(event);
      const stranger = await newPlayer(event);
      const id = await reserve(player, await newReward(event));
      await collect(player, id);
      expect(await refusal(handOver(stranger.player, id))).toEqual({ code: "OP403" });
      expect(await refusal(handOver(scanner, id))).toEqual({ code: "OA403" });
      expect(await refusal(handOver(elsewhere, id))).toEqual({ code: "OP403" });
      expect(await refusal(opCancel(elsewhere, id))).toEqual({ code: "OP403" });
      expect(await refusal(call(elsewhere, "SELECT * FROM desk_redemption($1)", [id]))).toEqual({
        code: "OP403",
      });
      expect(
        await refusal(
          call(elsewhere, "SELECT * FROM desk_lookup($1, $2, $3)", [
            event,
            player,
            await myQr(player),
          ]),
        ),
      ).toEqual({ code: "OP403" });
    });

    it("refuses an operator handing over or cancelling their own reservation", async () => {
      const event = await newEvent();
      const desk = await newOperator(event);
      await owner("UPDATE staff_assignment SET can_play = true WHERE player_id = $1", [desk]);
      const [org] = await owner<{ id: string }>(
        "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3) RETURNING id",
        [ids.orgA, event, desk],
      );
      await fund(event, org?.id ?? "", 500);
      const id = await reserve(desk, await newReward(event));
      await collect(desk, id);
      expect(await refusal(handOver(desk, id))).toEqual({ code: "OY409" });
      expect(await refusal(opCancel(desk, id))).toEqual({ code: "OY409" });
    });

    it("holds a banned player's handover like a flagged one (FR-1747)", async () => {
      const event = await newEvent();
      const desk = await newOperator(event);
      const { player, enrollment } = await newPlayer(event);
      const id = await reserve(player, await newReward(event));
      await collect(player, id);
      await owner("UPDATE enrollment SET status = 'banned' WHERE id = $1", [enrollment]);
      expect(await refusal(handOver(desk, id))).toEqual({ code: "RH409", detail: "held" });
    });
  });

  describe("lookup (FR-925, FR-926)", () => {
    it("lists the player's reserved desk items, never digital ones, and pays nothing", async () => {
      const event = await newEvent();
      const desk = await newOperator(event);
      const { player, enrollment } = await newPlayer(event);
      const hoodie = await reserve(player, await newReward(event));
      const lounge = await reserve(player, await newReward(event, "experience"));
      await collect(player, hoodie);
      const before = await sums(enrollment);
      const completions = await owner("SELECT id FROM quest_completion WHERE enrollment_id = $1", [
        enrollment,
      ]);

      const rows = await call<{
        redemption_id: string;
        kind: string;
        ready: boolean;
        username: string;
      }>(desk, "SELECT * FROM desk_lookup($1, $2, $3)", [event, player, await myQr(player)]);
      expect(rows.map((row) => [row.redemption_id, row.kind, row.ready])).toEqual([
        [hoodie, "item", true],
        [lounge, "experience", false],
      ]);
      expect(await sums(enrollment)).toEqual(before);
      expect(
        await owner("SELECT id FROM quest_completion WHERE enrollment_id = $1", [enrollment]),
      ).toEqual(completions);
    });

    it("answers one empty row when nothing waits", async () => {
      const event = await newEvent();
      const desk = await newOperator(event);
      const { player } = await newPlayer(event);
      const rows = await call<{
        redemption_id: string | null;
        active: boolean;
        hold: string | null;
      }>(desk, "SELECT * FROM desk_lookup($1, $2, $3)", [event, player, await myQr(player)]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ redemption_id: null, active: true, hold: null });
    });

    it("refuses an old My QR, the operator's own code and a player of another event", async () => {
      const event = await newEvent();
      const desk = await newOperator(event);
      const { player } = await newPlayer(event);
      const outsider = await newPlayer(await newEvent());
      const version = await myQr(player);
      const lookup = (who: string, at: number | undefined) =>
        call(desk, "SELECT * FROM desk_lookup($1, $2, $3)", [event, who, at]);
      expect(await refusal(lookup(player, (version ?? 1) + 1))).toEqual({ code: "OM422" });
      expect(await refusal(lookup(desk, await myQr(desk)))).toEqual({ code: "OY409" });
      expect(await refusal(lookup(outsider.player, await myQr(outsider.player)))).toEqual({
        code: "QC404",
      });
      expect(await refusal(lookup(randomUUID(), 1))).toEqual({ code: "QC404" });
    });
  });

  describe("the operator's cancel (FR-513, FR-1603)", () => {
    it("returns the points and the unit as the operator, once, even while the desk is closed", async () => {
      const event = await newEvent({
        hours:
          "{[2000-01-01 10:00+00, 2000-01-01 12:00+00), [2999-01-01 10:00+00, 2999-01-01 12:00+00)}",
      });
      const desk = await newOperator(event);
      const { player, enrollment } = await newPlayer(event);
      const reward = await newReward(event);
      const before = await sums(enrollment);
      const id = await reserve(player, reward);
      expect(await opCancel(desk, id)).toMatchObject({ status: "cancelled", replayed: false });
      expect(await opCancel(desk, id)).toMatchObject({ status: "cancelled", replayed: true });
      expect(await sums(enrollment)).toEqual(before);
      expect(await unitsOut(reward)).toBe(0);
      expect(await redemption(id)).toMatchObject({ ended_by: "operator", operator_id: desk });
      expect(
        (await entries(id)).map((entry) => [entry.kind, entry.actor, entry.operator_id]),
      ).toEqual([
        ["redeem", "player", null],
        ["redeem_return", "operator", desk],
      ]);
    });

    it("refuses to cancel a handed-over reward", async () => {
      const event = await newEvent();
      const desk = await newOperator(event);
      const { player } = await newPlayer(event);
      const id = await reserve(player, await newReward(event));
      await collect(player, id);
      await handOver(desk, id);
      expect(await refusal(opCancel(desk, id))).toEqual({ code: "RE409", detail: "handed_over" });
    });
  });

  describe("desk hours (ADR-150, FR-1717)", () => {
    it("reads open with no hours, closed between windows and finished after the last", async () => {
      const [states] = await owner<{
        none: string;
        inside: string;
        between: string;
        finished: string;
      }>(
        `SELECT desk_state(NULL) AS none,
                desk_state(tstzmultirange(tstzrange(now() - interval '1 hour', now() + interval '1 hour'))) AS inside,
                desk_state(tstzmultirange(tstzrange(now() - interval '2 hours', now() - interval '1 hour'),
                                          tstzrange(now() + interval '1 hour', now() + interval '2 hours'))) AS between,
                desk_state(tstzmultirange(tstzrange(now() - interval '2 hours', now()))) AS finished`,
      );
      expect(states).toEqual({
        none: "open",
        inside: "open",
        between: "closed",
        finished: "finished",
      });
    });

    it("refuses invalid hours: empty, unbounded or more than 14 windows", async () => {
      const event = await newEvent();
      const set = (hours: string) =>
        owner("UPDATE event SET desk_hours = $2::tstzmultirange WHERE id = $1", [event, hours]);
      expect(await refusal(set("{}"))).toMatchObject({ code: "23514" });
      expect(await refusal(set("{[2030-01-01 10:00+00,)}"))).toMatchObject({ code: "23514" });
      const windows = Array.from({ length: 15 }, (_, day) => {
        const date = `2030-01-${String(day + 1).padStart(2, "0")}`;
        return `[${date} 10:00+00, ${date} 12:00+00)`;
      });
      expect(await refusal(set(`{${windows.join(",")}}`))).toMatchObject({ code: "23514" });
      await set(`{${windows.slice(0, 14).join(",")}}`);
    });

    it("stops items and experiences after the last window, not digital codes", async () => {
      const event = await newEvent({ hours: "{[2000-01-01 10:00+00, 2000-01-01 12:00+00)}" });
      const { player } = await newPlayer(event);
      expect(await refusal(reserve(player, await newReward(event)))).toEqual({
        code: "RS403",
        detail: "desk_finished",
      });
      expect(await refusal(reserve(player, await newReward(event, "experience")))).toEqual({
        code: "RS403",
        detail: "desk_finished",
      });
      const digital = await newReward(event, "digital", 100, 0);
      await owner(
        `INSERT INTO reward_code (organizer_id, event_id, reward_id, code_cipher, code_hash)
         VALUES ($1, $2, $3, decode(repeat('ab', 32), 'hex'), decode(repeat('cd', 32), 'hex'))`,
        [ids.orgA, event, digital],
      );
      await owner("UPDATE reward SET stock_total = 1 WHERE id = $1", [digital]);
      expect(await reserve(player, digital)).not.toBe("");
    });

    it("starts the pickup time at the next opening while the desk is closed", async () => {
      const event = await newEvent({
        hours:
          "{[2000-01-01 10:00+00, 2000-01-01 12:00+00), [2999-01-01 10:00+00, 2999-01-01 12:00+00)}",
      });
      const { player } = await newPlayer(event);
      const id = await reserve(player, await newReward(event));
      const [row] = await owner<{ until: Date }>(
        "SELECT reserved_until AS until FROM redemption WHERE id = $1",
        [id],
      );
      expect(row?.until.toISOString()).toBe("2999-01-01T12:00:00.000Z");
    });

    it("refuses Collect and handover while the desk is closed", async () => {
      const event = await newEvent();
      const desk = await newOperator(event);
      const { player } = await newPlayer(event);
      const id = await reserve(player, await newReward(event));
      await collect(player, id);
      await owner(
        `UPDATE event SET desk_hours = tstzmultirange(tstzrange(now() + interval '1 hour', now() + interval '2 hours'))
         WHERE id = $1`,
        [event],
      );
      expect(await refusal(handOver(desk, id))).toEqual({ code: "RS403", detail: "desk_closed" });
      expect(await refusal(collect(player, id))).toEqual({ code: "RS403", detail: "desk_closed" });
    });

    it("bounds the pickup by the last window (FR-1609 with hours)", async () => {
      const event = await newEvent({
        hours: "{[2000-01-01 10:00+00, 2000-01-01 12:00+00)}",
      });
      await owner(
        `UPDATE event SET desk_hours = tstzmultirange(tstzrange(now() - interval '1 hour', now() + interval '5 minutes'))
         WHERE id = $1`,
        [event],
      );
      const desk = await newOperator(event);
      const { player } = await newPlayer(event);
      const id = await reserve(player, await newReward(event));
      await collect(player, id);
      await owner(
        `UPDATE event SET desk_hours = tstzmultirange(tstzrange(now() - interval '1 hour', now() - interval '1 second'))
         WHERE id = $1`,
        [event],
      );
      expect(await refusal(handOver(desk, id))).toEqual({ code: "RS403", detail: "desk_closed" });
    });
  });

  describe("the desk's place (FR-1716)", () => {
    it("refuses an item reward without a place, and clearing the place while one is active", async () => {
      const event = await newEvent();
      await owner("UPDATE event SET desk_location_en = NULL WHERE id = $1", [event]);
      expect(
        await refusal(
          asTeam(
            "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, 'item', 'H', 10, 1)",
            [event],
          ),
        ),
      ).toEqual({ code: "DL409" });
      await asTeam(
        "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, 'experience', 'Lounge', 10, 1)",
        [event],
      );
      await asTeam("UPDATE event SET desk_location_ar = 'القاعة ب' WHERE id = $1", [event]);
      await asTeam(
        "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, 'item', 'H', 10, 1)",
        [event],
      );
      expect(
        await refusal(asTeam("UPDATE event SET desk_location_ar = NULL WHERE id = $1", [event])),
      ).toEqual({
        code: "DL409",
      });
      await asTeam("UPDATE event SET pickup_minutes = 30 WHERE id = $1", [event]);
    });

    it("lets an older event without a desk save its other settings", async () => {
      const event = await newEvent();
      await owner("UPDATE event SET desk_location_en = NULL WHERE id = $1", [event]);
      await newReward(event);
      await asTeam("UPDATE event SET pickup_minutes = 45 WHERE id = $1", [event]);
    });
  });

  describe("deadlines and expiry", () => {
    it("skips a collected row until its Collect lapses, then expires it", async () => {
      const event = await newEvent();
      const { player, enrollment } = await newPlayer(event);
      const before = await sums(enrollment);
      const id = await reserve(player, await newReward(event));
      await collect(player, id);
      await pastDeadline(id);
      const drain = async (): Promise<void> => {
        while (
          (await owner<{ result: string | null }>("SELECT expire_one_reservation() AS result"))[0]
            ?.result
        ) {
          // Other tests' overdue rows go first: expiry always takes the oldest due row.
        }
      };
      await drain();
      expect((await redemption(id))?.status).toBe("reserved");
      await owner(
        "UPDATE redemption SET collect_until = now() - interval '1 second' WHERE id = $1",
        [id],
      );
      await drain();
      expect((await redemption(id))?.status).toBe("expired");
      expect(await sums(enrollment)).toEqual(before);
    });

    it("never ends a row whose deadline has not passed as expired", async () => {
      const event = await newEvent();
      const { player } = await newPlayer(event);
      const id = await reserve(player, await newReward(event));
      const [ended] = await owner<{ ended: boolean }>(
        "SELECT end_reservation($1, 'expired', 'timeout', 'system', NULL) AS ended",
        [id],
      );
      expect(ended?.ended).toBe(false);
    });

    it("needs a named operator for an operator's return", async () => {
      const event = await newEvent();
      const { player } = await newPlayer(event);
      const id = await reserve(player, await newReward(event));
      expect(
        await refusal(
          owner("SELECT end_reservation($1, 'cancelled', 'operator', 'operator', NULL)", [id]),
        ),
      ).toMatchObject({ code: "23514" });
    });
  });

  describe("races (exactly one wins)", () => {
    it("handover vs the player's cancel", async () => {
      const state = await setup();
      await collect(state.player, state.id);
      const settled = await race(
        [state.desk, "SELECT * FROM desk_hand_over($1)", [state.id]],
        [state.player, "SELECT * FROM cancel_redemption($1)", [state.id]],
      );
      expect(settled.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
      await consistent(state, "handed_over");
    });

    it("the player's cancel vs handover", async () => {
      const state = await setup();
      await collect(state.player, state.id);
      await race(
        [state.player, "SELECT * FROM cancel_redemption($1)", [state.id]],
        [state.desk, "SELECT * FROM desk_hand_over($1)", [state.id]],
      );
      await consistent(state, "cancelled");
    });

    it("two desks handing over the same row", async () => {
      const state = await setup();
      const other = await newOperator(state.event);
      await collect(state.player, state.id);
      const settled = await race(
        [state.desk, "SELECT * FROM desk_hand_over($1)", [state.id]],
        [other, "SELECT * FROM desk_hand_over($1)", [state.id]],
      );
      expect(settled.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
      await consistent(state, "handed_over");
    });

    it("handover vs expiry", async () => {
      const state = await setup();
      await collect(state.player, state.id);
      await pastDeadline(state.id);
      const a = await pool.connect();
      try {
        await a.query("BEGIN");
        await a.query("SELECT set_config('app.player_id', $1, true)", [state.desk]);
        await a.query("SELECT * FROM desk_hand_over($1)", [state.id]);
        const expiry = db.owner.query<{ ended: boolean }>(
          "SELECT end_reservation($1, 'expired', 'timeout', 'system', NULL) AS ended",
          [state.id],
        );
        await new Promise((resolve) => setTimeout(resolve, 150));
        await a.query("COMMIT");
        expect((await expiry).rows[0]?.ended).toBe(false);
      } finally {
        a.release();
      }
      await consistent(state, "handed_over");
    });

    it("Collect vs expiry: a Collect committed first wins", async () => {
      const state = await setup();
      await pastDeadline(state.id);
      await owner(
        "UPDATE redemption SET reserved_until = now() + interval '3 seconds' WHERE id = $1",
        [state.id],
      );
      await collect(state.player, state.id);
      await pastDeadline(state.id);
      const [ended] = await owner<{ ended: boolean }>(
        "SELECT end_reservation($1, 'expired', 'timeout', 'system', NULL) AS ended",
        [state.id],
      );
      expect(ended?.ended).toBe(false);
      expect((await redemption(state.id))?.status).toBe("reserved");
    });

    it("accept vs the operator's cancel", async () => {
      const state = await setup("desk_offer");
      await handOver(state.desk, state.id);
      const settled = await race(
        [state.desk, "SELECT * FROM operator_cancel_redemption($1)", [state.id]],
        [state.player, "SELECT * FROM accept_handover($1)", [state.id]],
      );
      expect(settled.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
      await consistent(state, "cancelled");
    });

    it("operator removed vs accept: the removal waits for the accept in flight, then refuses", async () => {
      const state = await setup("desk_offer");
      const other = await setup("desk_offer");
      await handOver(state.desk, state.id);
      const a = await pool.connect();
      try {
        await a.query("BEGIN");
        await a.query("SELECT set_config('app.player_id', $1, true)", [state.player]);
        await a.query("SELECT * FROM accept_handover($1)", [state.id]);
        const removal = db.owner.query("DELETE FROM staff_assignment WHERE player_id = $1", [
          state.desk,
        ]);
        await new Promise((resolve) => setTimeout(resolve, 150));
        await a.query("COMMIT");
        await removal;
      } finally {
        a.release();
      }
      await consistent(state, "handed_over");
      await handOver(other.desk, other.id);
      await owner("DELETE FROM staff_assignment WHERE player_id = $1", [other.desk]);
      expect(await refusal(accept(other.player, other.id))).toEqual({ code: "OP403" });
      expect((await redemption(other.id))?.status).toBe("reserved");
    });
  });

  describe("deny by default", () => {
    it("keeps the internal bodies away from the API role", async () => {
      const event = await newEvent();
      const { player } = await newPlayer(event);
      for (const sql of [
        "SELECT finish_handover($1, $2, false)",
        "SELECT desk_operator($1, $2)",
        "SELECT my_desk_redemption($1, $2)",
      ]) {
        expect(await refusal(call(player, sql, [randomUUID(), player]))).toEqual({ code: "42501" });
      }
      expect(
        await refusal(
          call(player, "SELECT end_reservation($1, 'cancelled', 'player', 'player', NULL)", [
            randomUUID(),
          ]),
        ),
      ).toEqual({ code: "42501" });
    });
  });
});
