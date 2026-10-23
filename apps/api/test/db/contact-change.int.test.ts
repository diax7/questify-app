import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext } from "#src/db/context";
import {
  TEST_DATABASE_URL,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

type Row = Record<string, unknown>;
type Confirmed = {
  outcome: string;
  attempts_left: number;
  channel: string | null;
  kind: string | null;
  previous: string | null;
  other: string | null;
};

const bytes = () => randomBytes(32);
const sha = (value: Buffer) => createHash("sha256").update(value).digest();

/**
 * Changing or adding a phone or email in the database (T-108, migration 0020): a challenge bound to the player, the
 * contact set only by the right code, another account's contact refused only at confirm, every change audited without
 * the contact, and no direct write to player_contact by the API's role.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("contact changes (database)", () => {
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

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const as = async <T extends Row>(
    player: string | undefined,
    sql: string,
    values: unknown[] = [],
  ) =>
    withRequestContext(
      db.app,
      player === undefined ? {} : { playerId: player },
      async () => (await db.app.query<T>(sql, values)).rows,
    );

  const newPlayer = async (contact: { phone?: string; email?: string } | null = {}) => {
    counter += 1;
    const [made] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`changer_${counter}`],
    );
    const id = made?.id ?? "";
    if (contact !== null) {
      await owner("INSERT INTO player_contact (player_id, phone_e164, email) VALUES ($1, $2, $3)", [
        id,
        contact.phone ?? null,
        contact.email ?? (contact.phone === undefined ? `c${counter}@najd.sa` : null),
      ]);
    }
    return id;
  };

  type Started = { token: Buffer; code: Buffer; outcome: string | undefined };
  const start = async (player: string, channel: string, value: string): Promise<Started> => {
    const token = bytes();
    const code = bytes();
    const [row] = await as<{ outcome: string }>(
      player,
      "SELECT start_contact_change($1, $2, $3, $4, $5, $6) AS outcome",
      [randomUUID(), sha(token), channel, value, code, bytes()],
    );
    return { token, code, outcome: row?.outcome };
  };
  const confirm = async (player: string, started: Started, code = started.code) =>
    (
      await as<Confirmed>(player, "SELECT * FROM confirm_contact_change($1, $2, $3)", [
        sha(started.token),
        code,
        randomUUID(),
      ])
    )[0];
  const contactOf = async (player: string) =>
    (
      await owner<{ phone_e164: string | null; email: string | null }>(
        "SELECT phone_e164, email FROM player_contact WHERE player_id = $1",
        [player],
      )
    )[0];
  const audits = (player: string) =>
    owner<{ action: string; after: unknown }>(
      "SELECT action, after FROM audit_log WHERE target_id = $1 AND action = 'player.contact_change' ORDER BY id",
      [player],
    );

  describe("changing and adding", () => {
    it("replaces a phone and adds an email, each audited without the contact, with the notice targets", async () => {
      const player = await newPlayer({ phone: "+966551110001" });
      const phone = await start(player, "phone", "+966551110002");
      expect(phone.outcome).toBe("started");
      expect(await confirm(player, phone)).toEqual({
        outcome: "changed",
        attempts_left: 0,
        channel: "phone",
        kind: "replaced",
        previous: "+966551110001",
        other: null,
      });
      const email = await start(player, "email", "new@najd.sa");
      expect(await confirm(player, email)).toMatchObject({
        outcome: "changed",
        channel: "email",
        kind: "added",
        previous: null,
        other: "+966551110002",
      });
      expect(await contactOf(player)).toEqual({
        phone_e164: "+966551110002",
        email: "new@najd.sa",
      });
      expect(await audits(player)).toEqual([
        { action: "player.contact_change", after: { channel: "phone", kind: "replaced" } },
        { action: "player.contact_change", after: { channel: "email", kind: "added" } },
      ]);
      expect(
        JSON.stringify(await owner("SELECT * FROM audit_log WHERE target_id = $1", [player])),
      ).not.toMatch(/551110002|new@najd/);
      expect(
        await owner("SELECT 1 FROM player_contact_challenge WHERE player_id = $1", [player]),
      ).toEqual([]);
    });

    it("gives a player made without a contact row their first contact", async () => {
      const player = await newPlayer(null);
      expect(await confirm(player, await start(player, "email", "first@najd.sa"))).toMatchObject({
        outcome: "changed",
        kind: "added",
      });
      expect(await contactOf(player)).toEqual({ phone_e164: null, email: "first@najd.sa" });
    });

    it("says unchanged for the player's own contact, and starts nothing", async () => {
      const player = await newPlayer({ email: "mine@najd.sa" });
      expect((await start(player, "email", "mine@najd.sa")).outcome).toBe("unchanged");
      expect(
        await owner("SELECT 1 FROM player_contact_challenge WHERE player_id = $1", [player]),
      ).toEqual([]);
    });

    it("marks the boards of the player's events for repair", async () => {
      const player = await newPlayer({ email: "board@najd.sa" });
      await owner(
        "INSERT INTO enrollment (organizer_id, event_id, player_id, score, score_version) VALUES ($1, $2, $3, 5, 1)",
        [ids.orgA, ids.eventA, player],
      );
      await owner("DELETE FROM ranking_repair");
      await confirm(player, await start(player, "email", "board2@najd.sa"));
      expect(
        await owner("SELECT 1 FROM ranking_repair WHERE event_id = $1", [ids.eventA]),
      ).toHaveLength(1);
    });
  });

  describe("another account's contact", () => {
    it("is not revealed at start, and refused at confirm: the challenge ends, nothing changes, nothing is audited", async () => {
      const holder = await newPlayer({ email: "taken@najd.sa" });
      const player = await newPlayer({ email: "other@najd.sa" });
      const started = await start(player, "email", "taken@najd.sa");
      expect(started.outcome).toBe("started");
      expect(await confirm(player, started)).toMatchObject({ outcome: "taken", channel: "email" });
      expect(await contactOf(player)).toEqual({ phone_e164: null, email: "other@najd.sa" });
      expect(await contactOf(holder)).toEqual({ phone_e164: null, email: "taken@najd.sa" });
      expect(await audits(player)).toEqual([]);
      expect((await confirm(player, started))?.outcome).toBe("expired");
    });
  });

  describe("the code", () => {
    it("allows three wrong codes, then the challenge is over even for the right one", async () => {
      const player = await newPlayer();
      const started = await start(player, "phone", "+966551110010");
      for (const left of [2, 1, 0]) {
        expect(await confirm(player, started, bytes())).toMatchObject({
          outcome: "wrong",
          attempts_left: left,
        });
      }
      expect((await confirm(player, started))?.outcome).toBe("expired");
      expect((await contactOf(player))?.phone_e164).toBeNull();
    });

    it("expires after five minutes, and a new request replaces the earlier one", async () => {
      const player = await newPlayer();
      const old = await start(player, "phone", "+966551110011");
      await owner(
        "UPDATE player_contact_challenge SET expires_at = now() - interval '1 second' WHERE player_id = $1",
        [player],
      );
      expect((await confirm(player, old))?.outcome).toBe("expired");
      const first = await start(player, "phone", "+966551110012");
      const second = await start(player, "phone", "+966551110013");
      expect((await confirm(player, first))?.outcome).toBe("expired");
      expect(await confirm(player, second)).toMatchObject({ outcome: "changed" });
      expect((await contactOf(player))?.phone_e164).toBe("+966551110013");
    });

    it("works only for the player who asked, and only while they are active", async () => {
      const player = await newPlayer();
      const stranger = await newPlayer();
      const started = await start(player, "phone", "+966551110014");
      expect((await confirm(stranger, started))?.outcome).toBe("expired");
      await owner("UPDATE player SET status = 'banned' WHERE id = $1", [player]);
      expect((await confirm(player, started))?.outcome).toBe("expired");
      await expect(start(player, "phone", "+966551110015")).rejects.toThrow(/not an active player/);
      await expect(start(undefined as unknown as string, "phone", "+966551110015")).rejects.toThrow(
        /not an active player/,
      );
    });

    it("refuses a malformed contact in the table itself", async () => {
      const player = await newPlayer();
      for (const [channel, value] of [
        ["phone", "0551110016"],
        ["email", "Upper@najd.sa"],
        ["fax", "1"],
      ]) {
        await expect(start(player, channel ?? "", value ?? "")).rejects.toThrow(/check constraint/);
      }
    });
  });

  describe("upkeep", () => {
    it("keeps one live challenge when two starts arrive at once", async () => {
      const player = await newPlayer();
      const { Client } = await import("pg");
      const second = new Client({ connectionString: db.appUrl });
      await second.connect();
      try {
        const run = (client: typeof db.app) =>
          withRequestContext(client, { playerId: player }, () =>
            client.query("SELECT start_contact_change($1, $2, 'phone', '+966551110020', $3, $4)", [
              randomUUID(),
              sha(bytes()),
              bytes(),
              bytes(),
            ]),
          );
        await Promise.all([run(db.app), run(second)]);
      } finally {
        await second.end();
      }
      expect(
        await owner("SELECT 1 FROM player_contact_challenge WHERE player_id = $1", [player]),
      ).toHaveLength(1);
    });

    it("sweeps a contact challenge an hour after it expired, and keeps a recent one", async () => {
      const old = await newPlayer();
      const recent = await newPlayer();
      await start(old, "phone", "+966551110021");
      await start(recent, "phone", "+966551110022");
      await owner(
        "UPDATE player_contact_challenge SET expires_at = now() - interval '61 minutes' WHERE player_id = $1",
        [old],
      );
      await owner(
        "UPDATE player_contact_challenge SET expires_at = now() - interval '1 minute' WHERE player_id = $1",
        [recent],
      );
      await as(undefined, "SELECT sweep_player_sign_in()");
      expect(
        (
          await owner<{ player_id: string }>(
            "SELECT player_id FROM player_contact_challenge WHERE player_id = ANY ($1)",
            [[old, recent]],
          )
        ).map((row) => row.player_id),
      ).toEqual([recent]);
    });
  });

  describe("access", () => {
    it("leaves the API's role no direct write to contacts and no right on the challenges", async () => {
      const player = await newPlayer({ email: "direct@najd.sa" });
      for (const sql of [
        "UPDATE player_contact SET email = 'hijack@najd.sa' WHERE player_id = $1",
        "INSERT INTO player_contact (player_id, email) VALUES ($1, 'second@najd.sa')",
        "SELECT * FROM player_contact_challenge WHERE player_id = $1",
      ]) {
        await expect(as(player, sql, [player])).rejects.toThrow(/permission denied/);
      }
      expect((await contactOf(player))?.email).toBe("direct@najd.sa");
    });

    it("is closed to outsiders", async () => {
      for (const sql of [
        "SELECT * FROM public.player_contact_challenge",
        "SELECT public.start_contact_change(gen_random_uuid(), '\\x00', 'phone', '+966551110017', '\\x00', '\\x00')",
        "SELECT * FROM public.confirm_contact_change('\\x00', '\\x00', NULL)",
      ]) {
        await expect(db.outsider.query(sql)).rejects.toThrow(/permission denied/);
      }
    });
  });
});
