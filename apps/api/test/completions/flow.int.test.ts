import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuthKeys } from "#src/auth/keys";
import type { Caller } from "#src/auth/sign-in";
import { completeQuest, type CompletionDeps, type Proof } from "#src/completions/complete";
import { createQuestCodeKey, questCode } from "#src/quests/qr";
import { testConfig } from "#test/support/auth-app";
import {
  TEST_DATABASE_URL,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

type Logged = Readonly<{ event: string; fields: Record<string, unknown> }>;

const config = testConfig();
const KEYS = createAuthKeys(config.auth.secret);
const CODE_KEY = createQuestCodeKey(config.qrSecret);

/**
 * The completion flow below the route (T-105): what it logs for each outcome, and when a wrong-code reservation is kept
 * or given back. The route's own tests cover the answers.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("the completion flow", () => {
  let db: TestDatabase;
  let pool: Pool;
  let deps: CompletionDeps;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new Pool({ connectionString: db.appUrl, max: 4 });
    deps = { pool, codeKey: CODE_KEY, keys: KEYS };
    ids = await seedTwoTenants(db.owner);
  });
  afterAll(async () => {
    await pool.end();
    await db.close();
  });

  const owner = async <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  const newPlayer = async (): Promise<string> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`flow_${counter}`],
    );
    await owner("INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)", [
      ids.orgA,
      ids.eventA,
      player?.id,
    ]);
    return player?.id ?? "";
  };

  const newQuest = async (type: "scan_qr" | "enter_code" = "scan_qr"): Promise<string> => {
    const [general] = await owner<{ id: string }>("SELECT id FROM category WHERE event_id = $1", [
      ids.eventA,
    ]);
    const [quest] = await owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, type_config)
       VALUES ($1, $2, $3, 'Flow', 12, 5, $4) RETURNING id`,
      [
        ids.eventA,
        general?.id,
        type,
        JSON.stringify(type === "enter_code" ? { code: "NAJD2030" } : {}),
      ],
    );
    return quest?.id ?? "";
  };

  const run = async (player: string, quest: string, proof: Proof, key: string = randomUUID()) => {
    const logged: Logged[] = [];
    const caller: Caller = {
      address: "127.0.0.1",
      userAgent: null,
      requestId: undefined,
      log: (event, fields) => logged.push({ event, fields: { ...fields } }),
    };
    const result = await completeQuest(
      deps,
      { playerId: player, questId: quest, proof, idempotencyKey: key, deviceId: undefined },
      caller,
    );
    return { result, logged };
  };

  const wrongCodesHeld = async (player: string, quest: string) =>
    (
      await owner<{ n: number }>(
        "SELECT count(*)::int AS n FROM auth_throttle WHERE bucket = 'code_player_quest' AND key = $1",
        [KEYS.playerQuestKey(player, quest)],
      )
    )[0]?.n;

  describe("what it logs", () => {
    it("logs a completion with the quest, its points and whether it was a replay", async () => {
      const player = await newPlayer();
      const quest = await newQuest();
      const proof: Proof = { type: "qr", code: questCode(CODE_KEY, quest, 1) };
      const { result, logged } = await run(player, quest, proof, "flow-key");
      expect(result).toMatchObject({
        kind: "completed",
        value: { points: 12, occurrence: 1, replayed: false },
      });
      expect(logged).toEqual([
        { event: "quest.completed", fields: { questId: quest, points: 12, replayed: "false" } },
      ]);
      const again = await run(player, quest, proof, "flow-key");
      expect(again.logged).toEqual([
        { event: "quest.completed", fields: { questId: quest, points: 12, replayed: "true" } },
      ]);
    });

    it.each([
      [
        "a forged code, refused before the database",
        (quest: string) => {
          // A real code with its signature changed: shaped right, not signed by Questify.
          const real = questCode(CODE_KEY, quest, 1);
          return {
            type: "qr",
            code: `${real.slice(0, 45)}${real[45] === "A" ? "B" : "A"}${real.slice(46)}`,
          };
        },
        "forged",
      ],
      [
        "another quest's code",
        () => ({ type: "qr", code: questCode(CODE_KEY, randomUUID(), 1) }),
        "wrong_quest",
      ],
      [
        "a code from before a regenerate, refused by the database",
        (quest: string) => ({ type: "qr", code: questCode(CODE_KEY, quest, 3) }),
        "old",
      ],
      ["not a code at all", () => ({ type: "qr", code: "hello" }), "not_questify"],
    ] as const)("logs %s with its own reason, never the code", async (_name, proofFor, reason) => {
      const player = await newPlayer();
      const quest = await newQuest();
      const proof = proofFor(quest) as Proof;
      const { result, logged } = await run(player, quest, proof);
      expect(result).toEqual({ kind: "invalid_code", problem: reason });
      expect(logged).toEqual([
        { event: "quest.refused", fields: { questId: quest, refusal: "invalid_code", reason } },
      ]);
      expect(JSON.stringify(logged)).not.toContain(proof.code);
    });

    it("logs a closed quest and an inactive enrollment with their reasons, and other refusals by kind", async () => {
      const player = await newPlayer();
      const hidden = await newQuest();
      await owner("UPDATE quest SET visible = false WHERE id = $1", [hidden]);
      expect(
        (await run(player, hidden, { type: "qr", code: questCode(CODE_KEY, hidden, 1) })).logged,
      ).toEqual([
        {
          event: "quest.refused",
          fields: { questId: hidden, refusal: "quest_not_open", reason: "hidden" },
        },
      ]);
      const missing = randomUUID();
      expect(
        (await run(player, missing, { type: "qr", code: questCode(CODE_KEY, missing, 1) })).logged,
      ).toEqual([
        {
          event: "quest.refused",
          fields: { questId: missing, refusal: "not_found", reason: "not_found" },
        },
      ]);
      const quest = await newQuest();
      await owner("UPDATE enrollment SET status = 'left' WHERE player_id = $1", [player]);
      expect(
        (await run(player, quest, { type: "qr", code: questCode(CODE_KEY, quest, 1) })).logged,
      ).toEqual([
        {
          event: "quest.refused",
          fields: { questId: quest, refusal: "enrollment_inactive", reason: "left" },
        },
      ]);
    });

    it("answers a key used for another quest as reused", async () => {
      const player = await newPlayer();
      const one = await newQuest();
      const two = await newQuest();
      await run(player, one, { type: "qr", code: questCode(CODE_KEY, one, 1) }, "shared");
      const { result } = await run(
        player,
        two,
        { type: "qr", code: questCode(CODE_KEY, two, 1) },
        "shared",
      );
      expect(result).toEqual({ kind: "key_reused" });
    });
  });

  describe("the wrong-code reservation", () => {
    it("keeps a wrong code counted and gives back a right one; a scan never counts", async () => {
      const player = await newPlayer();
      const quest = await newQuest("enter_code");
      await run(player, quest, { type: "code", code: "NOPE1" });
      expect(await wrongCodesHeld(player, quest)).toBe(1);
      await run(player, quest, { type: "code", code: "najd2030" });
      expect(await wrongCodesHeld(player, quest)).toBe(1);
      const scanned = await newQuest();
      await run(player, scanned, { type: "qr", code: questCode(CODE_KEY, scanned, 1) });
      expect(await wrongCodesHeld(player, scanned)).toBe(0);
    });

    it("gives back a typed code sent to a QR quest: a wrong method is no guess at the code", async () => {
      const player = await newPlayer();
      const quest = await newQuest();
      const { result } = await run(player, quest, { type: "code", code: "ANYTHING" });
      expect(result).toEqual({ kind: "invalid_code", problem: "wrong_method" });
      expect(await wrongCodesHeld(player, quest)).toBe(0);
    });

    it("gives a refused right code back too (a closed quest is no guess)", async () => {
      const player = await newPlayer();
      const quest = await newQuest("enter_code");
      await owner("UPDATE quest SET visible = false WHERE id = $1", [quest]);
      await run(player, quest, { type: "code", code: "NAJD2030" });
      expect(await wrongCodesHeld(player, quest)).toBe(0);
    });

    it("answers busy, and counts nothing, while another of the player's codes is being counted", async () => {
      const player = await newPlayer();
      const quest = await newQuest("enter_code");
      const holder = new Client({ connectionString: db.appUrl });
      await holder.connect();
      try {
        await holder.query("SELECT pg_advisory_lock($1::bigint)", [
          KEYS.playerKey(player).readBigInt64BE(0).toString(),
        ]);
        const { result } = await run(player, quest, { type: "code", code: "NAJD2030" });
        expect(result).toEqual({ kind: "too_many_attempts", retryAfterSeconds: 1 });
        expect(await wrongCodesHeld(player, quest)).toBe(0);
      } finally {
        await holder.end();
      }
    });

    it("lets a database error through, as an error", async () => {
      const player = await newPlayer();
      const quest = await newQuest("enter_code");
      await owner(
        "ALTER FUNCTION complete_quest(uuid, text, integer, text, text, uuid, jsonb) RENAME TO complete_quest_gone",
      );
      try {
        await expect(run(player, quest, { type: "code", code: "NAJD2030" })).rejects.toMatchObject({
          code: "42883",
        });
      } finally {
        await owner(
          "ALTER FUNCTION complete_quest_gone(uuid, text, integer, text, text, uuid, jsonb) RENAME TO complete_quest",
        );
      }
      expect(await wrongCodesHeld(player, quest)).toBe(0);
    });
  });
});
