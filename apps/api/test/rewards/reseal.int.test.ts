import { createCipheriv, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { Pool, type Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withRequestContext } from "#src/db/context";
import {
  createRewardCodeKeyring,
  markCode,
  sealCode,
  type RewardCodeKeyring,
} from "#src/rewards/codes";
import { runRewardCodesCommand } from "#src/rewards/reward-codes-command";
import { checkCodes, resealCodes, type ResealOptions } from "#src/rewards/reseal";
import { readShop, reserveReward } from "#src/rewards/shop";
import {
  TEST_DATABASE_URL,
  addMember,
  connectAsOwner,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

const R = "r".repeat(32);
const S = "s".repeat(32);
const ring = (id: number, secret: string, previous?: { id: number; secret: string }) =>
  createRewardCodeKeyring({ current: { id, secret }, previous });
/** Before the rotation: today's secret as key 1. */
const OLD = ring(1, R);
/** During it: key 2 current, key 1 kept to open and re-seal. */
const ROTATED = ring(2, S, { id: 1, secret: R });
/** After it: key 2 alone. */
const NEW = ring(2, S);
/** Every code in this file starts with it, so a leak into output or the audit log is easy to spot. */
const SENTINEL = "SENTINEL";

/** A value sealed exactly as before T-810f: `iv ‖ tag ‖ ciphertext`, AAD = reward id, no header. */
function legacySeal(rewardId: string, code: string): Buffer {
  const key = Buffer.from(
    hkdfSync("sha256", R, "questify/reward-code", "questify/reward-code/v1/seal", 32),
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(rewardId));
  const body = Buffer.concat([cipher.update(code), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

/** The same connection, except that a ROLLBACK runs and then raises, as one on a dying connection would. */
const rollbackRefused = (client: Client): Client =>
  new Proxy(client, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (property !== "query" || typeof value !== "function") {
        return value;
      }
      return async (...args: unknown[]) => {
        const result: unknown = await Reflect.apply(value, target, args);
        if (args[0] === "ROLLBACK") {
          throw new Error("rollback refused");
        }
        return result;
      };
    },
  });

/** The same connection, except that writing an audit entry raises once `refused()` answers true. */
const auditRefused = (client: Client, refused: () => boolean): Client =>
  new Proxy(client, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (property !== "query" || typeof value !== "function") {
        return value;
      }
      return async (...args: unknown[]) => {
        if (refused() && String(args[0]).includes("INSERT INTO audit_log")) {
          throw new Error("audit refused");
        }
        return Reflect.apply(value, target, args) as unknown;
      };
    },
  });

const refusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    return (error as { code?: string }).code ?? (error as Error).message;
  }
  throw new Error("expected a refusal");
};

