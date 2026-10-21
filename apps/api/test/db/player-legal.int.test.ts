import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext } from "#src/db/context";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

const bytes = () => randomBytes(32);
const sha = (value: Buffer) => createHash("sha256").update(value).digest();
const one = (document: string, version: string) => JSON.stringify([{ document, version }]);

/**
 * Player acceptances in the database (T-110, migration 0017): no challenge without the accepted versions, sign-up and
 * sign-in record them, re-acceptance through one definer, and the record is the player's own and append-only.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("player acceptances (database)", () => {
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
  const asPlayer = async <T extends Record<string, unknown>>(
    player: string,
    sql: string,
    values: unknown[] = [],
  ) =>
    withRequestContext(
      db.app,
      { playerId: player },
      async () => (await db.app.query<T>(sql, values)).rows,
    );

  type Challenge = { token: Buffer; code: Buffer; contact: string };

  const challenge = async (
    terms: string | null = "0.1",
    privacy: string | null = "0.1",
    contact?: string,
  ): Promise<Challenge> => {
    counter += 1;
    const made = {
      token: bytes(),
      code: bytes(),
      contact: contact ?? `+9665${String(40_000_000 + counter).slice(-8)}`,
    };
    await db.app.query("SELECT start_player_challenge($1, $2, 'phone', $3, $4, $5, $6, $7)", [
      randomUUID(),
      made.token,
      made.contact,
      sha(Buffer.from(made.contact)),
      made.code,
      terms,
      privacy,
    ]);
    return made;
  };

  const signIn = async (c: Challenge, signup = bytes()) =>
    (
      await db.app.query<{ outcome: string; player_id: string | null }>(
        "SELECT outcome, player_id FROM sign_in_player($1, $2, $3, $4, $5, $6)",
        [c.token, c.code, sha(bytes()), sha(bytes()), randomUUID(), sha(signup)],
      )
    ).rows[0];

  /** Signs a new player up through the functions; returns the id and the challenge's contact. */
  const signUp = async (
    terms = "0.1",
    privacy = "0.1",
  ): Promise<{ id: string; contact: string }> => {
    const c = await challenge(terms, privacy);
    const signup = bytes();
    await signIn(c, signup);
    counter += 1;
    const [made] = (
      await db.app.query<{ player_id: string }>(
        "SELECT player_id FROM create_player($1, $2, 1995, 'fox', $3, $4, $5)",
        [sha(signup), `legal_${counter}`, sha(bytes()), sha(bytes()), randomUUID()],
      )
    ).rows;
    return { id: made?.player_id ?? "", contact: c.contact };
  };

  const acceptances = (player: string) =>
    owner<{ document: string; version: string; method: string }>(
      "SELECT document, version, method FROM player_acceptance WHERE player_id = $1 ORDER BY document, version",
      [player],
    );

  describe("before a code is sent", () => {
    it("refuses a challenge without the accepted versions, or with malformed ones", async () => {
      for (const [terms, privacy] of [
        [null, "0.1"],
        ["0.1", null],
        ["v1", "0.1"],
        ["0.1", "1.2.3.4"],
      ]) {
        await expect(challenge(terms, privacy)).rejects.toThrow(/null value|check constraint/);
      }
    });
  });

  describe("signing up and in", () => {
    it("records the terms and privacy at sign-up, at the time they were accepted", async () => {
      const { id } = await signUp();
      expect(await acceptances(id)).toEqual([
        { document: "privacy_policy", version: "0.1", method: "signup" },
        { document: "terms_of_use", version: "0.1", method: "signup" },
      ]);
      const [times] = await owner<{ same: boolean }>(
        `SELECT bool_and(a.accepted_at < p.created_at) AS same
         FROM player_acceptance a JOIN player p ON p.id = a.player_id WHERE a.player_id = $1`,
        [id],
      );
      expect(times?.same).toBe(true);
      const [audit] = await owner<{ after: unknown }>(
        "SELECT after FROM audit_log WHERE target_id = $1 AND action = 'player.signup'",
        [id],
      );
      expect(audit?.after).toEqual({
        channel: "phone",
        accepted: { terms: "0.1", privacy: "0.1" },
      });
    });

    it("records a returning player's acceptance once, and a newer version alongside", async () => {
      const { id, contact } = await signUp();
      expect((await signIn(await challenge("0.1", "0.1", contact)))?.outcome).toBe("signed_in");
      expect(await acceptances(id)).toHaveLength(2);
      expect((await signIn(await challenge("0.2", "0.1", contact)))?.outcome).toBe("signed_in");
      expect(await acceptances(id)).toEqual([
        { document: "privacy_policy", version: "0.1", method: "signup" },
        { document: "terms_of_use", version: "0.1", method: "signup" },
        { document: "terms_of_use", version: "0.2", method: "sign_in" },
      ]);
    });

    it("records nothing for a banned player's right code", async () => {
      const { id, contact } = await signUp();
      await owner("UPDATE player SET status = 'banned' WHERE id = $1", [id]);
      expect((await signIn(await challenge("0.3", "0.3", contact)))?.outcome).toBe("banned");
      expect(await acceptances(id)).toHaveLength(2);
    });
  });

  describe("accepting later", () => {
    it("records re-acceptance and the guidelines, and a repeat changes nothing", async () => {
      const { id } = await signUp();
      const docs = JSON.stringify([
        { document: "terms_of_use", version: "0.2" },
        { document: "community_guidelines", version: "0.1" },
      ]);
      await asPlayer(id, "SELECT accept_player_documents($1, 'submission')", [docs]);
      await asPlayer(id, "SELECT accept_player_documents($1, 'reaccept')", [docs]);
      expect((await acceptances(id)).filter((row) => row.method === "submission")).toEqual([
        { document: "community_guidelines", version: "0.1", method: "submission" },
        { document: "terms_of_use", version: "0.2", method: "submission" },
      ]);
      expect(await acceptances(id)).toHaveLength(4);
    });

    it("refuses another method, an unknown document, a malformed version and an inactive player", async () => {
      const { id } = await signUp();
      for (const how of ["signup", "sign_in", ""]) {
        await expect(
          asPlayer(id, "SELECT accept_player_documents($1, $2)", [one("terms_of_use", "0.3"), how]),
        ).rejects.toThrow(/only reaccept or submission/);
      }
      await expect(
        asPlayer(id, "SELECT accept_player_documents($1, 'reaccept')", [
          one("cookie_policy", "0.1"),
        ]),
      ).rejects.toThrow(/check constraint/);
      await expect(
        asPlayer(id, "SELECT accept_player_documents($1, 'reaccept')", [
          one("terms_of_use", "new"),
        ]),
      ).rejects.toThrow(/check constraint/);
      await owner("UPDATE player SET status = 'banned' WHERE id = $1", [id]);
      await expect(
        asPlayer(id, "SELECT accept_player_documents($1, 'reaccept')", [
          one("terms_of_use", "0.3"),
        ]),
      ).rejects.toThrow(/not an active player/);
    });
  });

  describe("the record", () => {
    it("is the player's own to read, and nobody's to write", async () => {
      const a = await signUp();
      const b = await signUp();
      const seen = await asPlayer<{ player_id: string }>(
        a.id,
        "SELECT player_id FROM player_acceptance",
      );
      expect(new Set(seen.map((row) => row.player_id))).toEqual(new Set([a.id]));
      await expect(
        asPlayer(
          a.id,
          "INSERT INTO player_acceptance (player_id, document, version, method) VALUES ($1, 'terms_of_use', '9.9', 'signup')",
          [a.id],
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(db.outsider.query("SELECT * FROM public.player_acceptance")).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        db.outsider.query("SELECT public.accept_player_documents('[]', 'reaccept')"),
      ).rejects.toThrow(/permission denied/);
      expect(await acceptances(b.id)).toHaveLength(2);
    });

    it("can never be changed or removed, unless an erasure says so", async () => {
      const { id } = await signUp();
      await expect(
        owner("UPDATE player_acceptance SET version = '9.9' WHERE player_id = $1", [id]),
      ).rejects.toThrow(/can never be changed/);
      await expect(
        owner("DELETE FROM player_acceptance WHERE player_id = $1", [id]),
      ).rejects.toThrow(/can never be changed/);
      await db.owner.query("BEGIN");
      await db.owner.query("SELECT set_config('app.erasure', 'on', true)");
      await db.owner.query("DELETE FROM player_acceptance WHERE player_id = $1", [id]);
      await db.owner.query("COMMIT");
      expect(await acceptances(id)).toEqual([]);
    });
  });
});
