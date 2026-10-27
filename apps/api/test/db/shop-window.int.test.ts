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
type Member = { player: string; enrollment: string; entry: string };

const as = (player: string): RequestContext => ({ playerId: player });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** The close is put 1 s ahead and the test sleeps this long: a 0.5 s margin, so 2-core CI never races. */
const PAST_THE_CLOSE_MS = 1500;

const refusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
    return "none";
  } catch (error) {
    const pg = error as { code?: string; detail?: string };
    return pg.detail === undefined || pg.detail === "" ? `${pg.code}` : `${pg.code}:${pg.detail}`;
  }
};

/**
 * The shop's window after the event in the database (T-410, migration 0074, ADR-336, ADR-337): the guard on the days
 * after the end (only longer after the end, frozen once closed, judged on clock_timestamp()), the close as a rule that
 * writes nothing (the shop refuses, holds made before it stay collectible, returns land in the closed balance, new
 * points move the score only), and FR-751: what the player keeps is untouched across the close.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("the shop window (database)", () => {
  let db: TestDatabase;
  let pool: Pool;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let ownerA = "";
  let ownerB = "";
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new Pool({ connectionString: db.appUrl, max: 8 });
    ids = await seedTwoTenants(db.owner);
    ownerA = await addMember(db.owner, ids.orgA, "owner");
    ownerB = await addMember(db.owner, ids.orgB, "owner");
  });
  afterAll(async () => {
    await pool.end();
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
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
  const team = (): RequestContext => ({ organizerId: ids.orgA, staffUserId: ownerA });
  const teamB = (): RequestContext => ({ organizerId: ids.orgB, staffUserId: ownerB });

  type Spec = { status?: string; starts?: string; ends?: string; days?: number; lowers?: boolean };
  /** An event of organizer A with a desk open the whole time; `ends` is from now ("-1 day" ended a day ago). */
  const newEvent = async (spec: Spec = {}): Promise<string> => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at, shop_days_after,
                          spend_lowers_rank, desk_location_en)
       VALUES ($1, $2, 'Window Fest', $3, now() + $4::interval, now() + $5::interval, $6, $7, 'Hall B')
       RETURNING id`,
      [
        ids.orgA,
        `WIN${counter}`,
        spec.status ?? "live",
        spec.starts ?? "-10 days",
        spec.ends ?? "1 day",
        spec.days ?? 3,
        spec.lowers ?? false,
      ],
    );
    await owner("INSERT INTO category (event_id, name_en) VALUES ($1, 'General')", [event?.id]);
    return event?.id ?? "";
  };
  const daysOf = async (event: string) =>
    (await owner<{ d: number }>("SELECT shop_days_after AS d FROM event WHERE id = $1", [event]))[0]
      ?.d;
  const stateOf = async (event: string) =>
    (
      await owner<{ s: string }>(
        "SELECT shop_state(status, starts_at, ends_at, shop_days_after) AS s FROM event WHERE id = $1",
        [event],
      )
    )[0]?.s;
  /** Puts the close 1 s ahead of clock_timestamp(), keeping the days (the owner connection, past every guard). */
  const closeInASecond = async (event: string): Promise<Date> =>
    (
      await owner<{ closes: Date }>(
        `UPDATE event SET ends_at = clock_timestamp() + interval '1 second' - make_interval(days => shop_days_after)
         WHERE id = $1 RETURNING ends_at + make_interval(days => shop_days_after) AS closes`,
        [event],
      )
    )[0]?.closes as Date;
  /** Moves the event's end back so its window closed a minute ago. */
  const closeNow = async (event: string): Promise<Date> =>
    (
      await owner<{ closes: Date }>(
        `UPDATE event SET ends_at = now() - interval '1 minute' - make_interval(days => shop_days_after)
         WHERE id = $1 RETURNING ends_at + make_interval(days => shop_days_after) AS closes`,
        [event],
      )
    )[0]?.closes as Date;
  const setDays = (event: string, days: number, context = team()) =>
    run<{ shop_days_after: number }>(
      context,
      "UPDATE event SET shop_days_after = $2 WHERE id = $1 RETURNING shop_days_after",
      [event, days],
    );

  /** Pays `points` the way a quest does (a completion and its entry); returns the entry. */
  const fund = async (event: string, enrollment: string, points: number): Promise<string> => {
    const [quest] = await owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap)
       SELECT $1, id, 'scan_qr', 'Q', $2, 100 FROM category WHERE event_id = $1 LIMIT 1 RETURNING id`,
      [event, points],
    );
    const [done] = await owner<{ id: string }>(
      `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                     idempotency_key)
       VALUES ($1, $2, $3, $4, 1, 'qr', $5) RETURNING id`,
      [ids.orgA, event, enrollment, quest?.id, randomUUID()],
    );
    const [entry] = await owner<{ id: string }>(
      `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                 completion_id, quest_id, actor)
       VALUES ($1, $2, $3, 'quest', $4, $4, $5, $6, 'player') RETURNING id`,
      [ids.orgA, event, enrollment, points, done?.id, quest?.id],
    );
    return entry?.id ?? "";
  };
  const newPlayer = async (event: string, points = 500): Promise<Member> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`window_${counter}`],
    );
    const [enrolled] = await owner<{ id: string }>(
      `INSERT INTO enrollment (organizer_id, event_id, player_id, joined_via) VALUES ($1, $2, $3, 'code')
       RETURNING id`,
      [ids.orgA, event, player?.id],
    );
    const enrollment = enrolled?.id ?? "";
    const entry = points > 0 ? await fund(event, enrollment, points) : "";
    return { player: player?.id ?? "", enrollment, entry };
  };
  const newOperator = async (event: string): Promise<string> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`window_op_${counter}`],
    );
    await owner(
      `INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities)
       VALUES ($1, $2, $3, '{hand_over}')`,
      [ids.orgA, event, player?.id],
    );
    return player?.id ?? "";
  };
  const newReward = async (event: string, kind = "item", price = 100): Promise<string> =>
    (
      await owner<{ id: string }>(
        `INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, $2, 'Prize', $3, $4)
         RETURNING id`,
        [event, kind, price, kind === "digital" ? 0 : 5],
      )
    )[0]?.id ?? "";
  /** A digital reward with `count` uploaded codes (sealed bytes stand in for real ones), first to last. */
  const digitalReward = async (event: string, count: number) => {
    const id = await newReward(event, "digital", 50);
    const codes = Array.from({ length: count }, () => randomBytes(40));
    await run(team(), "SELECT * FROM add_reward_codes($1, $2, $3)", [
      id,
      codes,
      codes.map(() => randomBytes(32)),
    ]);
    return { id, codes };
  };
  type Reserved = {
    redemption_id: string;
    status: string;
    balance: string;
    stock_left: number;
    code_cipher: Buffer | null;
  };
  const reserve = async (player: string, reward: string): Promise<Reserved> =>
    (
      await run<Reserved>(as(player), "SELECT * FROM reserve_reward($1, $2)", [
        reward,
        randomUUID(),
      ])
    )[0] as Reserved;
  const handOver = async (player: string, operator: string, redemption: string) => {
    await run(as(player), "SELECT start_collect($1)", [redemption]);
    return (
      await run<{ status: string }>(as(operator), "SELECT * FROM desk_hand_over($1)", [redemption])
    )[0]?.status;
  };
  const sums = async (enrollment: string) =>
    (
      await owner<Row>(
        `SELECT n.score, n.balance,
                (SELECT coalesce(sum(score_delta), 0) FROM ledger_entry WHERE enrollment_id = n.id) AS ledger_score,
                (SELECT coalesce(sum(balance_delta), 0) FROM ledger_entry WHERE enrollment_id = n.id) AS ledger_balance
         FROM enrollment n WHERE n.id = $1`,
        [enrollment],
      )
    )[0];
  const unitsOut = async (reward: string) =>
    (await owner<{ u: number }>("SELECT units_out AS u FROM reward WHERE id = $1", [reward]))[0]?.u;
  const redemptionEntries = (redemption: string) =>
    owner<{ kind: string; score_delta: string; balance_delta: string }>(
      "SELECT kind, score_delta, balance_delta FROM ledger_entry WHERE redemption_id = $1 ORDER BY id",
      [redemption],
    );
  /** Runs the tick's reservation timeout until nothing is due. */
  const expireDue = async () => {
    const seen: (string | null)[] = [];
    for (let i = 0; i < 50; i += 1) {
      const [row] = await run<{ o: string | null }>({}, "SELECT expire_one_reservation() AS o");
      seen.push(row?.o ?? null);
      if (row?.o === null) break;
    }
    return seen;
  };

  /** Opens a transaction as `context` now; `work` runs in it once the close (1 s ahead) has passed by the margin. */
  const beganBeforeTheClose = async <T>(
    context: Readonly<Record<string, string>>,
    closes: Date,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const [key, value] of Object.entries(context)) {
        await client.query("SELECT set_config($1, $2, true)", [key, value]);
      }
      const [start] = (await client.query("SELECT now() < $1 AS before", [closes])).rows;
      expect(start).toEqual({ before: true });
      await sleep(PAST_THE_CLOSE_MS);
      const [late] = (await client.query("SELECT clock_timestamp() >= $1 AS after", [closes])).rows;
      expect(late).toEqual({ after: true });
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };

  /** Everything the close must leave alone, for one member: read as the owner and as the player. */
  const kept = async (who: Member, event: string) => {
    const [stored] = await owner(
      `SELECT n.score,
              (SELECT row_to_json(f) FROM final_rank f WHERE f.enrollment_id = n.id) AS final_rank,
              (SELECT row_to_json(x) FROM player_xp x WHERE x.player_id = n.player_id) AS xp,
              (SELECT coalesce(json_agg(a ORDER BY a.achievement_id, a.tier), '[]')
               FROM achievement_earned a WHERE a.player_id = n.player_id) AS achievements,
              (SELECT coalesce(json_agg(o ORDER BY o.item_id), '[]')
               FROM player_item o WHERE o.player_id = n.player_id) AS items,
              public_passport(n.player_id) AS stamps
       FROM enrollment n WHERE n.id = $1`,
      [who.enrollment],
    );
    const passport = await run(
      as(who.player),
      "SELECT * FROM own_events(false, NULL, NULL, 50) WHERE event_id = $1",
      [event],
    );
    return { stored, passport };
  };

  describe("the window guard (ADR-336)", () => {
    it("lets the API set any value before the end: draft, scheduled and live", async () => {
      const future = { starts: "5 days", ends: "6 days" };
      const events = [
        await newEvent({ status: "draft", ...future }),
        await newEvent({ status: "scheduled", ...future }),
        await newEvent(),
      ];
      for (const event of events) {
        for (const value of [0, 30, 1]) {
          expect(await setDays(event, value)).toEqual([{ shop_days_after: value }]);
        }
      }
    });

    it("after the end, while open, takes a longer window and the same value, and refuses a shorter one", async () => {
      // Ended by the clock (still `live` until the tick), and ended by the tick.
      for (const status of ["live", "ended"]) {
        const event = await newEvent({ status, ends: "-1 day" });
        expect(await stateOf(event)).toBe("open");
        expect(await setDays(event, 4)).toEqual([{ shop_days_after: 4 }]);
        expect(await setDays(event, 4)).toEqual([{ shop_days_after: 4 }]);
        expect(await setDays(event, 30)).toEqual([{ shop_days_after: 30 }]);
        expect(await refusal(setDays(event, 29)), status).toBe("SW409:shorter");
        expect(await refusal(setDays(event, 0)), status).toBe("SW409:shorter");
        expect(await daysOf(event)).toBe(30);
      }
    });

    it("freezes a closed window, lengthening included, and treats an archived event's as closed", async () => {
      const closed = await newEvent({ ends: "-5 days" });
      expect(await stateOf(closed)).toBe("closed");
      for (const value of [30, 4, 2, 0]) {
        expect(await refusal(setDays(closed, value)), String(value)).toBe("SW409:closed");
      }
      // Sending the stored value is no change.
      expect(await setDays(closed, 3)).toEqual([{ shop_days_after: 3 }]);
      const zero = await newEvent({ ends: "-1 minute", days: 0 });
      expect(await refusal(setDays(zero, 5))).toBe("SW409:closed");
      const archived = await newEvent({ status: "archived", ends: "-1 hour" });
      expect(await refusal(setDays(archived, 10))).toBe("SW409:closed");
      expect([await daysOf(closed), await daysOf(zero), await daysOf(archived)]).toEqual([3, 0, 3]);
    });

    it("lets the owner connection change a closed window (migrations and support work)", async () => {
      const event = await newEvent({ ends: "-5 days" });
      await owner("UPDATE event SET shop_days_after = 10 WHERE id = $1", [event]);
      expect(await daysOf(event)).toBe(10);
    });

    it("judges on clock_timestamp(): an edit whose transaction began before the close is refused after it", async () => {
      const event = await newEvent();
      const closes = await closeInASecond(event);
      const context = { "app.organizer_id": ids.orgA, "app.staff_user_id": ownerA };
      const outcome = await beganBeforeTheClose(context, closes, async (client) => {
        // On the transaction's own clock the shop is still open, so the API's rule alone would let this through.
        const [seen] = (
          await client.query(
            "SELECT shop_state(status, starts_at, ends_at, shop_days_after) AS s FROM event WHERE id = $1",
            [event],
          )
        ).rows;
        expect(seen).toEqual({ s: "open" });
        await client.query("SAVEPOINT edit");
        const refused = await refusal(
          client.query("UPDATE event SET shop_days_after = 5 WHERE id = $1", [event]),
        );
        await client.query("ROLLBACK TO SAVEPOINT edit");
        return refused;
      });
      expect(outcome).toBe("SW409:closed");
      expect(await daysOf(event)).toBe(3);
    });

    it("cannot be reopened by any path: no end moves, no status is written, no other role or seat edits", async () => {
      const event = await newEvent({ ends: "-5 days" });
      expect(
        await refusal(
          run(team(), "UPDATE event SET ends_at = now() + interval '1 day' WHERE id = $1", [event]),
        ),
      ).toBe("QE409");
      expect(
        await refusal(run(team(), "UPDATE event SET status = 'live' WHERE id = $1", [event])),
      ).toBe("42501");
      expect(await refusal(db.outsider.query("UPDATE public.event SET shop_days_after = 9"))).toBe(
        "42501",
      );
      const { player } = await newPlayer(event, 0);
      expect(await setDays(event, 9, as(player))).toEqual([]);
      expect(await setDays(event, 9, teamB())).toEqual([]);
      expect(await setDays(event, 9, {})).toEqual([]);
      expect(await daysOf(event)).toBe(3);
      expect(await stateOf(event)).toBe("closed");
    });
  });

  describe("the shop at the close (FR-750, FR-1018)", () => {
    it("serves for its days after the end, then refuses, and event_shop says when it closed", async () => {
      const event = await newEvent({ ends: "-1 day" });
      const who = await newPlayer(event);
      const prize = await newReward(event);
      expect(await reserve(who.player, prize)).toMatchObject({ status: "reserved" });
      const shopOf = async () =>
        (
          await run<{ state: string; closes_at: Date }>(
            as(who.player),
            "SELECT state, closes_at FROM event_shop($1)",
            [event],
          )
        )[0];
      expect(await shopOf()).toMatchObject({ state: "open" });
      const closes = await closeNow(event);
      expect(await refusal(reserve(who.player, prize))).toBe("RS403:closed");
      expect(await shopOf()).toEqual({ state: "closed", closes_at: closes });
    });

    it("serves a reservation whose transaction began before the close, and refuses a new one after it", async () => {
      const event = await newEvent();
      const who = await newPlayer(event);
      const prize = await newReward(event, "item", 120);
      const closes = await closeInASecond(event);
      const made = await beganBeforeTheClose(
        { "app.player_id": who.player },
        closes,
        async (client) => {
          const { rows } = await client.query<Reserved>("SELECT * FROM reserve_reward($1, $2)", [
            prize,
            randomUUID(),
          ]);
          return rows[0] as Reserved;
        },
      );
      expect(made).toMatchObject({ status: "reserved", balance: "380", stock_left: 4 });
      expect(await sums(who.enrollment)).toEqual({
        score: "500",
        balance: "380",
        ledger_score: "500",
        ledger_balance: "380",
      });
      expect(await unitsOut(prize)).toBe(1);
      expect(await redemptionEntries(made.redemption_id)).toEqual([
        { kind: "redeem", score_delta: "0", balance_delta: "-120" },
      ]);
      expect(await refusal(reserve(who.player, prize))).toBe("RS403:closed");
      expect(await unitsOut(prize)).toBe(1);
    });
  });

  describe("holds after the close (FR-1609)", () => {
    it("hands over at the desk a hold made before the close", async () => {
      const event = await newEvent({ ends: "-1 day" });
      const desk = await newOperator(event);
      const who = await newPlayer(event);
      const prize = await newReward(event);
      const hold = await reserve(who.player, prize);
      await closeNow(event);
      expect(await handOver(who.player, desk, hold.redemption_id)).toBe("handed_over");
      expect((await redemptionEntries(hold.redemption_id)).map((e) => e.kind)).toEqual([
        "redeem",
        "handover",
      ]);
      expect(await refusal(reserve(who.player, prize))).toBe("RS403:closed");
    });

    it("times a hold out after the close: the points and the unit come back once, and the shop still refuses", async () => {
      const event = await newEvent({ ends: "-1 day" });
      const who = await newPlayer(event);
      const prize = await newReward(event);
      const hold = await reserve(who.player, prize);
      await closeNow(event);
      await owner(
        "UPDATE redemption SET reserved_until = now() - interval '1 minute' WHERE id = $1",
        [hold.redemption_id],
      );
      expect(await expireDue()).toContain("expired");
      const [ended] = await owner<{ status: string }>(
        "SELECT status FROM redemption WHERE id = $1",
        [hold.redemption_id],
      );
      expect(ended?.status).toBe("expired");
      expect(await redemptionEntries(hold.redemption_id)).toEqual([
        { kind: "redeem", score_delta: "0", balance_delta: "-100" },
        { kind: "redeem_return", score_delta: "0", balance_delta: "100" },
      ]);
      expect(await sums(who.enrollment)).toMatchObject({ balance: "500", ledger_balance: "500" });
      expect(await unitsOut(prize)).toBe(0);
      expect(await refusal(reserve(who.player, prize))).toBe("RS403:closed");
    });

    it("returns a player's cancel after the close into the closed balance", async () => {
      const event = await newEvent({ ends: "-1 day" });
      const who = await newPlayer(event);
      const prize = await newReward(event);
      const hold = await reserve(who.player, prize);
      await closeNow(event);
      const [cancelled] = await run<{ status: string; balance: string }>(
        as(who.player),
        "SELECT status, balance FROM cancel_redemption($1)",
        [hold.redemption_id],
      );
      expect(cancelled).toEqual({ status: "cancelled", balance: "500" });
      expect(await sums(who.enrollment)).toMatchObject({ balance: "500", ledger_balance: "500" });
      expect(await stateOf(event)).toBe("closed");
    });

    it("hands over a rank prize whose deadline comes after the close", async () => {
      const event = await newEvent({ ends: "-1 hour" });
      const desk = await newOperator(event);
      const winner = await newPlayer(event, 300);
      await newPlayer(event, 100);
      await owner(
        "INSERT INTO rank_prize (event_id, rank_from, rank_to, kind, name_en) VALUES ($1, 1, 1, 'item', 'Cup')",
        [event],
      );
      const places = await run<{ enrollment_id: string }>(
        team(),
        "SELECT * FROM results_places($1)",
        [event],
      );
      await run(team(), "SELECT confirm_results($1, $2, $3)", [
        event,
        places.map((p) => p.enrollment_id),
        randomUUID(),
      ]);
      await run(team(), "SELECT reveal_results($1, $2, $3)", [
        event,
        new Date(Date.now() + 48 * 3600 * 1000),
        randomUUID(),
      ]);
      await owner("UPDATE event SET shop_days_after = 0 WHERE id = $1", [event]);
      expect(await stateOf(event)).toBe("closed");
      const [prize] = await owner<{ id: string; price: number }>(
        "SELECT id, price FROM redemption WHERE enrollment_id = $1 AND rank_prize_id IS NOT NULL",
        [winner.enrollment],
      );
      expect(prize?.price).toBe(0);
      expect(await handOver(winner.player, desk, prize?.id ?? "")).toBe("handed_over");
    });

    it("delivers a real code after the end, keeps it readable after the close and the unassigned codes in place", async () => {
      const event = await newEvent({ ends: "-1 day" });
      const who = await newPlayer(event);
      const reward = await digitalReward(event, 3);
      const made = await reserve(who.player, reward.id);
      // Bought in the days after the end (0054's NULL rehearsal flag delivered no code and counted no unit then).
      expect(made).toMatchObject({ status: "delivered", stock_left: 2 });
      expect(made.code_cipher?.equals(reward.codes[0] as Buffer)).toBe(true);
      expect(await unitsOut(reward.id)).toBe(1);
      await closeNow(event);
      const mine = await run<{ status: string; code_cipher: Buffer | null }>(
        as(who.player),
        "SELECT status, code_cipher FROM my_redemptions($1)",
        [event],
      );
      expect(mine).toHaveLength(1);
      expect(mine[0]?.status).toBe("delivered");
      expect(mine[0]?.code_cipher?.equals(reward.codes[0] as Buffer)).toBe(true);
      const [left] = await owner<{ n: number }>(
        "SELECT count(*)::int AS n FROM reward_code WHERE reward_id = $1 AND redemption_id IS NULL",
        [reward.id],
      );
      expect(left?.n).toBe(2);
      expect(await refusal(reserve(who.player, reward.id))).toBe("RS403:closed");
      expect(await unitsOut(reward.id)).toBe(1);
    });

    it("stops items when the desk's hours have ended, and keeps digital rewards on sale until the close", async () => {
      const event = await newEvent({ ends: "-1 day" });
      await owner(
        `UPDATE event SET desk_hours = tstzmultirange(tstzrange(now() - interval '1 day', now() - interval '1 hour'))
         WHERE id = $1`,
        [event],
      );
      const who = await newPlayer(event);
      const item = await newReward(event);
      expect(await refusal(reserve(who.player, item))).toBe("RS403:desk_finished");
      const digital = await digitalReward(event, 1);
      expect(await reserve(who.player, digital.id)).toMatchObject({ status: "delivered" });
      const [shop] = await run<{ state: string; desk_closes: Date[] }>(
        as(who.player),
        "SELECT state, desk_closes FROM event_shop($1)",
        [event],
      );
      expect(shop?.state).toBe("open");
    });

    it("moves an item's pickup to the desk's next opening after the end", async () => {
      const event = await newEvent({ ends: "-1 day" });
      const [{ opens } = { opens: new Date() }] = await owner<{ opens: Date }>(
        `UPDATE event SET desk_hours = tstzmultirange(tstzrange(now() + interval '2 hours', now() + interval '5 hours'))
         WHERE id = $1 RETURNING lower(desk_hours) AS opens`,
        [event],
      );
      const who = await newPlayer(event);
      const made = await run<{ reserved_until: Date }>(
        as(who.player),
        "SELECT reserved_until FROM reserve_reward($1, $2)",
        [await newReward(event), randomUUID()],
      );
      // The pickup time (120 minutes by default) runs from the desk's opening, not from now.
      expect(made[0]?.reserved_until).toEqual(new Date(opens.getTime() + 120 * 60_000));
    });
  });

  describe("earning after the close (FR-1710)", () => {
    const QUIZ = {
      questions: ["q1", "q2"].map((id) => ({
        id,
        text: { en: `Question ${id}` },
        choices: [
          { id: "r", text: { en: "Right" } },
          { id: "w", text: { en: "Wrong" } },
        ],
        right: "r",
      })),
      timerSeconds: null,
    };

    it("pays a quiz the tick finishes after the close to the score only", async () => {
      const event = await newEvent();
      const who = await newPlayer(event, 0);
      const [quiz] = await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
         SELECT $1, id, 'quiz', 'Quiz', 20, $2 FROM category WHERE event_id = $1 LIMIT 1 RETURNING id`,
        [event, JSON.stringify(QUIZ)],
      );
      await run(as(who.player), "SELECT quiz_start($1)", [quiz?.id]);
      await run(as(who.player), "SELECT quiz_next($1)", [quiz?.id]);
      await run(as(who.player), "SELECT quiz_answer($1, 'q1', 'r')", [quiz?.id]);
      await run(as(who.player), "SELECT quiz_next($1)", [quiz?.id]);
      await closeNow(event);
      let outcome: string | null = null;
      for (let i = 0; i < 10 && outcome !== "paid"; i += 1) {
        outcome =
          (await run<{ o: string | null }>({}, "SELECT finish_one_due_quiz() AS o"))[0]?.o ?? null;
      }
      expect(outcome).toBe("paid");
      const entries = await owner<{ score_delta: string; balance_delta: string }>(
        "SELECT score_delta, balance_delta FROM ledger_entry WHERE enrollment_id = $1 AND kind = 'quest'",
        [who.enrollment],
      );
      expect(entries).toHaveLength(1);
      expect(Number(entries[0]?.score_delta)).toBeGreaterThan(0);
      expect(entries[0]?.balance_delta).toBe("0");
      expect(await sums(who.enrollment)).toMatchObject({ balance: "0", ledger_balance: "0" });
    });

    it("removes an award after the close taking no more than the closed balance holds", async () => {
      const event = await newEvent({ ends: "-1 day" });
      const desk = await newOperator(event);
      const who = await newPlayer(event, 100);
      const prize = await newReward(event, "item", 80);
      const hold = await reserve(who.player, prize);
      expect(await handOver(who.player, desk, hold.redemption_id)).toBe("handed_over");
      await closeNow(event);
      const [removed] = await run<{ score_delta: string; balance_delta: string }>(
        team(),
        "SELECT score_delta, balance_delta FROM remove_award($1, $2, 'Duplicate', $3, $4)",
        [event, who.entry, randomUUID(), randomUUID()],
      );
      expect(removed).toEqual({ score_delta: "-100", balance_delta: "-20" });
      expect(await sums(who.enrollment)).toEqual({
        score: "0",
        balance: "0",
        ledger_score: "0",
        ledger_balance: "0",
      });
    });
  });

  describe("what the player keeps (FR-751)", () => {
    it("leaves score, final rank, stamp, souvenirs, XP, level and achievements as they were", async () => {
      const event = await newEvent({ ends: "-1 hour" });
      const first = await newPlayer(event, 300);
      const second = await newPlayer(event, 100);
      await owner(
        "INSERT INTO item (id, kind, name_ar, name_en) VALUES ('window-souvenir', 'title', 'تذكار', 'Keepsake')",
      );
      const [rule] = await owner<{ id: string }>(
        `INSERT INTO souvenir_rule (organizer_id, event_id, item_id, audience, status, activated_at)
         VALUES ($1, $2, 'window-souvenir', 'joined', 'active', now()) RETURNING id`,
        [ids.orgA, event],
      );
      await owner(
        `INSERT INTO souvenir_receipt (rule_id, event_id, item_id, player_id, enrollment_id)
         VALUES ($1, $2, 'window-souvenir', $3, $4)`,
        [rule?.id, event, first.player, first.enrollment],
      );
      await owner(
        `INSERT INTO player_item (player_id, item_id, source, source_rule_id, source_event_id, earned_at)
         VALUES ($1, 'window-souvenir', 'souvenir', $2, $3, now())`,
        [first.player, rule?.id, event],
      );
      // A hold due before the close: spending does not lower the rank here, so its return cannot move the score.
      const hold = await reserve(second.player, await newReward(event, "item", 50));
      await owner(
        "UPDATE redemption SET reserved_until = now() - interval '1 minute' WHERE id = $1",
        [hold.redemption_id],
      );
      const places = await run<{ enrollment_id: string }>(
        team(),
        "SELECT * FROM results_places($1)",
        [event],
      );
      await run(team(), "SELECT confirm_results($1, $2, $3)", [
        event,
        places.map((p) => p.enrollment_id),
        randomUUID(),
      ]);
      await run(team(), "SELECT reveal_results($1, $2, $3)", [
        event,
        new Date(Date.now() + 24 * 3600 * 1000),
        randomUUID(),
      ]);
      for (const who of [first, second]) await run(as(who.player), "SELECT questify_sync()");
      const [{ last } = { last: "0" }] = await owner<{ last: string }>(
        "SELECT coalesce(max(id), 0)::text AS last FROM ledger_entry WHERE event_id = $1",
        [event],
      );
      const before = [await kept(first, event), await kept(second, event)];
      expect(before[0]?.passport[0]).toMatchObject({ rank: 1, rank_state: "final", played: true });
      expect(before[0]?.stored?.["items"]).toHaveLength(1);
      expect(before[1]?.stored?.["achievements"]).not.toEqual([]);

      await owner("UPDATE event SET shop_days_after = 0 WHERE id = $1", [event]);
      expect(await stateOf(event)).toBe("closed");
      await run({}, "SELECT advance_event_lifecycle()");
      expect(await expireDue()).toContain("expired");

      expect([await kept(first, event), await kept(second, event)]).toEqual(before);
      // The close wrote nothing: the only new entry is the due hold's own return.
      const written = await owner<{ kind: string }>(
        "SELECT kind FROM ledger_entry WHERE event_id = $1 AND id > $2 ORDER BY id",
        [event, last],
      );
      expect(written.map((row) => row.kind)).toEqual(["redeem_return"]);
    });
  });
});
