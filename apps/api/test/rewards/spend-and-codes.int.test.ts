import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext } from "#src/db/context";
import {
  TEST_DATABASE_URL,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

type Reserved = {
  redemption_id: string;
  kind: string;
  status: string;
  reserved_until: Date | null;
  balance: string;
  stock_left: number;
  replayed: boolean;
  code_cipher: Buffer | null;
};

const cipher = () => randomBytes(48);

const refusal = async (work: Promise<unknown>): Promise<{ code: string; detail?: string }> => {
  try {
    await work;
  } catch (error) {
    const { code, detail } = error as { code: string; detail?: string };
    return detail === undefined ? { code } : { code, detail };
  }
  throw new Error("expected a refusal");
};

describe.skipIf(TEST_DATABASE_URL === undefined)(
  "spending lowers rank (T-219) and digital codes (T-203)",
  () => {
    let db: TestDatabase;
    let pool: Pool;
    let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
    let counter = 0;
    let ownerA = "";
    let editorA = "";

    beforeAll(async () => {
      db = await createTestDatabase();
      pool = new Pool({ connectionString: db.appUrl, max: 24 });
      ids = await seedTwoTenants(db.owner);
      for (const [email, role] of [
        ["owner@najd.sa", "owner"],
        ["editor@najd.sa", "editor"],
      ] as const) {
        const [staff] = (
          await db.owner.query<{ id: string }>(
            "INSERT INTO staff_user (email, password_hash) VALUES ($1, 'h') RETURNING id",
            [email],
          )
        ).rows;
        await db.owner.query(
          "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, $3)",
          [ids.orgA, staff?.id, role],
        );
        if (role === "owner") {
          ownerA = staff?.id ?? "";
        } else {
          editorA = staff?.id ?? "";
        }
      }
    });
    afterAll(async () => {
      await pool.end();
      await db.close();
    });

    const owner = async <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
      (await db.owner.query<T>(sql, values)).rows;

    /** An event of organizer A; live by default, or ended an hour ago with the shop still open. */
    const newEvent = async (
      shape: Readonly<{ when?: "live" | "ended" | "scheduled"; spendLowersRank?: boolean }> = {},
    ): Promise<string> => {
      counter += 1;
      const times = {
        live: ["live", "now() - interval '1 hour'", "now() + interval '1 day'"],
        ended: ["live", "now() - interval '2 days'", "now() - interval '1 hour'"],
        scheduled: ["scheduled", "now() + interval '1 day'", "now() + interval '2 days'"],
      }[shape.when ?? "live"];
      const [row] = await owner<{ id: string }>(
        `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at, spend_lowers_rank)
       VALUES ($1, $2, 'Spend', '${times[0]}', ${times[1]}, ${times[2]}, $3) RETURNING id`,
        [ids.orgA, `SPEND${counter}`, shape.spendLowersRank ?? false],
      );
      return row?.id ?? "";
    };

    /** A player in `event` with `points` earned the way a quest pays them. */
    const newPlayer = async (event: string, points = 1000) => {
      counter += 1;
      const [player] = await owner<{ id: string }>(
        "INSERT INTO player (username) VALUES ($1) RETURNING id",
        [`spender_${counter}`],
      );
      const [enrolled] = await owner<{ id: string }>(
        "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3) RETURNING id",
        [ids.orgA, event, player?.id],
      );
      let [category] = await owner<{ id: string }>("SELECT id FROM category WHERE event_id = $1", [
        event,
      ]);
      category ??= (
        await owner<{ id: string }>(
          "INSERT INTO category (event_id, name_en) VALUES ($1, 'General') RETURNING id",
          [event],
        )
      )[0];
      const [quest] = await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points) VALUES ($1, $2, 'scan_qr', 'Q', $3)
       RETURNING id`,
        [event, category?.id, points],
      );
      const [done] = await owner<{ id: string }>(
        `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                     idempotency_key)
       VALUES ($1, $2, $3, $4, 1, 'qr', $5) RETURNING id`,
        [ids.orgA, event, enrolled?.id, quest?.id, randomUUID()],
      );
      await owner(
        `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                 completion_id, quest_id, actor)
       VALUES ($1, $2, $3, 'quest', $4, $4, $5, $6, 'player')`,
        [ids.orgA, event, enrolled?.id, points, done?.id, quest?.id],
      );
      return { player: player?.id ?? "", enrollment: enrolled?.id ?? "" };
    };

    const newReward = async (
      event: string,
      fields: Readonly<{ kind?: string; price?: number; stock?: number; limit?: number }> = {},
    ): Promise<string> => {
      const [row] = await owner<{ id: string }>(
        `INSERT INTO reward (event_id, kind, name_en, price, stock_total, per_player_limit)
       VALUES ($1, $2, 'Voucher', $3, $4, $5) RETURNING id`,
        [
          event,
          fields.kind ?? "item",
          fields.price ?? 100,
          fields.stock ?? (fields.kind === "digital" ? 0 : 5),
          fields.limit ?? null,
        ],
      );
      return row?.id ?? "";
    };

    const asPlayer = async <T>(player: string, work: (client: PoolClient) => Promise<T>) => {
      const client = await pool.connect();
      try {
        return await withRequestContext(client, { playerId: player }, () => work(client));
      } finally {
        client.release();
      }
    };

    const asStaff = async <T>(staff: string, work: (client: PoolClient) => Promise<T>) => {
      const client = await pool.connect();
      try {
        return await withRequestContext(client, { organizerId: ids.orgA, staffUserId: staff }, () =>
          work(client),
        );
      } finally {
        client.release();
      }
    };

    const reserve = (player: string, reward: string, key = randomUUID()) =>
      asPlayer(player, async (client) => {
        const { rows } = await client.query<Reserved>("SELECT * FROM reserve_reward($1, $2)", [
          reward,
          key,
        ]);
        return rows[0] as Reserved;
      });

    const cancel = (player: string, redemption: string) =>
      asPlayer(player, (client) =>
        client.query("SELECT * FROM cancel_redemption($1)", [redemption]),
      );

    const addCodes = (staff: string, reward: string, codes: readonly Buffer[]) =>
      asStaff(staff, async (client) => {
        const hashes = codes.map(() => randomBytes(32));
        const { rows } = await client.query<{
          added: number;
          duplicates: number;
          stock_total: number;
          stock_left: number;
        }>("SELECT * FROM add_reward_codes($1, $2, $3)", [reward, codes, hashes]);
        return rows[0];
      });

    const sums = async (enrollment: string) =>
      (
        await owner<{
          score: string;
          balance: string;
          ledger_score: string;
          ledger_balance: string;
        }>(
          `SELECT n.score, n.balance,
                (SELECT coalesce(sum(score_delta), 0) FROM ledger_entry WHERE enrollment_id = n.id) AS ledger_score,
                (SELECT coalesce(sum(balance_delta), 0) FROM ledger_entry WHERE enrollment_id = n.id) AS ledger_balance
         FROM enrollment n WHERE n.id = $1`,
          [enrollment],
        )
      )[0];

    const marked = async (event: string) =>
      (await owner("SELECT 1 FROM ranking_repair WHERE event_id = $1", [event])).length === 1;
    const clearMarks = () => owner("DELETE FROM ranking_repair");

    const setting = (staff: string, event: string, value: boolean) =>
      asStaff(staff, (client) =>
        client.query("UPDATE event SET spend_lowers_rank = $2 WHERE id = $1", [event, value]),
      );

    const addWithHashes = (target: string, hashes: Buffer[]) =>
      asStaff(editorA, async (client) => {
        const { rows } = await client.query("SELECT * FROM add_reward_codes($1, $2, $3)", [
          target,
          hashes.map(() => cipher()),
          hashes,
        ]);
        return rows[0];
      });

    describe("the setting (FR-1847)", () => {
      it("lets the owner change it before the event is live, and no one else", async () => {
        const event = await newEvent({ when: "scheduled" });
        expect(await refusal(setting(editorA, event, true))).toEqual({ code: "QO403" });
        await setting(ownerA, event, true);
        expect(
          (await owner("SELECT spend_lowers_rank FROM event WHERE id = $1", [event]))[0],
        ).toEqual({
          spend_lowers_rank: true,
        });
      });

      it("lets an editor save the same value, so the other shop settings stay theirs", async () => {
        const event = await newEvent({ spendLowersRank: true });
        const result = await setting(editorA, event, true);
        expect(result.rowCount).toBe(1);
      });

      it("locks it once the event is live or ended, for the owner too", async () => {
        for (const when of ["live", "ended"] as const) {
          const event = await newEvent({ when });
          expect(await refusal(setting(ownerA, event, true))).toEqual({ code: "QE409" });
        }
      });

      it("leaves the owner connection free (support)", async () => {
        const event = await newEvent();
        await owner("UPDATE event SET spend_lowers_rank = true WHERE id = $1", [event]);
      });
    });

    describe("spending and the score (ADR-134, ADR-135)", () => {
      it("leaves the score alone when the option is off", async () => {
        const event = await newEvent();
        const { player, enrollment } = await newPlayer(event, 500);
        await clearMarks();
        await reserve(player, await newReward(event, { price: 100 }));
        expect(await sums(enrollment)).toEqual({
          score: "500",
          balance: "400",
          ledger_score: "500",
          ledger_balance: "400",
        });
        expect(await marked(event)).toBe(false);
      });

      it("lowers the score with the balance when on, and a cancel brings both back", async () => {
        const event = await newEvent({ spendLowersRank: true });
        const { player, enrollment } = await newPlayer(event, 500);
        await clearMarks();
        const made = await reserve(player, await newReward(event, { price: 100 }));
        expect(await sums(enrollment)).toEqual({
          score: "400",
          balance: "400",
          ledger_score: "400",
          ledger_balance: "400",
        });
        expect(await marked(event)).toBe(true);
        await clearMarks();
        await cancel(player, made.redemption_id);
        expect(await sums(enrollment)).toEqual({
          score: "500",
          balance: "500",
          ledger_score: "500",
          ledger_balance: "500",
        });
        expect(await marked(event)).toBe(true);
      });

      it("moves only the balance after the end, while the shop stays open", async () => {
        const event = await newEvent({ when: "ended", spendLowersRank: true });
        const { player, enrollment } = await newPlayer(event, 500);
        await reserve(player, await newReward(event, { price: 100 }));
        expect(await sums(enrollment)).toMatchObject({ score: "500", balance: "400" });
      });

      it("returns what the payment took, even if the setting changed in between", async () => {
        const on = await newEvent({ spendLowersRank: true });
        const first = await newPlayer(on, 500);
        const paidOn = await reserve(first.player, await newReward(on, { price: 100 }));
        await owner("UPDATE event SET spend_lowers_rank = false WHERE id = $1", [on]);
        await cancel(first.player, paidOn.redemption_id);
        expect(await sums(first.enrollment)).toMatchObject({ score: "500", balance: "500" });

        const off = await newEvent();
        const second = await newPlayer(off, 500);
        const paidOff = await reserve(second.player, await newReward(off, { price: 100 }));
        await owner("UPDATE event SET spend_lowers_rank = true WHERE id = $1", [off]);
        await cancel(second.player, paidOff.redemption_id);
        expect(await sums(second.enrollment)).toMatchObject({ score: "500", balance: "500" });
      });

      it("gives the score back on the timeout and marks the ranking from the system", async () => {
        const event = await newEvent({ spendLowersRank: true });
        const { player, enrollment } = await newPlayer(event, 300);
        const made = await reserve(player, await newReward(event, { price: 100 }));
        await owner(
          "UPDATE redemption SET reserved_until = now() - interval '1 minute' WHERE id = $1",
          [made.redemption_id],
        );
        await clearMarks();
        const client = await pool.connect();
        try {
          let outcome: string | null = "expired";
          while (outcome !== null) {
            outcome = await withRequestContext(client, {}, async () => {
              const { rows } = await client.query<{ outcome: string | null }>(
                "SELECT expire_one_reservation() AS outcome",
              );
              return rows[0]?.outcome ?? null;
            });
          }
        } finally {
          client.release();
        }
        expect(await sums(enrollment)).toMatchObject({ score: "300", balance: "300" });
        expect(await marked(event)).toBe(true);
      });

      it("marks the ranking when a player who left cancels", async () => {
        const event = await newEvent({ spendLowersRank: true });
        const { player, enrollment } = await newPlayer(event, 300);
        const made = await reserve(player, await newReward(event, { price: 100 }));
        await owner("UPDATE enrollment SET status = 'left' WHERE id = $1", [enrollment]);
        await clearMarks();
        await cancel(player, made.redemption_id);
        expect(await marked(event)).toBe(true);
      });

      it("keeps the score at least the balance in both modes, so it never goes below zero", async () => {
        for (const spendLowersRank of [false, true]) {
          const event = await newEvent({ spendLowersRank });
          const { player, enrollment } = await newPlayer(event, 300);
          const reward = await newReward(event, { price: 100 });
          for (let i = 0; i < 3; i += 1) {
            await reserve(player, reward);
          }
          expect(await refusal(reserve(player, reward))).toEqual({ code: "RB422" });
          const after = await sums(enrollment);
          expect(Number(after?.score)).toBeGreaterThanOrEqual(Number(after?.balance));
          expect(after).toMatchObject({ balance: "0", score: spendLowersRank ? "0" : "300" });
        }
      });

      it("tells the player whether a purchase now lowers their ranking points", async () => {
        const flags: boolean[] = [];
        for (const shape of [
          { spendLowersRank: true },
          { when: "ended", spendLowersRank: true },
          {},
        ] as const) {
          const event = await newEvent(shape);
          const { player } = await newPlayer(event);
          flags.push(
            await asPlayer(player, async (client) => {
              const { rows } = await client.query<{ spend_lowers_rank: boolean }>(
                "SELECT spend_lowers_rank FROM event_shop($1)",
                [event],
              );
              return rows[0]?.spend_lowers_rank ?? false;
            }),
          );
        }
        expect(flags).toEqual([true, false, false]);
      });
    });

    describe("digital codes (FR-510, FR-511)", () => {
      it("starts a digital reward at zero stock and keeps its stock for the codes", async () => {
        const event = await newEvent();
        const insert = (stock: number) =>
          asStaff(ownerA, (client) =>
            client.query(
              "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, 'digital', 'Code', 10, $2) RETURNING id",
              [event, stock],
            ),
          );
        expect(await refusal(insert(5))).toEqual({ code: "RD409" });
        const made = await insert(0);
        const reward = String(made.rows[0]?.["id"]);
        expect(
          await refusal(
            asStaff(ownerA, (client) =>
              client.query("UPDATE reward SET stock_total = 9 WHERE id = $1", [reward]),
            ),
          ),
        ).toEqual({ code: "RD409" });
      });

      it("adds codes, raising the stock by what was new and skipping repeats in the event", async () => {
        const event = await newEvent();
        const reward = await newReward(event, { kind: "digital" });
        const other = await newReward(event, { kind: "digital" });
        const hash = randomBytes(32);
        const add = addWithHashes;
        expect(await add(reward, [hash, randomBytes(32), randomBytes(32)])).toEqual({
          added: 3,
          duplicates: 0,
          stock_total: 3,
          stock_left: 3,
        });
        expect(await add(reward, [hash, randomBytes(32)])).toMatchObject({
          added: 1,
          duplicates: 1,
          stock_total: 4,
        });
        expect(await add(other, [hash])).toMatchObject({ added: 0, duplicates: 1, stock_total: 0 });
      });

      it("refuses codes for an item, a removed reward, another organizer's or a player", async () => {
        const event = await newEvent();
        const item = await newReward(event);
        expect(await refusal(addCodes(ownerA, item, [cipher()]))).toEqual({ code: "RD409" });
        const removed = await newReward(event, { kind: "digital" });
        await owner("UPDATE reward SET status = 'removed' WHERE id = $1", [removed]);
        expect(await refusal(addCodes(ownerA, removed, [cipher()]))).toEqual({ code: "RN404" });
        const theirs = (
          await owner<{ id: string }>(
            "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, 'digital', 'B', 1, 0) RETURNING id",
            [ids.eventB],
          )
        )[0]?.id;
        expect(await refusal(addCodes(ownerA, theirs ?? "", [cipher()]))).toEqual({
          code: "RN404",
        });
        const { player } = await newPlayer(event);
        const mine = await newReward(event, { kind: "digital" });
        expect(
          await refusal(
            asPlayer(player, (client) =>
              client.query("SELECT * FROM add_reward_codes($1, $2, $3)", [
                mine,
                [cipher()],
                [randomBytes(32)],
              ]),
            ),
          ),
        ).toEqual({ code: "RN404" });
      });

      it("refuses more than 100 000 codes on one reward", async () => {
        const event = await newEvent();
        const reward = await newReward(event, { kind: "digital" });
        await owner("UPDATE reward SET stock_total = 99999 WHERE id = $1", [reward]);
        expect(await refusal(addCodes(ownerA, reward, [cipher(), cipher()]))).toEqual({
          code: "RC422",
          detail: "1",
        });
      });

      it("hands out one code at once, for good, and shows it again on a replay and in history", async () => {
        const event = await newEvent();
        const reward = await newReward(event, { kind: "digital", price: 50 });
        const codes = [cipher(), cipher()];
        await addCodes(ownerA, reward, codes);
        const { player } = await newPlayer(event);
        const key = randomUUID();
        const made = await reserve(player, reward, key);
        expect(made).toMatchObject({
          kind: "digital",
          status: "delivered",
          reserved_until: null,
          stock_left: 1,
        });
        expect(made.code_cipher?.equals(codes[0] as Buffer)).toBe(true);
        const again = await reserve(player, reward, key);
        expect(again.replayed).toBe(true);
        expect(again.code_cipher?.equals(codes[0] as Buffer)).toBe(true);
        const history = await asPlayer(player, async (client) => {
          const { rows } = await client.query<{ code_cipher: Buffer | null; status: string }>(
            "SELECT status, code_cipher FROM my_redemptions($1)",
            [event],
          );
          return rows;
        });
        expect(history).toHaveLength(1);
        expect(history[0]?.code_cipher?.equals(codes[0] as Buffer)).toBe(true);
        expect(await refusal(cancel(player, made.redemption_id))).toEqual({
          code: "RE409",
          detail: "delivered",
        });
      });

      it("never gives a code twice when many players redeem at once", async () => {
        const event = await newEvent();
        const reward = await newReward(event, { kind: "digital", price: 10 });
        await addCodes(
          ownerA,
          reward,
          Array.from({ length: 10 }, () => cipher()),
        );
        const players = await Promise.all(Array.from({ length: 20 }, () => newPlayer(event)));
        const results = await Promise.allSettled(
          players.map(({ player }) => reserve(player, reward)),
        );
        const won = results.filter(
          (r): r is PromiseFulfilledResult<Reserved> => r.status === "fulfilled",
        );
        expect(won).toHaveLength(10);
        const given = new Set(won.map((r) => r.value.code_cipher?.toString("hex")));
        expect(given.size).toBe(10);
        for (const lost of results.filter((r) => r.status === "rejected")) {
          expect((lost as PromiseRejectedResult).reason.code).toBe("RO409");
        }
        expect(
          await owner("SELECT 1 FROM reward_code WHERE reward_id = $1 AND redemption_id IS NULL", [
            reward,
          ]),
        ).toEqual([]);
      });

      it("counts delivered codes against the per-player limit", async () => {
        const event = await newEvent();
        const reward = await newReward(event, { kind: "digital", limit: 1 });
        await addCodes(ownerA, reward, [cipher(), cipher()]);
        const { player } = await newPlayer(event);
        await reserve(player, reward);
        expect(await refusal(reserve(player, reward))).toEqual({ code: "RL409", detail: "1" });
      });

      it("never delivers without a code when the stock and codes disagree", async () => {
        const event = await newEvent();
        const reward = await newReward(event, { kind: "digital" });
        await owner("UPDATE reward SET stock_total = 1 WHERE id = $1", [reward]);
        const { player, enrollment } = await newPlayer(event, 500);
        expect(await refusal(reserve(player, reward))).toEqual({ code: "RX500" });
        expect((await sums(enrollment))?.balance).toBe("500");
      });

      it("shows organizers which codes exist and are given, never a cipher or a hash", async () => {
        const event = await newEvent();
        const reward = await newReward(event, { kind: "digital" });
        await addCodes(ownerA, reward, [cipher()]);
        const read = (sql: string) => asStaff(ownerA, (client) => client.query(sql, [reward]));
        expect(
          (await read("SELECT id, redemption_id FROM reward_code WHERE reward_id = $1")).rowCount,
        ).toBe(1);
        for (const column of ["code_cipher", "code_hash", "organizer_id"]) {
          expect(
            (await refusal(read(`SELECT ${column} FROM reward_code WHERE reward_id = $1`))).code,
          ).toBe("42501");
        }
        expect(
          (await refusal(read("UPDATE reward_code SET redemption_id = NULL WHERE reward_id = $1")))
            .code,
        ).toBe("42501");
      });

      it("gives an outsider nothing", async () => {
        for (const sql of [
          "SELECT id FROM public.reward_code",
          `SELECT * FROM public.add_reward_codes('${randomUUID()}', ARRAY['\\x00'::bytea], ARRAY['\\x00'::bytea])`,
        ]) {
          expect((await refusal(db.outsider.query(sql))).code).toBe("42501");
        }
      });
    });
  },
);
