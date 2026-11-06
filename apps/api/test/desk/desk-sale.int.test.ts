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
type Sale = {
  sale_id: string;
  status: string;
  price: number;
  replayed: boolean;
  just_bought: boolean;
};
type Paid = {
  status: string;
  redemption_id: string | null;
  balance: string;
  refusal: string | null;
  replayed: boolean;
};

const refusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    const { code, detail } = error as { code: string; detail?: string };
    return detail === undefined || detail === "" ? code : `${code}:${detail}`;
  }
  return "none";
};

const statusOf = (settled: PromiseSettledResult<{ rows: Row[] }> | undefined) =>
  settled?.status === "fulfilled" ? settled.value.rows[0]?.["status"] : "rejected";

/**
 * The desk sale in the database (T-612, migration 0107): reservation On or Off, the offer, the player's Pay through
 * the one spend body, every refusal with nothing written, the live-offer rules, the races, the wipe and erasure.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("desk sale (database)", () => {
  let db: TestDatabase;
  let pool: Pool;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let staffA = "";
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new Pool({ connectionString: db.appUrl, max: 8 });
    ids = await seedTwoTenants(db.owner);
    staffA = await addMember(db.owner, ids.orgA, "owner");
  });
  afterAll(async () => {
    await pool.end();
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  type EventShape = {
    reservationOn?: boolean;
    hours?: string | null;
    status?: string;
    lowers?: boolean;
  };
  const newEvent = async (shape: EventShape = {}): Promise<string> => {
    counter += 1;
    const draft = shape.status === "draft";
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at, desk_location_en, desk_hours,
                          reservation_on, spend_lowers_rank)
       VALUES ($1, $2, 'Sale Fest', $3, now() + $4::interval, now() + interval '3 days', 'Hall B',
               $5::tstzmultirange, $6, $7)
       RETURNING id`,
      [
        ids.orgA,
        `SALE${counter}`,
        shape.status ?? "live",
        draft ? "1 day" : "-1 hour",
        shape.hours ?? null,
        shape.reservationOn ?? false,
        shape.lowers ?? false,
      ],
    );
    return event?.id ?? "";
  };

  const newPlayer = async (event: string, points = 1000, via = "code") => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`sale_player_${counter}`],
    );
    const [enrolled] = await owner<{ id: string }>(
      `INSERT INTO enrollment (organizer_id, event_id, player_id, joined_via) VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [ids.orgA, event, player?.id, via],
    );
    if (points > 0) {
      await owner(
        `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor)
         VALUES ($1, $2, $3, 'welcome', $4, $4, 'system')`,
        [ids.orgA, event, enrolled?.id, points],
      );
    }
    return { player: player?.id ?? "", enrollment: enrolled?.id ?? "" };
  };

  const newOperator = async (event: string, abilities = ["hand_over"]): Promise<string> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`sale_op_${counter}`],
    );
    await owner(
      "INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities) VALUES ($1, $2, $3, $4)",
      [ids.orgA, event, player?.id, abilities],
    );
    return player?.id ?? "";
  };

  const newReward = async (event: string, kind = "item", price = 200, stock = 5) => {
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

  const versionOf = async (player: string): Promise<number> =>
    (await owner<{ v: number }>("SELECT my_qr_version AS v FROM player WHERE id = $1", [player]))[0]
      ?.v ?? 0;
  const offer = async (
    operator: string,
    event: string,
    player: string,
    reward: string,
    key = randomUUID(),
  ): Promise<Sale> =>
    (
      await call<Sale>(operator, "SELECT * FROM desk_offer_sale($1, $2, $3, $4, $5)", [
        event,
        player,
        await versionOf(player),
        reward,
        key,
      ])
    )[0] as Sale;
  const pay = async (player: string, sale: string): Promise<Paid> =>
    (await call<Paid>(player, "SELECT * FROM accept_desk_sale($1)", [sale]))[0] as Paid;
  const saleRow = async (sale: string) =>
    (
      await owner<{ status: string; refusal: string | null; redemption_id: string | null }>(
        "SELECT status, refusal, redemption_id FROM desk_sale WHERE id = $1",
        [sale],
      )
    )[0];
  const sums = async (enrollment: string) =>
    (
      await owner<{ balance: string; ledger: string; redemptions: string }>(
        `SELECT n.balance::text,
                (SELECT coalesce(sum(l.balance_delta), 0) FROM ledger_entry l WHERE l.enrollment_id = n.id)::text AS ledger,
                (SELECT count(*) FROM redemption d WHERE d.enrollment_id = n.id)::text AS redemptions
         FROM enrollment n WHERE n.id = $1`,
        [enrollment],
      )
    )[0];
  const unitsOut = async (reward: string) =>
    (await owner<{ u: number }>("SELECT units_out AS u FROM reward WHERE id = $1", [reward]))[0]?.u;
  const salesOf = async (enrollment: string) =>
    Number(
      (
        await owner<{ n: string }>("SELECT count(*) AS n FROM desk_sale WHERE enrollment_id = $1", [
          enrollment,
        ])
      )[0]?.n,
    );

  const setup = async (shape: EventShape = {}, points = 1000) => {
    const event = await newEvent(shape);
    const desk = await newOperator(event);
    const who = await newPlayer(event, points);
    const reward = await newReward(event);
    return { event, desk, reward, ...who };
  };

  const economy = async (event: string) => {
    const client = await pool.connect();
    try {
      return await withRequestContext(
        client,
        { organizerId: ids.orgA, staffUserId: staffA },
        async () => {
          const { rows } = await client.query<{ e: Record<string, unknown> }>(
            "SELECT analytics_economy($1) AS e",
            [event],
          );
          const answer = rows[0]?.e ?? {};
          const rewards = (answer["rewards"] as Row[] | undefined)?.map(
            ({ id: _id, ...rest }) => rest,
          );
          return { ...answer, rewards };
        },
      );
    } finally {
      client.release();
    }
  };

  const refusedWith = async (
    breakIt: (s: Awaited<ReturnType<typeof setup>>) => Promise<unknown>,
    expected: string,
    points = 1000,
  ) => {
    const s = await setup({}, points);
    const sale = await offer(s.desk, s.event, s.player, s.reward);
    await breakIt(s);
    const before = await sums(s.enrollment);
    const paid = await pay(s.player, sale.sale_id);
    expect(paid).toMatchObject({ status: "refused", refusal: expected, redemption_id: null });
    expect(await sums(s.enrollment)).toEqual(before);
    expect(await unitsOut(s.reward)).toBe(
      expected === "RO409"
        ? (
            await owner<{ s: number }>("SELECT stock_total AS s FROM reward WHERE id = $1", [
              s.reward,
            ])
          )[0]?.s
        : 0,
    );
    expect(await pay(s.player, sale.sale_id)).toEqual({ ...paid, replayed: true });
    return s;
  };

  /** Runs `first` in an open transaction, starts `second`, then commits `first`; both settle. */
  const race = async (
    first: [string, string, unknown[]],
    second: [string, string, unknown[]],
  ): Promise<PromiseSettledResult<{ rows: Row[] }>[]> => {
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query("BEGIN");
      await a.query("SELECT set_config('app.player_id', $1, true)", [first[0]]);
      const firstWork = a.query(first[1], first[2]);
      await firstWork;
      await b.query("BEGIN");
      await b.query("SELECT set_config('app.player_id', $1, true)", [second[0]]);
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

  const PAY = "SELECT * FROM accept_desk_sale($1)";

  describe("the sale", () => {
    it("offers, and the player's Pay takes the price and hands the item over in one transaction", async () => {
      const s = await setup();
      const sale = await offer(s.desk, s.event, s.player, s.reward);
      expect(sale).toMatchObject({
        status: "offered",
        price: 200,
        replayed: false,
        just_bought: false,
      });
      expect(await unitsOut(s.reward)).toBe(0);
      const paid = await pay(s.player, sale.sale_id);
      expect(paid).toMatchObject({
        status: "accepted",
        balance: "800",
        refusal: null,
        replayed: false,
      });
      const [made] = await owner<Row>(
        `SELECT status, ended_by, operator_id, idempotency_key, reserved_until IS NOT NULL AS dated, price
         FROM redemption WHERE id = $1`,
        [paid.redemption_id],
      );
      expect(made).toEqual({
        status: "handed_over",
        ended_by: "handover",
        operator_id: s.desk,
        idempotency_key: `desk:${sale.sale_id}`,
        dated: true,
        price: 200,
      });
      const ledger = await owner<Row>(
        `SELECT kind, score_delta::int, balance_delta::int, actor, operator_id FROM ledger_entry
         WHERE redemption_id = $1 ORDER BY id`,
        [paid.redemption_id],
      );
      expect(ledger).toEqual([
        { kind: "redeem", score_delta: 0, balance_delta: -200, actor: "player", operator_id: null },
        {
          kind: "handover",
          score_delta: 0,
          balance_delta: 0,
          actor: "operator",
          operator_id: s.desk,
        },
      ]);
      expect(await unitsOut(s.reward)).toBe(1);
      expect(await saleRow(sale.sale_id)).toEqual({
        status: "accepted",
        refusal: null,
        redemption_id: paid.redemption_id,
      });
      const state = await call(s.desk, "SELECT status, refusal FROM desk_sale_state($1)", [
        sale.sale_id,
      ]);
      expect(state).toEqual([{ status: "accepted", refusal: null }]);
    });

    it("lowers the score while live when spending lowers the rank, and marks the ranking (ADR-135)", async () => {
      const s = await setup({ lowers: true });
      await owner("DELETE FROM ranking_repair WHERE event_id = $1", [s.event]);
      const paid = await pay(s.player, (await offer(s.desk, s.event, s.player, s.reward)).sale_id);
      const [redeem] = await owner<{ score: number }>(
        "SELECT score_delta::int AS score FROM ledger_entry WHERE redemption_id = $1 AND kind = 'redeem'",
        [paid.redemption_id],
      );
      expect(redeem?.score).toBe(-200);
      expect(
        await owner("SELECT 1 FROM ranking_repair WHERE event_id = $1", [s.event]),
      ).toHaveLength(1);
    });

    it("a second Pay answers the same redemption and writes nothing more", async () => {
      const s = await setup();
      const sale = await offer(s.desk, s.event, s.player, s.reward);
      const first = await pay(s.player, sale.sale_id);
      const again = await pay(s.player, sale.sale_id);
      expect(again).toEqual({ ...first, replayed: true });
      expect(await sums(s.enrollment)).toEqual({ balance: "800", ledger: "800", redemptions: "1" });
    });

    it("counts in analytics exactly as a reservation handed over", async () => {
      const sold = await setup();
      await pay(
        sold.player,
        (await offer(sold.desk, sold.event, sold.player, sold.reward)).sale_id,
      );
      const reserved = await setup({ reservationOn: true });
      const [row] = await call<{ redemption_id: string }>(
        reserved.player,
        "SELECT * FROM reserve_reward($1, $2)",
        [reserved.reward, randomUUID()],
      );
      await owner(
        `UPDATE redemption SET status = 'handed_over', ended_at = now(), ended_by = 'handover', operator_id = $2
         WHERE id = $1`,
        [row?.redemption_id, reserved.desk],
      );
      expect(await economy(sold.event)).toEqual(await economy(reserved.event));
    });
  });

  describe("the offer's refusals write nothing", () => {
    it("refuses a stranger, an operator without hand_over, their own code, an unknown or earlier code", async () => {
      const s = await setup();
      const stranger = (await newPlayer(s.event)).player;
      const scanOnly = await newOperator(s.event, ["scan_quests"]);
      const v = await versionOf(s.player);
      const offerAs = (who: string, player: string, version: number) =>
        call(who, "SELECT * FROM desk_offer_sale($1, $2, $3, $4, $5)", [
          s.event,
          player,
          version,
          s.reward,
          randomUUID(),
        ]);
      expect(await refusal(offerAs(stranger, s.player, v))).toBe("OP403");
      expect(await refusal(offerAs(scanOnly, s.player, v))).toBe("OA403");
      expect(await refusal(offerAs(s.desk, s.desk, await versionOf(s.desk)))).toBe("OY409");
      expect(await refusal(offerAs(s.desk, randomUUID(), 1))).toBe("QC404");
      expect(await refusal(offerAs(s.desk, s.player, v + 1))).toBe("OM422");
      const elsewhere = await newPlayer(await newEvent());
      expect(
        await refusal(offerAs(s.desk, elsewhere.player, await versionOf(elsewhere.player))),
      ).toBe("QC404");
      expect(await salesOf(s.enrollment)).toBe(0);
    });

    it("refuses a held, paused or removed player, another event's or a digital reward", async () => {
      const s = await setup();
      const other = await newReward(await newEvent());
      const digital = await newReward(s.event, "digital", 100, 1);
      expect(await refusal(offer(s.desk, s.event, s.player, other))).toBe("RN404");
      expect(await refusal(offer(s.desk, s.event, s.player, digital))).toBe(
        "DS422:not_desk_reward",
      );
      await owner("UPDATE enrollment SET redeem_paused_at = now() WHERE id = $1", [s.enrollment]);
      expect(await refusal(offer(s.desk, s.event, s.player, s.reward))).toBe("RH409:paused");
      await owner(
        "UPDATE enrollment SET redeem_paused_at = NULL, status = 'banned' WHERE id = $1",
        [s.enrollment],
      );
      expect(await refusal(offer(s.desk, s.event, s.player, s.reward))).toBe("RH409:held");
      await owner("UPDATE enrollment SET status = 'removed' WHERE id = $1", [s.enrollment]);
      expect(await refusal(offer(s.desk, s.event, s.player, s.reward))).toBe("RA403:removed");
      expect(await salesOf(s.enrollment)).toBe(0);
    });

    it("refuses while reservation is On, the shop is off or the desk is closed", async () => {
      const s = await setup({ reservationOn: true });
      expect(await refusal(offer(s.desk, s.event, s.player, s.reward))).toBe(
        "DS409:reservation_on",
      );
      await owner(
        `UPDATE event SET reservation_on = false, config = jsonb_set(config, '{features}', '{"shop": false}')
         WHERE id = $1`,
        [s.event],
      );
      expect(await refusal(offer(s.desk, s.event, s.player, s.reward))).toBe("RS403:feature_off");
      await owner(
        `UPDATE event SET config = '{}',
                desk_hours = tstzmultirange(tstzrange(now() + interval '1 hour', now() + interval '2 hours'))
         WHERE id = $1`,
        [s.event],
      );
      expect(await refusal(offer(s.desk, s.event, s.player, s.reward))).toBe("RS403:desk_closed");
      expect(await salesOf(s.enrollment)).toBe(0);
    });
  });

  describe("live offers and keys", () => {
    it("the same key answers its offer; another event, player or reward on that key is RK422", async () => {
      const s = await setup();
      const key = randomUUID();
      const first = await offer(s.desk, s.event, s.player, s.reward, key);
      expect(await offer(s.desk, s.event, s.player, s.reward, key)).toEqual({
        ...first,
        replayed: true,
      });
      const other = await newReward(s.event);
      expect(await refusal(offer(s.desk, s.event, s.player, other, key))).toBe("RK422");
      const someone = await newPlayer(s.event);
      expect(await refusal(offer(s.desk, s.event, someone.player, s.reward, key))).toBe("RK422");
      expect(await salesOf(s.enrollment)).toBe(1);
    });

    it("a key replayed after its offer ran out answers expired and leaves the row as it was", async () => {
      const s = await setup();
      const key = randomUUID();
      const first = await offer(s.desk, s.event, s.player, s.reward, key);
      await owner("UPDATE desk_sale SET offer_until = now() - interval '1 second' WHERE id = $1", [
        first.sale_id,
      ]);
      expect(await offer(s.desk, s.event, s.player, s.reward, key)).toMatchObject({
        sale_id: first.sale_id,
        status: "expired",
        replayed: true,
      });
      expect((await saleRow(first.sale_id))?.status).toBe("offered");
      expect(await salesOf(s.enrollment)).toBe(1);
    });

    it("names the price on My QR with the event's own word, and leaves an unnamed event to the default", async () => {
      const s = await setup();
      await offer(s.desk, s.event, s.player, s.reward);
      const word = (await call(s.player, "SELECT currency FROM my_desk_sales()"))[0];
      expect(word).toEqual({ currency: null });
      const gems = { ar: { one: "جوهرة", many: "جواهر" }, en: { one: "gem", many: "gems" } };
      await owner(
        `UPDATE event SET config = jsonb_set(config, '{terms}', jsonb_build_object('currency', $2::jsonb))
         WHERE id = $1`,
        [s.event, JSON.stringify(gems)],
      );
      expect(await call(s.player, "SELECT currency FROM my_desk_sales()")).toEqual([
        { currency: gems },
      ]);
    });

    it("a double tap with two keys answers the live offer; another reward replaces it", async () => {
      const s = await setup();
      const first = await offer(s.desk, s.event, s.player, s.reward);
      const again = await offer(s.desk, s.event, s.player, s.reward);
      expect(again).toMatchObject({ sale_id: first.sale_id, replayed: true });
      const other = await newReward(s.event);
      const swapped = await offer(s.desk, s.event, s.player, other);
      expect(swapped.sale_id).not.toBe(first.sale_id);
      expect((await saleRow(first.sale_id))?.status).toBe("withdrawn");
    });

    it("another desk's live offer is desk_busy; an expired one blocks nobody and is never replayed", async () => {
      const s = await setup();
      const second = await newOperator(s.event);
      const first = await offer(s.desk, s.event, s.player, s.reward);
      expect(await refusal(offer(second, s.event, s.player, s.reward))).toBe("DS409:desk_busy");
      await owner("UPDATE desk_sale SET offer_until = now() - interval '1 second' WHERE id = $1", [
        first.sale_id,
      ]);
      const taken = await offer(second, s.event, s.player, s.reward);
      expect(taken).toMatchObject({ status: "offered", replayed: false });
      await owner("UPDATE desk_sale SET offer_until = now() - interval '1 second' WHERE id = $1", [
        taken.sale_id,
      ]);
      const fresh = await offer(s.desk, s.event, s.player, s.reward);
      expect(fresh.sale_id).not.toBe(first.sale_id);
      expect(fresh).toMatchObject({ replayed: false });
      expect(await refusal(pay(s.player, first.sale_id))).toBe("DS410:expired");
    });

    it("a re-offer after the player just paid says so to the desk and the player", async () => {
      const s = await setup();
      await pay(s.player, (await offer(s.desk, s.event, s.player, s.reward)).sale_id);
      const again = await offer(s.desk, s.event, s.player, s.reward);
      expect(again.just_bought).toBe(true);
      const mine = await call(s.player, "SELECT just_bought, balance_after FROM my_desk_sales()");
      expect(mine).toEqual([{ just_bought: true, balance_after: "600" }]);
    });
  });

  describe("Pay's refusals end the sale refused and write nothing", () => {
    it("sold out", () =>
      refusedWith(
        (s) => owner("UPDATE reward SET units_out = stock_total WHERE id = $1", [s.reward]),
        "RO409",
      ));
    it("too few points", () => refusedWith(async () => undefined, "RB422", 100));
    it("the per-player limit", () =>
      refusedWith(async (s) => {
        await owner("UPDATE reward SET per_player_limit = 1 WHERE id = $1", [s.reward]);
        await owner(
          `INSERT INTO redemption (organizer_id, event_id, enrollment_id, reward_id, price, idempotency_key,
                                   reserved_until)
           VALUES ($1, $2, $3, $4, 200, $5, now() + interval '1 hour')`,
          [ids.orgA, s.event, s.enrollment, s.reward, randomUUID()],
        );
      }, "RL409:1"));
    it("a price that changed after the offer", () =>
      refusedWith(
        (s) => owner("UPDATE reward SET price = 250 WHERE id = $1", [s.reward]),
        "DS409:price_changed",
      ));
    it("reservation turned On between the offer and Pay", () =>
      refusedWith(
        (s) => owner("UPDATE event SET reservation_on = true WHERE id = $1", [s.event]),
        "DS409:reservation_on",
      ));
    it("the shop switched off", () =>
      refusedWith(
        (s) =>
          owner(`UPDATE event SET config = '{"features": {"shop": false}}' WHERE id = $1`, [
            s.event,
          ]),
        "RS403:feature_off",
      ));
    it("the desk closed", () =>
      refusedWith(
        (s) =>
          owner(
            `UPDATE event SET desk_hours = tstzmultirange(tstzrange(now() + interval '1 hour', now() + interval '2 hours'))
             WHERE id = $1`,
            [s.event],
          ),
        "RS403:desk_closed",
      ));
    it("a held player (the API tells them nothing)", () =>
      refusedWith(
        (s) => owner("UPDATE enrollment SET status = 'banned' WHERE id = $1", [s.enrollment]),
        "RH409:held",
      ));
    it("a removed player", () =>
      refusedWith(
        (s) => owner("UPDATE enrollment SET status = 'removed' WHERE id = $1", [s.enrollment]),
        "RA403:removed",
      ));
    it("a community lock", () =>
      refusedWith(async (s) => {
        const [goal] = await owner<{ id: string }>(
          `INSERT INTO community_goal (organizer_id, event_id, title_en, measure, target, starts_at, ends_at)
           VALUES ($1, $2, 'Together', 'points', 100, now(), now() + interval '1 hour') RETURNING id`,
          [ids.orgA, s.event],
        );
        await owner(
          `INSERT INTO community_step (event_id, goal_id, threshold, reward, unlock_reward_id)
           VALUES ($1, $2, 10, 'unlock', $3)`,
          [s.event, goal?.id, s.reward],
        );
      }, "RW403:community_locked"));
    it("an operator who may not play (QP403, the ledger guard)", () =>
      refusedWith(
        (s) =>
          owner(
            "INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities) VALUES ($1, $2, $3, '{scan_quests}')",
            [ids.orgA, s.event, s.player],
          ),
        "QP403",
      ));

    it("the operator lost hand_over: the offer is withdrawn", async () => {
      const s = await setup();
      const sale = await offer(s.desk, s.event, s.player, s.reward);
      await owner("UPDATE staff_assignment SET abilities = '{scan_quests}' WHERE player_id = $1", [
        s.desk,
      ]);
      expect(await pay(s.player, sale.sale_id)).toMatchObject({
        status: "withdrawn",
        refusal: null,
      });
      expect(await sums(s.enrollment)).toEqual({
        balance: "1000",
        ledger: "1000",
        redemptions: "0",
      });
    });

    it("an error it does not catch rolls back whole and leaves the sale offered", async () => {
      const s = await setup();
      const sale = await offer(s.desk, s.event, s.player, s.reward);
      await owner(
        `INSERT INTO redemption (organizer_id, event_id, enrollment_id, reward_id, price, idempotency_key,
                                 reserved_until)
         VALUES ($1, $2, $3, $4, 200, $5, now() + interval '1 hour')`,
        [ids.orgA, s.event, s.enrollment, s.reward, `desk:${sale.sale_id}`],
      );
      const before = await sums(s.enrollment);
      expect(await refusal(pay(s.player, sale.sale_id))).toMatch(/^23505/);
      expect(await saleRow(sale.sale_id)).toEqual({
        status: "offered",
        refusal: null,
        redemption_id: null,
      });
      expect(await sums(s.enrollment)).toEqual(before);
    });

    it("DS410 for a declined, withdrawn or expired offer; RN404 for another player's", async () => {
      const s = await setup();
      const declined = await offer(s.desk, s.event, s.player, s.reward);
      expect(await call(s.player, "SELECT decline_desk_sale($1) AS d", [declined.sale_id])).toEqual(
        [{ d: true }],
      );
      expect(await call(s.player, "SELECT decline_desk_sale($1) AS d", [declined.sale_id])).toEqual(
        [{ d: false }],
      );
      expect(await refusal(pay(s.player, declined.sale_id))).toBe("DS410:declined");
      const withdrawn = await offer(s.desk, s.event, s.player, s.reward);
      const other = await newOperator(s.event);
      expect(await call(other, "SELECT withdraw_desk_sale($1) AS w", [withdrawn.sale_id])).toEqual([
        { w: true },
      ]);
      expect(await refusal(pay(s.player, withdrawn.sale_id))).toBe("DS410:withdrawn");
      const stranger = await newPlayer(s.event);
      const live = await offer(s.desk, s.event, s.player, s.reward);
      expect(await refusal(pay(stranger.player, live.sale_id))).toBe("RN404");
      expect(
        await refusal(call(stranger.player, "SELECT decline_desk_sale($1)", [live.sale_id])),
      ).toBe("RN404");
      expect(
        await refusal(call(stranger.player, "SELECT withdraw_desk_sale($1)", [live.sale_id])),
      ).toBe("OP403");
      expect(
        await refusal(call(stranger.player, "SELECT * FROM desk_sale_state($1)", [live.sale_id])),
      ).toBe("OP403");
      expect(await refusal(pay(s.player, randomUUID()))).toBe("RN404");
    });
  });

  describe("what the desk and My QR read", () => {
    it("lists the offerable rewards with whether the player can buy each, and none while reservation is On", async () => {
      const s = await setup({}, 250);
      const dear = await newReward(s.event, "experience", 300);
      const gone = await newReward(s.event, "item", 10, 0);
      await newReward(s.event, "digital", 10, 0);
      const rows = await call<{ reward_id: string; can: string }>(
        s.desk,
        "SELECT reward_id, can FROM desk_sale_rewards($1, $2, $3)",
        [s.event, s.player, await versionOf(s.player)],
      );
      expect(new Map(rows.map((row) => [row.reward_id, row.can]))).toEqual(
        new Map([
          [s.reward, "ok"],
          [dear, "too_few_points"],
          [gone, "sold_out"],
        ]),
      );
      await owner("UPDATE event SET reservation_on = true WHERE id = $1", [s.event]);
      expect(
        await call(s.desk, "SELECT * FROM desk_sale_rewards($1, $2, $3)", [
          s.event,
          s.player,
          await versionOf(s.player),
        ]),
      ).toEqual([]);
    });

    it("My QR watches while reservation is Off and the desk open, and lists only live offers", async () => {
      const s = await setup();
      const watch = async () =>
        (await call<{ w: boolean }>(s.player, "SELECT my_desk_watch() AS w"))[0]?.w;
      expect(await watch()).toBe(true);
      const sale = await offer(s.desk, s.event, s.player, s.reward);
      const mine = await call(
        s.player,
        "SELECT sale_id, price, balance_after, desk_location_en FROM my_desk_sales()",
      );
      expect(mine).toEqual([
        { sale_id: sale.sale_id, price: 200, balance_after: "800", desk_location_en: "Hall B" },
      ]);
      await owner("UPDATE desk_sale SET offer_until = now() - interval '1 second' WHERE id = $1", [
        sale.sale_id,
      ]);
      expect(await call(s.player, "SELECT * FROM my_desk_sales()")).toEqual([]);
      expect(await call(s.desk, "SELECT status FROM desk_sale_state($1)", [sale.sale_id])).toEqual([
        { status: "expired" },
      ]);
      await owner(
        `UPDATE event SET desk_hours = tstzmultirange(tstzrange(now() + interval '1 hour', now() + interval '2 hours'))
         WHERE id = $1`,
        [s.event],
      );
      expect(await watch()).toBe(false);
      await owner("UPDATE event SET desk_hours = NULL, reservation_on = true WHERE id = $1", [
        s.event,
      ]);
      expect(await watch()).toBe(false);
    });
  });

  describe("the app's reserve while reservation is Off", () => {
    it("refuses a desk kind, delivers a digital code, and replays a key from before the switch", async () => {
      const s = await setup({ reservationOn: true });
      const key = randomUUID();
      const reserve = (reward: string, k = randomUUID()) =>
        call<{ redemption_id: string; replayed: boolean }>(
          s.player,
          "SELECT * FROM reserve_reward($1, $2)",
          [reward, k],
        );
      const [first] = await reserve(s.reward, key);
      await owner("UPDATE event SET reservation_on = false WHERE id = $1", [s.event]);
      expect(await refusal(reserve(s.reward))).toBe("RS403:reservation_off");
      const experience = await newReward(s.event, "experience");
      expect(await refusal(reserve(experience))).toBe("RS403:reservation_off");
      expect((await reserve(s.reward, key))[0]).toMatchObject({
        redemption_id: first?.redemption_id,
        replayed: true,
      });
      const digital = await newReward(s.event, "digital", 50, 1);
      await owner(
        `INSERT INTO reward_code (organizer_id, event_id, reward_id, code_cipher, code_hash)
         VALUES ($1, $2, $3, decode(repeat('ab', 40), 'hex'), decode(repeat('cd', 32), 'hex'))`,
        [ids.orgA, s.event, digital],
      );
      expect((await reserve(digital))[0]).toMatchObject({ replayed: false });
    });

    it("a reservation made before Off still hands over at the desk", async () => {
      const s = await setup({ reservationOn: true });
      const [made] = await call<{ redemption_id: string }>(
        s.player,
        "SELECT * FROM reserve_reward($1, $2)",
        [s.reward, randomUUID()],
      );
      await owner("UPDATE event SET reservation_on = false WHERE id = $1", [s.event]);
      await call(s.player, "SELECT start_collect($1)", [made?.redemption_id]);
      const handed = await call(s.desk, "SELECT status FROM desk_hand_over($1)", [
        made?.redemption_id,
      ]);
      expect(handed).toEqual([{ status: "handed_over" }]);
    });

    it("refuses a client key that starts with desk:, before a sale's own key could replay", async () => {
      const s = await setup();
      const sale = await offer(s.desk, s.event, s.player, s.reward);
      await pay(s.player, sale.sale_id);
      await owner("UPDATE event SET reservation_on = true WHERE id = $1", [s.event]);
      const reserve = (key: string) =>
        call(s.player, "SELECT * FROM reserve_reward($1, $2)", [s.reward, key]);
      expect(await refusal(reserve(`desk:${sale.sale_id}`))).toBe("RK422");
      expect(await refusal(reserve("desk:mine"))).toBe("RK422");
    });
  });

  describe("races", () => {
    it("two desks, one unit, two players paying at once: one handed over, one sold out", async () => {
      const s = await setup();
      await owner("UPDATE reward SET stock_total = 1 WHERE id = $1", [s.reward]);
      const desk2 = await newOperator(s.event);
      const other = await newPlayer(s.event);
      const one = await offer(s.desk, s.event, s.player, s.reward);
      const two = await offer(desk2, s.event, other.player, s.reward);
      const settled = await race(
        [s.player, PAY, [one.sale_id]],
        [other.player, PAY, [two.sale_id]],
      );
      expect(settled.map(statusOf)).toEqual(["accepted", "refused"]);
      expect((await saleRow(two.sale_id))?.refusal).toBe("RO409");
      expect(await unitsOut(s.reward)).toBe(1);
      expect(await sums(other.enrollment)).toEqual({
        balance: "1000",
        ledger: "1000",
        redemptions: "0",
      });
    });

    it("one sale paid twice at once: one redemption, one redeem", async () => {
      const s = await setup();
      const sale = await offer(s.desk, s.event, s.player, s.reward);
      const settled = await race([s.player, PAY, [sale.sale_id]], [s.player, PAY, [sale.sale_id]]);
      expect(settled.map(statusOf)).toEqual(["accepted", "accepted"]);
      expect(await sums(s.enrollment)).toEqual({ balance: "800", ledger: "800", redemptions: "1" });
    });

    it("two operators offering the same player at once: one live offer, one desk_busy", async () => {
      const s = await setup();
      const desk2 = await newOperator(s.event);
      const v = await versionOf(s.player);
      const OFFER = "SELECT * FROM desk_offer_sale($1, $2, $3, $4, $5)";
      const settled = await race(
        [s.desk, OFFER, [s.event, s.player, v, s.reward, randomUUID()]],
        [desk2, OFFER, [s.event, s.player, v, s.reward, randomUUID()]],
      );
      expect(settled[0]?.status).toBe("fulfilled");
      expect(
        settled[1]?.status === "rejected" && (settled[1].reason as { detail?: string }).detail,
      ).toBe("desk_busy");
      expect(await salesOf(s.enrollment)).toBe(1);
    });

    it("an in-app digital purchase and a desk Pay with points for one: one wins", async () => {
      const s = await setup({}, 300);
      const digital = await newReward(s.event, "digital", 200, 1);
      await owner(
        `INSERT INTO reward_code (organizer_id, event_id, reward_id, code_cipher, code_hash)
         VALUES ($1, $2, $3, decode(repeat('ab', 40), 'hex'), decode(repeat('ef', 32), 'hex'))`,
        [ids.orgA, s.event, digital],
      );
      const sale = await offer(s.desk, s.event, s.player, s.reward);
      const settled = await race(
        [s.player, "SELECT * FROM reserve_reward($1, $2)", [digital, randomUUID()]],
        [s.player, PAY, [sale.sale_id]],
      );
      expect(settled.map(statusOf)).toEqual(["delivered", "refused"]);
      expect((await saleRow(sale.sale_id))?.refusal).toBe("RB422");
      expect(await sums(s.enrollment)).toEqual({ balance: "100", ledger: "100", redemptions: "1" });
    });

    it("reservation flipped On while a Pay runs: the sale is whole or nothing", async () => {
      const s = await setup();
      const sale = await offer(s.desk, s.event, s.player, s.reward);
      const flip = await db.owner
        .query("BEGIN")
        .then(() =>
          db.owner.query("UPDATE event SET reservation_on = true WHERE id = $1", [s.event]),
        );
      expect(flip.rowCount).toBe(1);
      const paid = await pay(s.player, sale.sale_id);
      await db.owner.query("COMMIT");
      expect(paid.status).toBe("accepted");
      const after = await sums(s.enrollment);
      expect(after?.balance).toBe(after?.ledger);
      expect(await unitsOut(s.reward)).toBe(Number(after?.redemptions));
      const late = await offer(s.desk, s.event, s.player, s.reward).catch(
        (error: { code: string }) => error.code,
      );
      expect(late).toBe("DS409");
    });
  });

  describe("another organizer", () => {
    it("cannot list, offer, poll or withdraw in another organizer's event, nor pay or decline its sale", async () => {
      const s = await setup();
      const sale = await offer(s.desk, s.event, s.player, s.reward);
      counter += 1;
      const [eventB] = await owner<{ id: string }>(
        `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at, desk_location_en)
         VALUES ($1, $2, 'B Fest', 'live', now() - interval '1 hour', now() + interval '1 day', 'Hall') RETURNING id`,
        [ids.orgB, `SALEB${counter}`],
      );
      const [opB] = await owner<{ id: string }>(
        "INSERT INTO player (username) VALUES ($1) RETURNING id",
        [`sale_op_b_${counter}`],
      );
      await owner(
        "INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities) VALUES ($1, $2, $3, '{hand_over}')",
        [ids.orgB, eventB?.id, opB?.id],
      );
      const playerB = opB?.id ?? "";
      const v = await versionOf(s.player);
      for (const [sql, values] of [
        ["SELECT * FROM desk_sale_rewards($1, $2, $3)", [s.event, s.player, v]],
        ["SELECT * FROM desk_offer_sale($1, $2, $3, $4, 'k')", [s.event, s.player, v, s.reward]],
        ["SELECT * FROM desk_sale_state($1)", [sale.sale_id]],
        ["SELECT withdraw_desk_sale($1)", [sale.sale_id]],
      ] as const) {
        expect(await refusal(call(playerB, sql, [...values])), sql).toBe("OP403");
      }
      expect(await refusal(pay(playerB, sale.sale_id))).toBe("RN404");
      expect(await refusal(call(playerB, "SELECT decline_desk_sale($1)", [sale.sale_id]))).toBe(
        "RN404",
      );
      expect((await saleRow(sale.sale_id))?.status).toBe("offered");
    });
  });

  describe("rehearsal and erasure", () => {
    it("a rehearsal account buys with the desk closed, and the wipe removes the sale and its redemption", async () => {
      const event = await newEvent({
        status: "draft",
        hours: "{[2020-01-01 10:00+00,2020-01-01 12:00+00)}",
      });
      await owner(
        "INSERT INTO event_rehearsal (event_id, organizer_id, code) VALUES ($1, $2, 'ABCD-EFGH')",
        [event, ids.orgA],
      );
      const desk = await newOperator(event);
      const who = await newPlayer(event, 500, "rehearsal");
      const reward = await newReward(event);
      const paid = await pay(who.player, (await offer(desk, event, who.player, reward)).sale_id);
      expect(paid.status).toBe("accepted");
      await owner("SELECT wipe_rehearsal($1, 'go_live', NULL)", [event]);
      expect(await owner("SELECT 1 FROM desk_sale WHERE event_id = $1", [event])).toEqual([]);
      expect(await owner("SELECT 1 FROM redemption WHERE event_id = $1", [event])).toEqual([]);
      expect(await unitsOut(reward)).toBe(0);
    });

    it("erasing an operator withdraws their live offers; erasing a player removes their sales", async () => {
      const s = await setup();
      const sale = await offer(s.desk, s.event, s.player, s.reward);
      await owner("SELECT erase_rows($1, '{}'::uuid[], NULL)", [s.desk]);
      expect((await saleRow(sale.sale_id))?.status).toBe("withdrawn");
      const desk2 = await newOperator(s.event);
      await pay(s.player, (await offer(desk2, s.event, s.player, s.reward)).sale_id);
      await owner("SELECT erase_rows($1, ARRAY[$2]::uuid[], NULL)", [s.player, s.enrollment]);
      expect(await salesOf(s.enrollment)).toBe(0);
      expect(
        await owner("SELECT status FROM redemption WHERE enrollment_id = $1", [s.enrollment]),
      ).toEqual([{ status: "handed_over" }]);
    });
  });
});
