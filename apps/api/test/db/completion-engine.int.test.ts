import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext } from "#src/db/context";
import {
  TEST_DATABASE_URL,
  addMember,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

type Completed = {
  completion_id: string;
  points: string;
  occurrence: number;
  score: string;
  balance: string;
  replayed: boolean;
};

/**
 * The completion engine in the database (T-105, migration 0012): one function checks every rule and is the only writer,
 * the ledger is append-only for every role, the enrollment's score and balance stay the ledger's sums, and two scans at
 * once pay once.
 */
const hash = (token: string) => createHash("sha256").update(token).digest();

const ownerOf = async (client: Client, token: string) =>
  (
    await client.query<{ owner: string | null }>("SELECT player_session_owner($1) AS owner", [
      hash(token),
    ])
  ).rows[0]?.owner;

const complete = (
  client: Client,
  player: string,
  quest: string,
  proof: { method?: string; version?: number | null; code?: string | null; key?: string } = {},
) =>
  withRequestContext(
    client,
    { playerId: player },
    async () =>
      (
        await client.query<Completed>("SELECT * FROM complete_quest($1, $2, $3, $4, $5, $6)", [
          quest,
          proof.method ?? "qr",
          proof.version === undefined ? 1 : proof.version,
          proof.code ?? null,
          proof.key ?? randomUUID(),
          null,
        ])
      ).rows[0],
  );

describe.skipIf(TEST_DATABASE_URL === undefined)("completion engine (database)", () => {
  let db: TestDatabase;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    ids = await seedTwoTenants(db.owner);
  });
  afterAll(async () => {
    await db.close();
  });

  const owner = async <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  /** A player enrolled in organizer A's live event, with a status. */
  const newPlayer = async (status = "active"): Promise<{ player: string; enrollment: string }> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`player_${counter}`],
    );
    const [enrollment] = await owner<{ id: string }>(
      "INSERT INTO enrollment (organizer_id, event_id, player_id, status) VALUES ($1, $2, $3, $4) RETURNING id",
      [ids.orgA, ids.eventA, player?.id, status],
    );
    return { player: player?.id ?? "", enrollment: enrollment?.id ?? "" };
  };

  /** A quest in organizer A's live event. */
  const newQuest = async (fields: Record<string, unknown> = {}): Promise<string> => {
    const values: Record<string, unknown> = {
      type: "scan_qr",
      points: 10,
      repeat_cap: 1,
      visible: true,
      type_config: {},
      ...fields,
    };
    const [general] = await owner<{ id: string }>("SELECT id FROM category WHERE event_id = $1", [
      ids.eventA,
    ]);
    const [quest] = await owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, visible, type_config, opens_at, closes_at)
       VALUES ($1, $2, $3, 'A quest', $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        ids.eventA,
        general?.id,
        values["type"],
        values["points"],
        values["repeat_cap"],
        values["visible"],
        JSON.stringify(values["type_config"]),
        values["opens_at"] ?? null,
        values["closes_at"] ?? null,
      ],
    );
    return quest?.id ?? "";
  };

  const enrollmentOf = async (enrollment: string) =>
    (
      await owner<{ score: string; balance: string }>(
        "SELECT score, balance FROM enrollment WHERE id = $1",
        [enrollment],
      )
    )[0];

  describe("a completion", () => {
    it("writes one completion and one ledger entry of the quest's points, and moves the score and balance with it", async () => {
      const { player, enrollment } = await newPlayer();
      const quest = await newQuest({ points: 25 });
      const done = await complete(db.app, player, quest);
      expect(done).toMatchObject({
        points: "25",
        occurrence: 1,
        score: "25",
        balance: "25",
        replayed: false,
      });
      const entries = await owner<{
        score_delta: string;
        balance_delta: string;
        kind: string;
        actor: string;
      }>(
        "SELECT score_delta, balance_delta, kind, actor FROM ledger_entry WHERE enrollment_id = $1",
        [enrollment],
      );
      expect(entries).toEqual([
        { score_delta: "25", balance_delta: "25", kind: "quest", actor: "player" },
      ]);
      expect(await enrollmentOf(enrollment)).toEqual({ score: "25", balance: "25" });
    });

    it("pays a repeatable quest up to its cap, then refuses with the cap", async () => {
      const { player } = await newPlayer();
      const quest = await newQuest({ repeat_cap: 3, points: 5 });
      for (const occurrence of [1, 2, 3]) {
        expect(await complete(db.app, player, quest)).toMatchObject({ occurrence });
      }
      await expect(complete(db.app, player, quest)).rejects.toMatchObject({
        code: "QD409",
        detail: "3",
      });
    });

    it("pays a 0-point quest with a 0 entry", async () => {
      const { player, enrollment } = await newPlayer();
      await complete(db.app, player, await newQuest({ points: 0 }));
      expect(await enrollmentOf(enrollment)).toEqual({ score: "0", balance: "0" });
    });
  });

  describe("the rules", () => {
    it.each([
      ["a hidden quest", { visible: false }, {}, "QN403", "hidden"],
      [
        "a quest not open yet",
        { opens_at: new Date(Date.now() + 3_600_000) },
        {},
        "QN403",
        "not_started",
      ],
      ["a closed quest", { closes_at: new Date(Date.now() - 1000) }, {}, "QN403", "ended"],
      ["a code for a QR quest", {}, { method: "code", code: "ABCD" }, "QV422", "wrong_method"],
      [
        "a QR for an entry-code quest",
        { type: "enter_code", type_config: { code: "NAJD2030" } },
        {},
        "QV422",
        "wrong_method",
      ],
      ["an old QR version", {}, { version: 2 }, "QV422", "old"],
      ["a QR without a version", {}, { version: null }, "QV422", "old"],
      [
        "a wrong code",
        { type: "enter_code", type_config: { code: "NAJD2030" } },
        { method: "code", code: "NAJD2031" },
        "QV422",
        "wrong_code",
      ],
      [
        "no code",
        { type: "enter_code", type_config: { code: "NAJD2030" } },
        { method: "code", code: null },
        "QV422",
        "wrong_code",
      ],
    ])("refuses %s", async (_name, questFields, proof, code, detail) => {
      const { player, enrollment } = await newPlayer();
      const quest = await newQuest(questFields);
      await expect(complete(db.app, player, quest, proof)).rejects.toMatchObject({ code, detail });
      expect(await enrollmentOf(enrollment)).toEqual({ score: "0", balance: "0" });
    });

    it("takes the right entry code", async () => {
      const { player } = await newPlayer();
      const quest = await newQuest({ type: "enter_code", type_config: { code: "NAJD2030" } });
      expect(
        await complete(db.app, player, quest, { method: "code", code: "NAJD2030", version: null }),
      ).toMatchObject({
        occurrence: 1,
      });
    });

    it.each(["pending", "left", "removed", "banned"])(
      "refuses an enrollment that is %s",
      async (status) => {
        const { player } = await newPlayer(status);
        await expect(complete(db.app, player, await newQuest())).rejects.toMatchObject({
          code: "QC403",
          detail: status,
        });
      },
    );

    it("answers a quest of an event the player is not in like a missing one", async () => {
      const { player } = await newPlayer();
      const [general] = await owner<{ id: string }>("SELECT id FROM category WHERE event_id = $1", [
        ids.eventB,
      ]);
      const [theirs] = await owner<{ id: string }>(
        "INSERT INTO quest (event_id, category_id, type, title_en, points) VALUES ($1, $2, 'scan_qr', 'Theirs', 5) RETURNING id",
        [ids.eventB, general?.id],
      );
      for (const quest of [theirs?.id, randomUUID()]) {
        await expect(complete(db.app, player, quest ?? "")).rejects.toMatchObject({
          code: "QC404",
        });
      }
    });

    it("refuses when the event is not live at this moment, before the tick catches up", async () => {
      const { player } = await newPlayer();
      const quest = await newQuest();
      await owner("UPDATE event SET ends_at = now() - interval '1 second' WHERE id = $1", [
        ids.eventA,
      ]);
      try {
        await expect(complete(db.app, player, quest)).rejects.toMatchObject({
          code: "QN403",
          detail: "event_not_live",
        });
      } finally {
        await owner("UPDATE event SET ends_at = now() + interval '30 days' WHERE id = $1", [
          ids.eventA,
        ]);
      }
    });

    it("needs a player in the request: none, nothing", async () => {
      const quest = await newQuest();
      await expect(
        withRequestContext(db.app, {}, () =>
          db.app.query("SELECT * FROM complete_quest($1, 'qr', 1, NULL, 'k', NULL)", [quest]),
        ),
      ).rejects.toThrow(/no player in this request/);
    });
  });

  describe("idempotency", () => {
    it("answers a retry with the first completion, even after the cap is reached", async () => {
      const { player, enrollment } = await newPlayer();
      const quest = await newQuest({ points: 7 });
      const first = await complete(db.app, player, quest, { key: "tap-1" });
      const again = await complete(db.app, player, quest, { key: "tap-1" });
      expect(again).toEqual({ ...first, replayed: true });
      expect(await enrollmentOf(enrollment)).toEqual({ score: "7", balance: "7" });
    });

    it("refuses a key already used for another quest or method", async () => {
      const { player } = await newPlayer();
      const one = await newQuest();
      const two = await newQuest();
      await complete(db.app, player, one, { key: "tap-2" });
      await expect(complete(db.app, player, two, { key: "tap-2" })).rejects.toMatchObject({
        code: "QK422",
      });
      await expect(
        complete(db.app, player, one, { key: "tap-2", method: "code" }),
      ).rejects.toMatchObject({
        code: "QK422",
      });
    });
  });

  describe("two scans at once", () => {
    // 25, not 50: enough to prove one player's calls are serialized under a real overlapping burst, while staying under
    // the test container's connection limit with the other test files running beside this one.
    const CONNECTIONS = 25;

    const burst = async (player: string, quest: string, keyOf: (n: number) => string) => {
      const clients = await Promise.all(
        Array.from({ length: CONNECTIONS }, async () => {
          const client = new Client({ connectionString: db.appUrl });
          await client.connect();
          return client;
        }),
      );
      try {
        return await Promise.allSettled(
          clients.map((client, n) => complete(client, player, quest, { key: keyOf(n) })),
        );
      } finally {
        await Promise.all(clients.map((client) => client.end()));
      }
    };

    it("pays once for a one-time quest and three times for a cap of 3, from separate connections", async () => {
      for (const cap of [1, 3]) {
        const { player, enrollment } = await newPlayer();
        const quest = await newQuest({ repeat_cap: cap, points: 10 });
        const results = await burst(player, quest, (n) => `burst-${n}`);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(cap);
        const refused = results.filter((result) => result.status === "rejected");
        expect(
          refused.every((result) => (result.reason as { code?: string }).code === "QD409"),
        ).toBe(true);
        const [sums] = await owner<{ score: string; completions: string }>(
          "SELECT (SELECT sum(score_delta) FROM ledger_entry WHERE enrollment_id = $1)::text AS score, (SELECT count(*) FROM quest_completion WHERE enrollment_id = $1)::text AS completions",
          [enrollment],
        );
        expect(sums).toEqual({ score: String(10 * cap), completions: String(cap) });
        expect(await enrollmentOf(enrollment)).toEqual({
          score: String(10 * cap),
          balance: String(10 * cap),
        });
      }
    });

    it("keeps one row per occurrence even for a writer that skips the lock (the backstop)", async () => {
      const { player } = await newPlayer();
      const quest = await newQuest();
      await complete(db.app, player, quest);
      await expect(
        db.owner.query(
          `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method, idempotency_key)
           SELECT organizer_id, event_id, enrollment_id, quest_id, occurrence, method, 'another key'
           FROM quest_completion WHERE quest_id = $1`,
          [quest],
        ),
      ).rejects.toMatchObject({ code: "23505" });
    });

    it("pays once for the same key sent at once, and every other answer is that same completion", async () => {
      const { player, enrollment } = await newPlayer();
      const quest = await newQuest({ repeat_cap: 5 });
      const results = await burst(player, quest, () => "same-key");
      const answers = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      expect(new Set(answers.map((answer) => answer?.completion_id)).size).toBe(1);
      expect(answers.filter((answer) => answer?.replayed === false)).toHaveLength(1);
      expect(await enrollmentOf(enrollment)).toEqual({ score: "10", balance: "10" });
    });
  });

  describe("the ledger", () => {
    it("can never be changed or removed, not even by the owner", async () => {
      const { player, enrollment } = await newPlayer();
      await complete(db.app, player, await newQuest());
      for (const sql of [
        "UPDATE ledger_entry SET score_delta = 1000 WHERE enrollment_id = $1",
        "DELETE FROM ledger_entry WHERE enrollment_id = $1",
      ]) {
        await expect(db.owner.query(sql, [enrollment])).rejects.toThrow(
          /can never be changed or removed/,
        );
        await expect(
          withRequestContext(db.app, { organizerId: ids.orgA }, () =>
            db.app.query(sql, [enrollment]),
          ),
        ).rejects.toThrow(/permission denied/);
      }
      await expect(db.owner.query("TRUNCATE ledger_entry")).rejects.toThrow(
        /can never be changed or removed/,
      );
    });

    it("is written by the function only: the API's role inserts nothing itself", async () => {
      const { enrollment } = await newPlayer();
      for (const sql of [
        "INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor) VALUES ($1, $2, $3, 'quest', 999, 999, 'player')",
        "INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method, idempotency_key) VALUES ($1, $2, $3, gen_random_uuid(), 1, 'qr', 'k')",
      ]) {
        await expect(
          withRequestContext(db.app, { organizerId: ids.orgA }, () =>
            db.app.query(sql, [ids.orgA, ids.eventA, enrollment]),
          ),
        ).rejects.toThrow(/permission denied/);
      }
    });

    it("lets a player read their own entries only, and the organizer's members their event's", async () => {
      const { player, enrollment } = await newPlayer();
      const other = await newPlayer();
      const quest = await newQuest();
      await complete(db.app, player, quest);
      await complete(db.app, other.player, quest);
      const mine = await withRequestContext(
        db.app,
        { playerId: player },
        async () =>
          (await db.app.query<{ enrollment_id: string }>("SELECT enrollment_id FROM ledger_entry"))
            .rows,
      );
      expect(mine).toEqual([{ enrollment_id: enrollment }]);
      const outsiders = await withRequestContext(
        db.app,
        { organizerId: ids.orgB },
        async () =>
          (await db.app.query("SELECT 1 FROM ledger_entry WHERE event_id = $1", [ids.eventA])).rows,
      );
      expect(outsiders).toEqual([]);
    });
  });

  describe("player sessions", () => {
    it("answers the player for a live session only, of an active player", async () => {
      const cases: [string, string, string, string | null][] = [
        ["live", "active", "now() + interval '1 hour'", null],
        ["expired", "active", "now() - interval '1 second'", null],
        ["revoked", "active", "now() + interval '1 hour'", "now()"],
        ["banned", "banned", "now() + interval '1 hour'", null],
      ];
      for (const [name, status, expires, revoked] of cases) {
        counter += 1;
        const [player] = await owner<{ id: string }>(
          "INSERT INTO player (username, status) VALUES ($1, $2) RETURNING id",
          [`session_${counter}`, status],
        );
        await owner(
          `INSERT INTO player_session (player_id, token_hash, expires_at, revoked_at) VALUES ($1, $2, ${expires}, ${revoked ?? "NULL"})`,
          [player?.id, hash(name)],
        );
        expect(await ownerOf(db.app, name), name).toBe(name === "live" ? player?.id : null);
      }
      expect(await ownerOf(db.app, "never issued")).toBeNull();
    });

    it("keeps the sessions themselves closed to the API's role and to outsiders", async () => {
      await expect(db.app.query("SELECT * FROM player_session")).rejects.toThrow(
        /permission denied/,
      );
      for (const sql of [
        "SELECT * FROM public.player_session",
        "SELECT * FROM public.ledger_entry",
        "SELECT * FROM public.quest_completion",
        "SELECT public.complete_quest(gen_random_uuid(), 'qr', 1, NULL, 'k', NULL)",
        "SELECT public.player_session_owner('\\x00')",
      ]) {
        await expect(db.outsider.query(sql)).rejects.toThrow(/permission denied/);
      }
    });
  });

  describe("a quest that players completed", () => {
    it("cannot be deleted (its points are history)", async () => {
      const { player } = await newPlayer();
      const quest = await newQuest();
      await complete(db.app, player, quest);
      const staffUserId = await addMember(db.owner, ids.orgA, "owner");
      await expect(
        withRequestContext(db.app, { organizerId: ids.orgA, staffUserId }, () =>
          db.app.query("DELETE FROM quest WHERE id = $1", [quest]),
        ),
      ).rejects.toMatchObject({ code: "23503" });
    });
  });
});