describe.skipIf(TEST_DATABASE_URL === undefined)("reward code rotation (T-810f)", () => {
  let db: TestDatabase;
  let pool: Pool;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let staff = "";
  let counter = 0;
  const log: Record<string, unknown>[] = [];

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new Pool({ connectionString: db.appUrl, max: 6 });
    ids = await seedTwoTenants(db.owner);
    staff = await addMember(db.owner, ids.orgA, "owner");
  });
  afterAll(async () => {
    await pool.end();
    await db.close();
  });

  const owner = async <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  /** The RUNBOOK's statement for a re-seal conflict (Rotating REWARD_CODE_SECRET, step 2). */
  const removeUnused = (id: string) =>
    db.owner.query(
      `WITH gone AS (
         DELETE FROM reward_code WHERE id = $1 AND redemption_id IS NULL RETURNING reward_id
       )
       UPDATE reward SET stock_total = stock_total - 1 WHERE id IN (SELECT reward_id FROM gone)`,
      [id],
    );
  const stockOf = async (reward: string) =>
    (
      await owner<{ stock_total: number }>("SELECT stock_total FROM reward WHERE id = $1", [reward])
    )[0]?.stock_total;

  const newReward = async (): Promise<string> => {
    const [row] = await owner<{ id: string }>(
      "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, 'digital', 'Card', 10, 0) RETURNING id",
      [ids.eventA],
    );
    return row?.id ?? "";
  };

  /** A code row written straight in, as an older release or the rotation redeploy would have left it. */
  const plant = async (reward: string, sealed: Buffer, mark: Buffer): Promise<string> => {
    const [row] = await owner<{ id: string }>(
      `INSERT INTO reward_code (organizer_id, event_id, reward_id, code_cipher, code_hash)
       VALUES ($1, $2, $3, $4, $5) RETURNING id::text`,
      [ids.orgA, ids.eventA, reward, sealed, mark],
    );
    await owner("UPDATE reward SET stock_total = stock_total + 1 WHERE id = $1", [reward]);
    return row?.id ?? "";
  };
  const plantLegacy = (reward: string, code: string) =>
    plant(reward, legacySeal(reward, code), markCode(OLD.current, code));
  const plantUnder = (keys: RewardCodeKeyring, reward: string, code: string) =>
    plant(reward, sealCode(keys, reward, code), markCode(keys.current, code));

  const upload = (reward: string, codes: readonly string[], keys: RewardCodeKeyring) => {
    const previous = keys.previous;
    return pool.connect().then(async (client) => {
      try {
        return await withRequestContext(
          client,
          { organizerId: ids.orgA, staffUserId: staff },
          async () =>
            (
              await client.query<{ added: number; duplicates: number }>(
                "SELECT added, duplicates FROM add_reward_codes($1, $2, $3, $4)",
                [
                  reward,
                  codes.map((code) => sealCode(keys, reward, code)),
                  codes.map((code) => markCode(keys.current, code)),
                  previous === undefined ? [] : codes.map((code) => markCode(previous, code)),
                ],
              )
            ).rows[0],
        );
      } finally {
        client.release();
      }
    });
  };

  const newPlayer = async (points = 1000): Promise<string> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`resealer_${counter}`],
    );
    const [enrolled] = await owner<{ id: string }>(
      "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3) RETURNING id",
      [ids.orgA, ids.eventA, player?.id],
    );
    const [category] = await owner<{ id: string }>(
      "SELECT id FROM category WHERE event_id = $1 LIMIT 1",
      [ids.eventA],
    );
    const [quest] = await owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points) VALUES ($1, $2, 'scan_qr', 'Q', $3)
       RETURNING id`,
      [ids.eventA, category?.id, points],
    );
    const [done] = await owner<{ id: string }>(
      `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                     idempotency_key)
       VALUES ($1, $2, $3, $4, 1, 'qr', $5) RETURNING id`,
      [ids.orgA, ids.eventA, enrolled?.id, quest?.id, randomUUID()],
    );
    await owner(
      `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                 completion_id, quest_id, actor)
       VALUES ($1, $2, $3, 'quest', $4, $4, $5, $6, 'player')`,
      [ids.orgA, ids.eventA, enrolled?.id, points, done?.id, quest?.id],
    );
    return player?.id ?? "";
  };

  const shopDeps = (keys: RewardCodeKeyring) => ({
    pool,
    codeKey: keys,
    log: (fields: Record<string, unknown>) => void log.push(fields),
  });
  const buy = async (keys: RewardCodeKeyring, player: string, reward: string) => {
    const result = await reserveReward(shopDeps(keys), {
      playerId: player,
      rewardId: reward,
      idempotencyKey: randomUUID(),
    });
    return result.kind === "done" ? result.value.redemption : undefined;
  };
  const history = async (keys: RewardCodeKeyring, player: string) =>
    (await readShop(shopDeps(keys), { playerId: player, eventId: ids.eventA }))?.redemptions.map(
      (row) => row["code"] ?? (row["codeUnavailable"] === true ? "unavailable" : "none"),
    );

  const reseal = (keys: RewardCodeKeyring, options: Partial<ResealOptions> = {}) =>
    resealCodes(db.owner, keys, { by: "test-operator", ...options });

  const auditsOf = () =>
    owner<{ action: string; after: Record<string, unknown> }>(
      "SELECT action, after FROM audit_log WHERE action LIKE 'reward.codes.reseal%' ORDER BY id",
    );

  describe("add_reward_codes with prior marks (migration 0157)", () => {
    it("skips a code whose mark under the previous key is in the event, and adds the rest", async () => {
      const reward = await newReward();
      await plantLegacy(reward, `${SENTINEL}-A`);
      expect(await upload(reward, [`${SENTINEL}-A`, `${SENTINEL}-B`], ROTATED)).toEqual({
        added: 1,
        duplicates: 1,
      });
      expect(await upload(reward, [`${SENTINEL}-A`], NEW)).toEqual({ added: 1, duplicates: 0 });
    });

    it("behaves as before with no prior marks, through the 3-argument call too", async () => {
      const reward = await newReward();
      expect(await upload(reward, [`${SENTINEL}-C`], OLD)).toEqual({ added: 1, duplicates: 0 });
      expect(await upload(reward, [`${SENTINEL}-C`], OLD)).toEqual({ added: 0, duplicates: 1 });
      const client = await pool.connect();
      try {
        const row = await withRequestContext(
          client,
          { organizerId: ids.orgA, staffUserId: staff },
          async () =>
            (
              await client.query("SELECT added, duplicates FROM add_reward_codes($1, $2, $3)", [
                reward,
                [sealCode(OLD, reward, `${SENTINEL}-D`), sealCode(OLD, reward, `${SENTINEL}-C`)],
                [markCode(OLD.current, `${SENTINEL}-D`), markCode(OLD.current, `${SENTINEL}-C`)],
              ])
            ).rows[0],
        );
        expect(row).toEqual({ added: 1, duplicates: 1 });
      } finally {
        client.release();
      }
    });

    it("refuses prior marks that do not pair up or are not 32 bytes", async () => {
      const reward = await newReward();
      const call = (priors: (Buffer | null)[]) =>
        pool.connect().then(async (client) => {
          try {
            return await withRequestContext(
              client,
              { organizerId: ids.orgA, staffUserId: staff },
              () =>
                client.query("SELECT * FROM add_reward_codes($1, $2, $3, $4)", [
                  reward,
                  [randomBytes(40), randomBytes(40)],
                  [randomBytes(32), randomBytes(32)],
                  priors,
                ]),
            );
          } finally {
            client.release();
          }
        });
      for (const priors of [
        [randomBytes(32)],
        [randomBytes(32), randomBytes(32), randomBytes(32)],
        [randomBytes(32), randomBytes(31)],
        [randomBytes(33), randomBytes(32)],
        [randomBytes(32), null],
      ]) {
        expect(await refusal(call(priors))).toBe("22023");
      }
      expect((await call([randomBytes(32), randomBytes(32)])).rows[0]).toMatchObject({
        added: 2,
      });
    });

    it("has one signature, executable by the API's role only", async () => {
      const found = await owner<{ args: string; acl: string }>(
        `SELECT pg_get_function_identity_arguments(oid) AS args, proacl::text AS acl FROM pg_proc
          WHERE proname = 'add_reward_codes' AND pronamespace = 'public'::regnamespace`,
      );
      expect(found.map((row) => row.args)).toEqual([
        "target uuid, ciphers bytea[], hashes bytea[], prior_hashes bytea[]",
      ]);
      expect(found[0]?.acl).not.toMatch(/[{,]=X/);
      const [rights] = await owner<{ app: boolean; outsider: boolean }>(
        `SELECT has_function_privilege('questify_app', 'add_reward_codes(uuid, bytea[], bytea[], bytea[])', 'EXECUTE') AS app,
                has_function_privilege('questify_outsider', 'add_reward_codes(uuid, bytea[], bytea[], bytea[])', 'EXECUTE') AS outsider`,
      );
      expect(rights).toEqual({ app: true, outsider: false });
      expect(
        await refusal(
          db.outsider.query(
            `SELECT * FROM public.add_reward_codes('${randomUUID()}', ARRAY['\\x00'::bytea], ARRAY['\\x00'::bytea], '{}')`,
          ),
        ),
      ).toBe("42501");
    });
  });

  /** Runs `work` while every update of one reward_code row raises SQLSTATE P0001, with a detail that holds a code. */
  const withRefusedUpdate = async <T>(id: string, work: () => Promise<T>): Promise<T> => {
    await owner(`CREATE FUNCTION test_refuse_reseal() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'refused' USING ERRCODE = 'P0001', DETAIL = 'detail-${SENTINEL}'; END $$`);
    await owner(
      `CREATE TRIGGER test_refuse_reseal BEFORE UPDATE ON reward_code FOR EACH ROW
         WHEN (OLD.id = ${id}) EXECUTE FUNCTION test_refuse_reseal()`,
    );
    try {
      return await work();
    } finally {
      await owner("DROP TRIGGER test_refuse_reseal ON reward_code");
      await owner("DROP FUNCTION test_refuse_reseal()");
    }
  };

  describe("the re-seal", () => {
    beforeEach(async () => {
      await owner("DELETE FROM reward_code");
      log.length = 0;
    });

    it("re-seals every code after a rotation so each reveals with the new key alone, then does nothing", async () => {
      const reward = await newReward();
      for (const code of ["L-1", "L-2", "L-3"]) {
        await plantLegacy(reward, `${SENTINEL}-${code}`);
      }
      await plantUnder(OLD, reward, `${SENTINEL}-N-1`);
      const early = await newPlayer();
      expect(await buy(OLD, early, reward)).toMatchObject({ code: `${SENTINEL}-L-1` });
      expect(await checkCodes(db.owner, ROTATED)).toMatchObject({ current: 0, stale: 4 });

      const first = await reseal(ROTATED);
      expect(first).toMatchObject({ current: 0, resealed: 4, unreadable: 0, conflict: 0 });
      expect(await checkCodes(db.owner, NEW)).toEqual({ current: 4, stale: 0, ids: [] });
      const marks = await owner<{ key_id: number; code_hash: Buffer; reward_id: string }>(
        "SELECT get_byte(code_cipher, 2) AS key_id, code_hash FROM reward_code ORDER BY id",
      );
      expect(marks.map((row) => row.key_id)).toEqual([2, 2, 2, 2]);
      expect(marks.map((row) => row.code_hash.toString("hex"))).toEqual(
        ["L-1", "L-2", "L-3", "N-1"].map((code) =>
          markCode(NEW.current, `${SENTINEL}-${code}`).toString("hex"),
        ),
      );

      expect(await history(NEW, early)).toEqual([`${SENTINEL}-L-1`]);
      const later = await newPlayer();
      for (const code of ["L-2", "L-3", "N-1"]) {
        expect(await buy(NEW, later, reward)).toMatchObject({ code: `${SENTINEL}-${code}` });
      }
      expect(log).toEqual([]);

      const second = await reseal(ROTATED);
      expect(second).toMatchObject({ current: 4, resealed: 0, unreadable: 0, changed: 0 });
      const audits = await auditsOf();
      expect(audits.map((row) => row.action)).toEqual([
        "reward.codes.reseal_start",
        "reward.codes.reseal",
        "reward.codes.reseal_start",
        "reward.codes.reseal",
      ]);
      expect(audits[1]?.after).toEqual({
        keyId: 2,
        by: "test-operator",
        current: 0,
        resealed: 4,
        unreadable: 0,
        conflict: 0,
        changed: 0,
        finished: true,
      });
      const leaked = JSON.stringify([first, second, await owner("SELECT * FROM audit_log")]);
      expect(leaked).not.toContain(SENTINEL);
      for (const row of marks) {
        expect(leaked).not.toContain(row.code_hash.toString("hex"));
      }
    });

    it("finishes a stopped run on the next one, and the stopped run leaves its counts", async () => {
      const reward = await newReward();
      for (let n = 0; n < 5; n += 1) {
        await plantLegacy(reward, `${SENTINEL}-S-${n}`);
      }
      const before = (await auditsOf()).length;
      const stopped = reseal(ROTATED, {
        batchSize: 2,
        afterBatch: () => Promise.reject(new Error("operator pressed Ctrl+C")),
      });
      await expect(stopped).rejects.toThrow("operator pressed Ctrl+C");
      const trail = (await auditsOf()).slice(before);
      expect(
        trail.map((row) => [row.action, row.after["finished"], row.after["resealed"]]),
      ).toEqual([
        ["reward.codes.reseal_start", undefined, undefined],
        ["reward.codes.reseal", false, 2],
      ]);
      expect(await reseal(ROTATED, { batchSize: 2 })).toMatchObject({ current: 2, resealed: 3 });
      expect(await checkCodes(db.owner, NEW)).toMatchObject({ current: 5, stale: 0 });
    });

    it("reports a code twice in one event by row id, leaves it, and the command exits 1", async () => {
      const reward = await newReward();
      await plantUnder(ROTATED, reward, `${SENTINEL}-TWICE`);
      const legacy = await plantLegacy(reward, `${SENTINEL}-TWICE`);
      const lines: string[] = [];
      const exit = await runRewardCodesCommand(
        ["reseal", "--by", "ops"],
        {
          DATABASE_ADMIN_URL: "postgres://the-test-owner",
          REWARD_CODE_SECRET: S,
          REWARD_CODE_KEY_ID: "2",
          REWARD_CODE_PREVIOUS_SECRET: R,
          REWARD_CODE_PREVIOUS_KEY_ID: "1",
        },
        { print: (line) => void lines.push(line), connect: () => connectAsOwner(db) },
      );
      expect(exit).toBe(1);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? "")).toEqual({
        command: "reseal",
        keyId: 2,
        current: 1,
        resealed: 0,
        unreadable: 0,
        conflict: 1,
        changed: 0,
        ids: { unreadable: [], conflict: [legacy], changed: [] },
      });
      expect(lines[0]).not.toContain(SENTINEL);
      const [left] = await owner<{ code_hash: Buffer }>(
        "SELECT code_hash FROM reward_code WHERE id = $1",
        [legacy],
      );
      expect(left?.code_hash.equals(markCode(OLD.current, `${SENTINEL}-TWICE`))).toBe(true);
      expect(lines[0]).not.toContain(markCode(NEW.current, `${SENTINEL}-TWICE`).toString("hex"));
    });

    describe("the RUNBOOK's statement for a conflict", () => {
      it("removes the unused copy, lowers the stock with it, and the rerun finds no conflict", async () => {
        const reward = await newReward();
        await plantUnder(ROTATED, reward, `${SENTINEL}-DUP`);
        const legacy = await plantLegacy(reward, `${SENTINEL}-DUP`);
        expect(await reseal(ROTATED)).toMatchObject({ conflict: 1, ids: { conflict: [legacy] } });
        expect(await stockOf(reward)).toBe(2);

        expect((await removeUnused(legacy)).rowCount).toBe(1);
        expect(await stockOf(reward)).toBe(1);
        expect(await reseal(ROTATED)).toMatchObject({ conflict: 0, unreadable: 0, changed: 0 });
      });

      it("deletes nothing and leaves the stock when a player holds the row", async () => {
        const reward = await newReward();
        const held = await plantLegacy(reward, `${SENTINEL}-HELD`);
        await buy(ROTATED, await newPlayer(), reward);

        expect((await removeUnused(held)).rowCount).toBe(0);
        expect(await stockOf(reward)).toBe(1);
        expect(await owner("SELECT 1 FROM reward_code WHERE id = $1", [held])).toHaveLength(1);
      });
    });

    it("reports a row no key opens and leaves it as it was", async () => {
      const reward = await newReward();
      const lost = await plantUnder(ring(7, "t".repeat(32)), reward, `${SENTINEL}-LOST`);
      await plantLegacy(reward, `${SENTINEL}-FOUND`);
      const report = await reseal(ROTATED);
      expect(report).toMatchObject({ resealed: 1, unreadable: 1, ids: { unreadable: [lost] } });
      expect(await checkCodes(db.owner, NEW)).toEqual({ current: 1, stale: 1, ids: [lost] });
    });

    it("leaves a row whose cipher changed after the read for the next run", async () => {
      const reward = await newReward();
      const row = await plantLegacy(reward, `${SENTINEL}-MOVED`);
      const other = legacySeal(reward, `${SENTINEL}-MOVED`);
      const handed: string[] = [];
      const report = await reseal(ROTATED, {
        beforeWrite: async (planned) => {
          handed.push(...planned);
          await owner("UPDATE reward_code SET code_cipher = $2 WHERE id = $1", [row, other]);
        },
      });
      expect(handed).toEqual([row]);
      expect(report).toMatchObject({ resealed: 0, changed: 1, ids: { changed: [row] } });
      expect(await reseal(ROTATED)).toMatchObject({ resealed: 1, changed: 0 });
    });

    it("gives a player who reserves during the re-seal a code that opens before and after", async () => {
      const reward = await newReward();
      await plantLegacy(reward, `${SENTINEL}-RACE`);
      const player = await newPlayer();
      const report = await reseal(ROTATED, {
        beforeWrite: async () => {
          expect(await buy(ROTATED, player, reward)).toMatchObject({ code: `${SENTINEL}-RACE` });
        },
      });
      expect(report).toMatchObject({ resealed: 1, changed: 0 });
      expect(await history(NEW, player)).toEqual([`${SENTINEL}-RACE`]);
    });

    it("waits at most 2 seconds for a row lock and leaves that row for the next run", async () => {
      const reward = await newReward();
      const busy = await plantLegacy(reward, `${SENTINEL}-BUSY`);
      await plantLegacy(reward, `${SENTINEL}-FREE`);
      const holder = await connectAsOwner(db);
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT 1 FROM reward_code WHERE id = $1 FOR UPDATE", [busy]);
        const started = Date.now();
        const report = await reseal(ROTATED);
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(report).toMatchObject({ resealed: 1, changed: 1, ids: { changed: [busy] } });
        await holder.query("COMMIT");
      } finally {
        await holder.end();
      }
      expect(await reseal(ROTATED)).toMatchObject({ current: 1, resealed: 1, changed: 0 });
    });

    it("counts an upload once whether the re-seal commits before it or runs around it", async () => {
      const first = await newReward();
      await plantLegacy(first, `${SENTINEL}-R1`);
      await reseal(ROTATED);
      expect(await upload(first, [`${SENTINEL}-R1`], ROTATED)).toEqual({
        added: 0,
        duplicates: 1,
      });

      const second = await newReward();
      await plantLegacy(second, `${SENTINEL}-R2`);
      const report = await reseal(ROTATED, {
        beforeWrite: async () => {
          expect(await upload(second, [`${SENTINEL}-R2`], ROTATED)).toEqual({
            added: 0,
            duplicates: 1,
          });
        },
      });
      expect(report).toMatchObject({ resealed: 1, conflict: 0, changed: 0 });
      const rows = await owner<{ reward_id: string; n: number }>(
        "SELECT reward_id, count(*)::int AS n FROM reward_code GROUP BY reward_id ORDER BY reward_id",
      );
      expect(rows.map((row) => row.n)).toEqual([1, 1]);
    });

    it("counts an upload once while the batch is open with a row written and another waiting on a lock", async () => {
      const reward = await newReward();
      const written = await plantLegacy(reward, `${SENTINEL}-OPEN-A`);
      const busy = await plantLegacy(reward, `${SENTINEL}-OPEN-B`);
      const [{ pid } = { pid: 0 }] = (
        await db.owner.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows;
      const holder = await connectAsOwner(db);
      let pending: Promise<unknown> | undefined;
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT 1 FROM reward_code WHERE id = $1 FOR UPDATE", [busy]);
        pending = reseal(ROTATED);
        let waiting = false;
        for (let attempt = 0; attempt < 200 && !waiting; attempt += 1) {
          await holder.query("SELECT pg_stat_clear_snapshot()");
          const { rowCount } = await holder.query(
            "SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'",
            [pid],
          );
          waiting = rowCount === 1;
          if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
        // The batch has written the first row (uncommitted) and waits for the second: an upload now sees only committed rows.
        expect(
          await upload(reward, [`${SENTINEL}-OPEN-A`, `${SENTINEL}-OPEN-NEW`], ROTATED),
        ).toEqual({
          added: 1,
          duplicates: 1,
        });
        await holder.query("COMMIT");
      } finally {
        await holder.end();
      }
      expect(await pending).toMatchObject({ resealed: 2, conflict: 0, changed: 0 });
      expect(written).not.toBe(busy);
      expect(await stockOf(reward)).toBe(3);
      const [{ n } = { n: 0 }] = await owner<{ n: number }>(
        "SELECT count(*)::int AS n FROM reward_code WHERE reward_id = $1",
        [reward],
      );
      expect(n).toBe(3);
      expect(await reseal(ROTATED)).toMatchObject({ current: 3, resealed: 0, changed: 0 });
      expect(await checkCodes(db.owner, NEW)).toEqual({ current: 3, stale: 0, ids: [] });
    });

    it("stops on any other database error with the row id and SQLSTATE only, keeping nothing of the batch", async () => {
      const reward = await newReward();
      const first = await plantLegacy(reward, `${SENTINEL}-E1`);
      const failing = await plantLegacy(reward, `${SENTINEL}-E2`);
      const stopped = await withRefusedUpdate(failing, () =>
        reseal(ROTATED).then(
          () => "no error",
          (error: unknown) => (error as Error).message,
        ),
      );
      expect(stopped).toBe(
        `The re-seal stopped at reward_code ${failing} (SQLSTATE P0001); run it again.`,
      );
      expect(await checkCodes(db.owner, NEW)).toMatchObject({ current: 0, stale: 2 });
      const [last] = (await auditsOf()).slice(-1);
      expect(last?.after).toMatchObject({ finished: false, resealed: 0 });
      expect(JSON.stringify(last)).not.toContain(SENTINEL);
      expect(await reseal(ROTATED)).toMatchObject({ resealed: 2, ids: { changed: [] } });
      expect(first).not.toBe(failing);
    });

    it("reports the first error when the rollback of the failed batch fails too", async () => {
      const reward = await newReward();
      await plantLegacy(reward, `${SENTINEL}-R1`);
      const failing = await plantLegacy(reward, `${SENTINEL}-R2`);
      const stopped = await withRefusedUpdate(failing, () =>
        resealCodes(rollbackRefused(db.owner), ROTATED, { by: "test-operator" }).then(
          () => "no error",
          (error: unknown) => (error as Error).message,
        ),
      );
      expect(stopped).toBe(
        `The re-seal stopped at reward_code ${failing} (SQLSTATE P0001); run it again.`,
      );
      expect(await checkCodes(db.owner, NEW)).toMatchObject({ current: 0, stale: 2 });
    });

    it("reports both errors when a stopped run cannot write its closing audit entry", async () => {
      const reward = await newReward();
      await plantLegacy(reward, `${SENTINEL}-AUDIT`);
      const stop = new Error("operator pressed Ctrl+C");
      let stopping = false;
      const failure = await resealCodes(
        auditRefused(db.owner, () => stopping),
        ROTATED,
        {
          by: "test-operator",
          afterBatch: () => {
            stopping = true;
            return Promise.reject(stop);
          },
        },
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(AggregateError);
      const both = failure as AggregateError;
      expect(both.message).toBe("The re-seal stopped and its audit entry failed.");
      expect(both.cause).toBe(stop);
      expect(both.errors).toHaveLength(2);
      expect(both.errors[0]).toBe(stop);
      expect((both.errors[1] as Error).message).toBe("audit refused");
    });

    it("counts every row of a kind but lists only the first 100 ids", async () => {
      const reward = await newReward();
      const lost = ring(7, "t".repeat(32));
      const codes = Array.from({ length: 101 }, (_, n) => `${SENTINEL}-CAP-${n}`);
      const planted = await owner<{ id: string }>(
        `INSERT INTO reward_code (organizer_id, event_id, reward_id, code_cipher, code_hash)
         SELECT $1, $2, $3, cipher, mark FROM unnest($4::bytea[], $5::bytea[]) AS t(cipher, mark)
         RETURNING id::text`,
        [
          ids.orgA,
          ids.eventA,
          reward,
          codes.map((code) => sealCode(lost, reward, code)),
          codes.map((code) => markCode(lost.current, code)),
        ],
      );
      const inOrder = planted.map((row) => row.id).toSorted((a, b) => Number(a) - Number(b));
      const report = await reseal(ROTATED);
      expect(report.unreadable).toBe(101);
      expect(report.ids.unreadable).toEqual(inOrder.slice(0, 100));
    });

    it("walks ids in number order where they gain a digit, re-sealing and checking each row once", async () => {
      const [last] = await owner<{ value: string }>(
        "SELECT last_value::text AS value FROM reward_code_id_seq",
      );
      const width = String(BigInt(last?.value ?? "1") + 2n).length;
      await owner("SELECT setval('reward_code_id_seq', $1::bigint)", [
        `${10n ** BigInt(width) - 2n}`,
      ]);
      const reward = await newReward();
      const rows: string[] = [];
      for (const code of ["W-1", "W-2", "W-3"]) {
        rows.push(await plantLegacy(reward, `${SENTINEL}-${code}`));
      }
      expect(rows.map((id) => id.length)).toEqual([width, width + 1, width + 1]);
      expect(await checkCodes(db.owner, NEW)).toEqual({ current: 0, stale: 3, ids: rows });
      expect(await reseal(ROTATED, { batchSize: 2 })).toMatchObject({ current: 0, resealed: 3 });
      expect(await checkCodes(db.owner, NEW)).toEqual({ current: 3, stale: 0, ids: [] });
    });

    it("counts a conflict when the unique index refuses the new mark at write time", async () => {
      const reward = await newReward();
      const row = await plantLegacy(reward, `${SENTINEL}-LATE`);
      const [self] = await owner<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const rival = await connectAsOwner(db);
      const watcher = await connectAsOwner(db);
      let committed: Promise<unknown> = Promise.resolve();
      /** Commits the rival's copy once the re-seal's write waits on it, so the index (not the NOT EXISTS) decides. */
      const commitWhenWaited = async () => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const { rows } = await watcher.query<{ wait: string | null }>(
            "SELECT wait_event_type AS wait FROM pg_stat_activity WHERE pid = $1",
            [self?.pid],
          );
          if (rows[0]?.wait === "Lock") {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await rival.query("COMMIT");
      };
      try {
        const report = await reseal(ROTATED, {
          beforeWrite: async (planned) => {
            if (planned.length === 0) {
              return;
            }
            await rival.query("BEGIN");
            await rival.query(
              `INSERT INTO reward_code (organizer_id, event_id, reward_id, code_cipher, code_hash)
               VALUES ($1, $2, $3, $4, $5)`,
              [
                ids.orgA,
                ids.eventA,
                reward,
                sealCode(ROTATED, reward, `${SENTINEL}-LATE`),
                markCode(ROTATED.current, `${SENTINEL}-LATE`),
              ],
            );
            committed = commitWhenWaited();
          },
        });
        await committed;
        expect(report).toMatchObject({
          resealed: 0,
          conflict: 1,
          changed: 0,
          ids: { conflict: [row], changed: [] },
        });
      } finally {
        await rival.end();
        await watcher.end();
      }
    });

    // Mutation run 42106959753, equivalent survivors: `rows[0]?.` to `rows[0].` in assertSeesEveryRow, codeBatches and
    // writeOne (each query always answers a row there); the emptied `RELEASE SAVEPOINT` (the next ROLLBACK TO names
    // the newest savepoint, which is this row's, and COMMIT keeps them all); `outcome !== undefined` to `true` (one
    // outcome per planned row); `planned.length > 0` to `true` or `>= 0` (an empty batch commits an empty transaction).

    it("refuses a connection that cannot see every row before any read or write", async () => {
      const reward = await newReward();
      await plantLegacy(reward, `${SENTINEL}-RLS`);
      const before = (await auditsOf()).length;
      const app = db.app as Client;
      await expect(resealCodes(app, ROTATED, { by: "x" })).rejects.toThrow(/DATABASE_ADMIN_URL/);
      await expect(checkCodes(app, NEW)).rejects.toThrow(/DATABASE_ADMIN_URL/);
      expect(await auditsOf()).toHaveLength(before);
      expect(await checkCodes(db.owner, NEW)).toMatchObject({ current: 0, stale: 1 });
    });
  });
});
