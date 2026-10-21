import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AVATARS } from "@questify/shared";
import { withRequestContext } from "#src/db/context";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

const sha = (value: Buffer) => createHash("sha256").update(value).digest();

/**
 * Usernames in the database (T-109, migration 0016): folding, the character rule, the word lists, the history, and
 * renames only through `rename_player`.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("usernames (database)", () => {
  let db: TestDatabase;
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db.close();
  });

  const owner = async <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const as = async <T extends Record<string, unknown>>(
    player: string,
    sql: string,
    values: unknown[] = [],
    client: Client = db.app,
  ) =>
    withRequestContext(
      client,
      { playerId: player },
      async () => (await client.query<T>(sql, values)).rows,
    );

  const newPlayer = async (username?: string): Promise<string> => {
    counter += 1;
    const [made] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [username ?? `namer_${counter}`],
    );
    await owner("INSERT INTO player_contact (player_id, email) VALUES ($1, $2)", [
      made?.id,
      `namer${counter}@najd.sa`,
    ]);
    return made?.id ?? "";
  };
  const blocked = async (name: string) =>
    (await owner<{ blocked: boolean }>("SELECT username_blocked($1) AS blocked", [name]))[0]
      ?.blocked;
  const rename = (player: string, name: string, days = 30, client: Client = db.app) =>
    as<{ outcome: string; next_change_at: Date | null }>(
      player,
      "SELECT * FROM rename_player($1, $2)",
      [name, days],
      client,
    ).then((rows) => rows[0]);
  const history = async (player: string) =>
    owner<{ username: string; reason: string }>(
      "SELECT username, reason FROM username_history WHERE player_id = $1 ORDER BY id",
      [player],
    );

  describe("the name itself", () => {
    it("treats names that read alike as the same name (أ/إ/آ, ة/ه, ى/ي, case)", async () => {
      await newPlayer("أحمد_الريادة");
      await newPlayer("Sara_Q");
      for (const twin of ["احمد_الرياده", "SARA_q"]) {
        await expect(owner("INSERT INTO player (username) VALUES ($1)", [twin])).rejects.toThrow(
          /player_username_key/,
        );
      }
    });

    it("refuses marks, tatweel, a wasla alef and a zero-width joiner at the database", async () => {
      for (const name of ["صَقر", "صـقر", "ٱلصقر", "sa‌lem", "has space", "ab"]) {
        await expect(owner("INSERT INTO player (username) VALUES ($1)", [name])).rejects.toThrow(
          /player_username_characters/,
        );
      }
    });

    it("folds as the API role too, which every write of a player row needs", async () => {
      const [grant] = await owner<{ app: boolean; anyone: boolean }>(
        `SELECT has_function_privilege('questify_app', 'username_fold(text)', 'EXECUTE') AS app,
                has_function_privilege('questify_outsider', 'username_fold(text)', 'EXECUTE') AS anyone`,
      );
      expect(grant).toEqual({ app: true, anyone: false });
      const player = await newPlayer();
      for (const avatar of Array.from({ length: 120 }, (_, n) => ["owl", "fox", "camel"][n % 3])) {
        await as(player, "UPDATE player SET avatar = $2 WHERE id = $1", [player, avatar]);
      }
    });

    it("allows exactly the avatars the app ships", async () => {
      const player = await newPlayer();
      for (const avatar of AVATARS) {
        await as(player, "UPDATE player SET avatar = $2 WHERE id = $1", [player, avatar]);
      }
      await expect(
        as(player, "UPDATE player SET avatar = 'dragon' WHERE id = $1", [player]),
      ).rejects.toThrow(/player_avatar_check/);
      const [check] = await owner<{ definition: string }>(
        "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'player_avatar_check'",
      );
      const allowed = [...(check?.definition ?? "").matchAll(/'([a-z-]+)'/g)].map(
        (found) => found[1],
      );
      expect(allowed.toSorted()).toEqual([...AVATARS].toSorted());
    });

    it("has dropped the sign-up function that took no avatar", async () => {
      const left = await owner<{ signature: string }>(
        "SELECT oid::regprocedure::text AS signature FROM pg_proc WHERE proname = 'create_player'",
      );
      expect(left).toEqual([
        { signature: "create_player(bytea,text,integer,text,bytea,bytea,uuid)" },
      ]);
    });
  });

  describe("the word lists (ADR-119)", () => {
    it("blocks a short listed word as a whole token and a long one anywhere", async () => {
      for (const name of ["ass_king", "ass", "x_ass_7", "megafucker", "f_u_c_k_it", "pornstar_1"]) {
        expect(await blocked(name), name).toBe(true);
      }
      for (const name of [
        "class_act",
        "bass_player",
        "Sussex_fan",
        "therapist_1",
        "basement_9",
        "gc_fan",
        "shota_k",
      ]) {
        expect(await blocked(name), name).toBe(false);
      }
    });

    it("reads common digit spellings as letters, and leaves names with plain digits alone", async () => {
      for (const name of ["sh1t_storm", "5hit", "b1tch_99"]) {
        expect(await blocked(name), name).toBe(true);
      }
      for (const name of ["user_2024", "b00k_worm", "falcon_7"]) {
        expect(await blocked(name), name).toBe(false);
      }
    });

    it("folds Arabic before matching, and keeps names that only contain a short word", async () => {
      for (const name of ["شرموطة", "شرموطه_1", "شرموط", "كس_123", "سكسي", "كسمك", "زبي"]) {
        expect(await blocked(name), name).toBe(true);
      }
      for (const name of ["كسب", "خولة", "فرج_الله", "نيكول"]) {
        expect(await blocked(name), name).toBe(false);
      }
    });

    it("holds only folded letters, once each, so no entry can match every name", async () => {
      for (const word of ["", "a", "two words", "s&m", "Bad", "أبله", "2g1c"]) {
        await expect(
          owner("INSERT INTO username_word (word, match, language) VALUES ($1, 'part', 'en')", [
            word,
          ]),
        ).rejects.toThrow(/username_word_word_check/);
      }
      await expect(
        owner("INSERT INTO username_word (word, match, language) VALUES ('fuck', 'part', 'en')"),
      ).rejects.toThrow(/username_word_word_key/);
    });

    it("was seeded from the reviewed lists", async () => {
      const [counts] = await owner<{ en: number; ar: number }>(
        `SELECT count(*) FILTER (WHERE language = 'en')::int AS en,
                count(*) FILTER (WHERE language = 'ar')::int AS ar FROM username_word`,
      );
      expect(counts?.en).toBeGreaterThan(300);
      expect(counts?.ar).toBeGreaterThan(25);
    });
  });

  describe("the history (FR-1702)", () => {
    it("keeps every name a player had, from sign-up on", async () => {
      const player = await newPlayer("first_name");
      expect(await rename(player, "second_name")).toMatchObject({ outcome: "renamed" });
      expect(await history(player)).toEqual([
        { username: "first_name", reason: "signup" },
        { username: "second_name", reason: "rename" },
      ]);
    });

    it("can never be changed or removed, unless an erasure says so", async () => {
      const player = await newPlayer();
      await expect(
        owner("UPDATE username_history SET username = 'x' WHERE player_id = $1", [player]),
      ).rejects.toThrow(/can never be changed/);
      await expect(
        owner("DELETE FROM username_history WHERE player_id = $1", [player]),
      ).rejects.toThrow(/can never be changed/);
      await expect(owner("TRUNCATE username_history")).rejects.toThrow(/can never be changed/);
      await db.owner.query("BEGIN");
      await db.owner.query("SELECT set_config('app.erasure', 'on', true)");
      await db.owner.query("DELETE FROM username_history WHERE player_id = $1", [player]);
      await db.owner.query("COMMIT");
      expect(await history(player)).toEqual([]);
    });
  });

  describe("renaming", () => {
    it("allows a change right after sign-up, then waits the tuned days", async () => {
      const player = await newPlayer();
      expect(
        (await as<{ next: Date | null }>(player, "SELECT username_next_change(30) AS next"))[0]
          ?.next,
      ).toBeNull();
      const done = await rename(player, `renamed_${counter}`, 30);
      expect(done?.outcome).toBe("renamed");
      const soon = await rename(player, `again_${counter}`, 30);
      expect(soon?.outcome).toBe("too_soon");
      expect(soon?.next_change_at?.getTime()).toBe(done?.next_change_at?.getTime());
      const next = (
        await as<{ next: Date | null }>(player, "SELECT username_next_change(30) AS next")
      )[0]?.next;
      expect(next?.getTime()).toBe(done?.next_change_at?.getTime());
      await owner("ALTER TABLE username_history DISABLE TRIGGER username_history_no_change");
      try {
        await owner(
          "UPDATE username_history SET changed_at = now() - interval '31 days' WHERE player_id = $1 AND reason = 'rename'",
          [player],
        );
      } finally {
        await owner(
          "ALTER TABLE username_history ENABLE ALWAYS TRIGGER username_history_no_change",
        );
      }
      expect((await rename(player, `again_${counter}`, 30))?.outcome).toBe("renamed");
    });

    it("answers the same name as unchanged, a look-alike of its own as a real change", async () => {
      const player = await newPlayer("same_name");
      expect(await rename(player, "same_name")).toEqual({
        outcome: "unchanged",
        next_change_at: null,
      });
      expect((await rename(player, "Same_Name"))?.outcome).toBe("renamed");
    });

    it("refuses a listed word and a name that reads like someone else's", async () => {
      await newPlayer("taken_one");
      const player = await newPlayer();
      expect((await rename(player, "fucker_x"))?.outcome).toBe("username_blocked");
      expect((await rename(player, "TAKEN_ONE"))?.outcome).toBe("username_taken");
      expect(await history(player)).toHaveLength(1);
    });

    it("refuses a player who is not active and a limit out of range", async () => {
      const player = await newPlayer();
      for (const days of [0, 366]) {
        await expect(rename(player, "fine_name", days)).rejects.toThrow(/days from 1 to 365/);
        await expect(as(player, "SELECT username_next_change($1) AS next", [days])).rejects.toThrow(
          /days from 1 to 365/,
        );
      }
      await owner("UPDATE player SET status = 'banned' WHERE id = $1", [player]);
      await expect(rename(player, "fine_name")).rejects.toThrow(/not an active player/);
    });

    it("lets one of two renames at once through: one history row, one refusal", async () => {
      const player = await newPlayer();
      const clients = await Promise.all(
        [0, 1].map(async () => {
          const client = new Client({ connectionString: db.appUrl });
          await client.connect();
          return client;
        }),
      );
      try {
        const answers = await Promise.all(
          clients.map((client, n) => rename(player, `racer_${counter}_${n}`, 30, client)),
        );
        expect(answers.map((answer) => answer?.outcome).toSorted()).toEqual([
          "renamed",
          "too_soon",
        ]);
      } finally {
        await Promise.all(clients.map((client) => client.end()));
      }
      expect((await history(player)).filter((row) => row.reason === "rename")).toHaveLength(1);
    });
  });

  describe("signing up", () => {
    it("refuses a listed word and keeps the signup token for another try", async () => {
      counter += 1;
      const contact = `+9665${String(30_000_000 + counter).slice(-8)}`;
      const token = randomBytes(32);
      const code = randomBytes(32);
      await db.app.query(
        "SELECT start_player_challenge($1, $2, 'phone', $3, $4, $5, '0.1', '0.1')",
        [randomUUID(), token, contact, randomBytes(32), code],
      );
      const signup = randomBytes(32);
      await db.app.query("SELECT * FROM sign_in_player($1, $2, $3, $4, $5, $6)", [
        token,
        code,
        sha(randomBytes(32)),
        sha(randomBytes(32)),
        randomUUID(),
        sha(signup),
      ]);
      const create = (name: string) =>
        db.app
          .query<{ outcome: string }>(
            "SELECT outcome FROM create_player($1, $2, 1995, 'owl', $3, $4, $5)",
            [sha(signup), name, sha(randomBytes(32)), sha(randomBytes(32)), randomUUID()],
          )
          .then((result) => result.rows[0]?.outcome);
      expect(await create("shit_happens")).toBe("username_blocked");
      expect(await create(`clean_${counter}`)).toBe("created");
      expect(
        await owner("SELECT avatar FROM player WHERE username = $1", [`clean_${counter}`]),
      ).toEqual([{ avatar: "owl" }]);
    });
  });

  describe("closed by default", () => {
    it("closes the lists and the history to the API role, and every new function to outsiders", async () => {
      for (const table of ["username_word", "username_history"]) {
        await expect(db.app.query(`SELECT * FROM ${table}`)).rejects.toThrow(/permission denied/);
      }
      await expect(db.app.query("SELECT username_blocked('x')")).rejects.toThrow(
        /permission denied/,
      );
      for (const fn of [
        "rename_player('x', 30)",
        "username_next_change(30)",
        "create_player('\\x00', 'x', 1990, 'owl', '\\x00', '\\x00', gen_random_uuid())",
        "username_fold('x')",
      ]) {
        await expect(db.outsider.query(`SELECT public.${fn}`)).rejects.toThrow(/permission denied/);
      }
    });
  });
});
