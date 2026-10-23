import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
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
type Erased = { outcome: string; events: string[] };

const bytes = () => randomBytes(32);
const sha = (value: string | Buffer): Buffer => createHash("sha256").update(value).digest();
/** Stands in for the API's keyed fingerprint: any fixed 32 bytes per contact. */
const fp = (contact: string): Buffer => sha(`fingerprint:${contact}`);
const HOUR = 60 * 60 * 1000;
const pidOf = async (client: Client) =>
  (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid ?? 0;

/**
 * Account deletion in the database (T-217, migration 0038, ADR-175 to ADR-178): the tombstone and every row the plan
 * clears or keeps, the deletion code and token, ban, welcome and platform marks (also through an earlier contact),
 * pending handovers and their forfeit (a rank prize too), the readers that show a deleted player, and the races with a
 * join, a join request, a reservation and an operator's My QR scan.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("account deletion (database)", () => {
  let db: TestDatabase;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let ownerA: string;
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    ids = await seedTwoTenants(db.owner);
    ownerA = await addMember(db.owner, ids.orgA);
  });
  afterAll(async () => {
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const as = async <T extends Row>(
    context: RequestContext,
    sql: string,
    values: unknown[] = [],
    client: Client = db.app,
  ) => withRequestContext(client, context, async () => (await client.query<T>(sql, values)).rows);
  const teamA = (): RequestContext => ({ organizerId: ids.orgA, staffUserId: ownerA });
  const count = async (sql: string, values: unknown[]) =>
    (await owner<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, values))[0]?.n;

  const connect = async () => {
    const client = new Client({ connectionString: db.appUrl });
    await client.connect();
    return client;
  };
  const waitUntilBlocked = async (pid: number) => {
    for (let tries = 0; tries < 200; tries += 1) {
      const rows = await owner(
        "SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'",
        [pid],
      );
      if (rows.length > 0) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("the second transaction never waited for the deletion");
  };

  type Spec = { access?: string; welcome?: number | null; ends?: string };
  type Event = { id: string; code: string; quest: string; reward: string };
  const newEvent = async (spec: Spec = {}): Promise<Event> => {
    counter += 1;
    const code = `DEL${String(counter).padStart(4, "0")}`;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, access, starts_at, ends_at, welcome_points)
       VALUES ($1, $2, 'Gone Fest', 'live', $3, now() - interval '2 hours', now() + $4::interval, $5) RETURNING id`,
      [ids.orgA, code, spec.access ?? "public", spec.ends ?? "1 day", spec.welcome ?? null],
    );
    const id = event?.id ?? "";
    const [category] = await owner<{ id: string }>(
      "INSERT INTO category (event_id, name_en) VALUES ($1, 'General') RETURNING id",
      [id],
    );
    const [quest] = await owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
       VALUES ($1, $2, 'enter_code', 'Booth', 10, '{"code": "ABC"}') RETURNING id`,
      [id, category?.id],
    );
    const [reward] = await owner<{ id: string }>(
      "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, 'experience', 'Spa', 5, 9) RETURNING id",
      [id],
    );
    return { id, code, quest: quest?.id ?? "", reward: reward?.id ?? "" };
  };

  type Player = { id: string; email: string; phone: string };
  /** A player with a phone and an email, each with its fingerprint (as sign-up and a contact change record them). */
  const newPlayer = async (extra: readonly string[] = []): Promise<Player> => {
    counter += 1;
    const phone = `+9665${String(70_000_000 + counter).slice(-8)}`;
    const email = `gone${counter}@example.com`;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username, birth_year) VALUES ($1, 1990) RETURNING id",
      [`gone_${counter}`],
    );
    const id = player?.id ?? "";
    await owner("INSERT INTO player_contact (player_id, phone_e164, email) VALUES ($1, $2, $3)", [
      id,
      phone,
      email,
    ]);
    for (const contact of [phone, email, ...extra]) {
      await owner("INSERT INTO player_fingerprint (player_id, fingerprint) VALUES ($1, $2)", [
        id,
        fp(contact),
      ]);
    }
    return { id, email, phone };
  };
  /** A newcomer whose phone carries the given fingerprint (a re-sign-up with a deleted account's contact). */
  const newcomerWith = async (contact: string): Promise<string> => {
    const fresh = await newPlayer();
    await owner("INSERT INTO player_fingerprint (player_id, fingerprint) VALUES ($1, $2)", [
      fresh.id,
      fp(contact),
    ]);
    return fresh.id;
  };

  const join = async (player: string, event: Event, client: Client = db.app) =>
    (
      await as<{ outcome: string; enrollment_id: string | null; status: string; welcome: number }>(
        { playerId: player },
        "SELECT * FROM join_event($1, 'code', '0.2')",
        [event.code],
        client,
      )
    )[0];
  const enrollmentOf = async (player: string, event: Event) =>
    (
      await owner<{ id: string }>(
        "SELECT id FROM enrollment WHERE player_id = $1 AND event_id = $2",
        [player, event.id],
      )
    )[0]?.id ?? "";

  type Code = { token: Buffer; code: Buffer; known: boolean };
  const startCode = async (contact: string, channel = "email"): Promise<Code> => {
    const token = bytes();
    const code = bytes();
    const [row] = await as<{ known: boolean }>(
      {},
      "SELECT start_deletion_challenge($1, $2, $3, $4, $5, $6) AS known",
      [randomUUID(), sha(token), channel, contact, sha(contact), code],
    );
    return { token, code, known: row?.known === true };
  };
  const verify = async (started: Code, code = started.code) => {
    const deletion = bytes();
    const [row] = await as<{ outcome: string; attempts_left: number }>(
      {},
      "SELECT * FROM verify_deletion_code($1, $2, $3)",
      [sha(started.token), code, sha(deletion)],
    );
    return { ...row, deletion };
  };
  const tokenFor = async (player: Player): Promise<Buffer> =>
    (await verify(await startCode(player.email))).deletion;
  const erase = async (deletion: Buffer, forfeit = false, client: Client = db.app) =>
    (
      await as<Erased>(
        {},
        "SELECT outcome, events FROM erase_player($1, $2, $3)",
        [sha(deletion), forfeit, randomUUID()],
        client,
      )
    )[0];
  const deleteAccount = async (player: Player, forfeit = true) =>
    erase(await tokenFor(player), forfeit);

  describe("the tombstone", () => {
    it("clears everything personal and keeps the records, naming no one", async () => {
      const event = await newEvent({ welcome: 50 });
      const gone = await newPlayer();
      await join(gone.id, event);
      const enrollment = await enrollmentOf(gone.id, event);
      await as(
        { playerId: gone.id },
        "SELECT * FROM complete_quest($1, 'code', NULL, 'ABC', $2, $3)",
        [event.quest, randomUUID(), randomUUID()],
      );
      await as(
        teamA(),
        "SELECT * FROM staff_award($1, $2, NULL, 7, 'Thanks Sara from Riyadh', $3, $4)",
        [event.id, enrollment, randomUUID(), randomUUID()],
      );
      await owner(
        `INSERT INTO flag (organizer_id, event_id, enrollment_id, kind, evidence, note)
         VALUES ($1, $2, $3, 'burst', '{"completions": []}', 'seen at the gate')`,
        [ids.orgA, event.id, enrollment],
      );
      await owner(
        `INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities)
         VALUES ($1, $2, $3, '{scan_quests}')`,
        [ids.orgA, event.id, gone.id],
      );
      await owner(
        `INSERT INTO player_acceptance (player_id, document, version, method)
         VALUES ($1, 'terms_of_use', '0.1', 'signup')`,
        [gone.id],
      );
      const before = await owner<{ score: string; balance: string; total: string }>(
        `SELECT n.score, n.balance, (SELECT sum(score_delta) FROM ledger_entry l WHERE l.enrollment_id = n.id) AS total
         FROM enrollment n WHERE n.id = $1`,
        [enrollment],
      );

      await owner("DELETE FROM ranking_repair WHERE event_id = $1", [event.id]);
      const signIn = randomUUID();
      await as({}, "SELECT start_player_challenge($1, $2, 'email', $3, $4, $5, '0.1', '0.1', $6)", [
        signIn,
        bytes(),
        gone.email,
        sha(gone.email),
        bytes(),
        fp(gone.email),
      ]);
      const deletion = await tokenFor(gone);
      const answer = await erase(deletion, true);
      expect(answer).toEqual({ outcome: "erased", events: [event.id] });
      expect(await count("ranking_repair WHERE event_id = $1", [event.id])).toBe(1);
      expect(await count("player_login_challenge WHERE id = $1", [signIn])).toBe(0);
      expect(
        await owner(
          "SELECT player_id, contact_key, erased_at IS NOT NULL AS erased FROM player_deletion_challenge WHERE deletion_hash = $1",
          [sha(deletion)],
        ),
      ).toEqual([{ player_id: null, contact_key: null, erased: true }]);
      expect(
        await count("player_deletion_challenge WHERE contact_key = $1", [sha(gone.email)]),
      ).toBe(0);

      expect(
        await owner("SELECT username, birth_year, avatar, status FROM player WHERE id = $1", [
          gone.id,
        ]),
      ).toEqual([{ username: null, birth_year: null, avatar: "falcon", status: "deleted" }]);
      for (const table of [
        "player_contact",
        "player_fingerprint",
        "username_history",
        "player_acceptance",
        "player_session",
        "player_refresh",
        "staff_assignment",
      ]) {
        expect(await count(`${table} WHERE player_id = $1`, [gone.id]), table).toBe(0);
      }
      expect(await count("join_answer WHERE enrollment_id = $1", [enrollment])).toBe(0);
      expect(await count("flag WHERE enrollment_id = $1", [enrollment])).toBe(0);
      expect(
        await count("quest_completion WHERE enrollment_id = $1 AND device_id IS NOT NULL", [
          enrollment,
        ]),
      ).toBe(0);
      expect(await count("quest_completion WHERE enrollment_id = $1", [enrollment])).toBe(1);
      expect(
        await owner(
          `SELECT t.reason FROM ledger_note t JOIN ledger_entry l ON l.id = t.entry_id WHERE l.enrollment_id = $1`,
          [enrollment],
        ),
      ).toEqual([{ reason: null }]);
      expect(
        await owner<{ score: string; balance: string; total: string }>(
          `SELECT n.score, n.balance, (SELECT sum(score_delta) FROM ledger_entry l WHERE l.enrollment_id = n.id) AS total
           FROM enrollment n WHERE n.id = $1`,
          [enrollment],
        ),
      ).toEqual(before);
      expect(await owner("SELECT status FROM enrollment WHERE id = $1", [enrollment])).toEqual([
        { status: "left" },
      ]);
      expect(
        await owner(
          "SELECT actor_type, action, after FROM audit_log WHERE action = 'player.delete' AND target_id = $1",
          [gone.id],
        ),
      ).toEqual([
        {
          actor_type: "system",
          action: "player.delete",
          after: { events: 1, forfeited: 0, marks: 2 },
        },
      ]);
    });

    it("cannot sign in, refresh, or be found by name, and a repeat of the token answers replayed", async () => {
      const event = await newEvent();
      const gone = await newPlayer();
      await join(gone.id, event);
      const deletion = await tokenFor(gone);
      expect(await erase(deletion)).toMatchObject({ outcome: "erased" });
      expect(await erase(deletion)).toEqual({ outcome: "replayed", events: [] });
      expect(await erase(bytes())).toEqual({ outcome: "expired", events: [] });
      const players = await as<{ username: string | null; status: string }>(
        teamA(),
        "SELECT username, status FROM event_players($1, NULL, 50, NULL)",
        [event.id],
      );
      expect(players).toEqual([{ username: null, status: "left" }]);
      expect(
        await as(teamA(), "SELECT 1 FROM event_players($1, NULL, 50, 'gone')", [event.id]),
      ).toEqual([]);
      expect((await startCode(gone.email)).known).toBe(false);
    });

    it("makes no mark when the account was neither banned nor welcomed", async () => {
      const event = await newEvent();
      const gone = await newPlayer();
      await join(gone.id, event);
      expect(await deleteAccount(gone)).toMatchObject({ outcome: "erased" });
      expect(
        await count("erased_mark WHERE fingerprint = ANY ($1)", [[fp(gone.phone), fp(gone.email)]]),
      ).toBe(0);
    });
  });

  describe("the deletion code", () => {
    it("answers a known and an unknown contact the same way; an unknown one's code is always wrong", async () => {
      const unknown = await startCode("nobody@example.com");
      expect(unknown.known).toBe(false);
      expect(await verify(unknown)).toMatchObject({ outcome: "wrong", attempts_left: 2 });
      expect(await verify(unknown)).toMatchObject({ outcome: "wrong", attempts_left: 1 });
      expect(await verify(unknown)).toMatchObject({ outcome: "wrong", attempts_left: 0 });
      expect(await verify(unknown)).toMatchObject({ outcome: "expired" });

      const gone = await newPlayer();
      const known = await startCode(gone.phone, "phone");
      expect(known.known).toBe(true);
      expect(await verify(known, bytes())).toMatchObject({ outcome: "wrong", attempts_left: 2 });
      expect(await verify(known)).toMatchObject({ outcome: "verified" });
      expect(await verify(known)).toMatchObject({ outcome: "expired" });
    });

    it("never signs in, and a new code for the contact ends the earlier one", async () => {
      const gone = await newPlayer();
      const first = await startCode(gone.email);
      const [signIn] = await as<{ outcome: string }>(
        {},
        "SELECT * FROM sign_in_player($1, $2, $3, $4, $5, $6)",
        [sha(first.token), first.code, bytes(), bytes(), randomUUID(), bytes()],
      );
      expect(signIn?.outcome).toBe("expired");
      await startCode(gone.email);
      expect(await verify(first)).toMatchObject({ outcome: "expired" });
    });

    it("lets a token go stale after 10 minutes", async () => {
      const gone = await newPlayer();
      const deletion = await tokenFor(gone);
      await owner(
        "UPDATE player_deletion_challenge SET deletion_expires_at = now() - interval '1 second' WHERE deletion_hash = $1",
        [sha(deletion)],
      );
      expect(await erase(deletion)).toEqual({ outcome: "expired", events: [] });
      expect(await owner("SELECT status FROM player WHERE id = $1", [gone.id])).toEqual([
        { status: "active" },
      ]);
    });
  });

  describe("marks (FR-1704, ADR-176)", () => {
    it("refuses a re-sign-up's join where the account was banned, and skips a welcome it already got", async () => {
      const banned = await newEvent({ welcome: 20 });
      const welcomed = await newEvent({ welcome: 30 });
      const gone = await newPlayer();
      await join(gone.id, banned);
      await join(gone.id, welcomed);
      await owner("UPDATE enrollment SET status = 'banned' WHERE id = $1", [
        await enrollmentOf(gone.id, banned),
      ]);
      expect(await deleteAccount(gone)).toMatchObject({ outcome: "erased" });

      const again = await newcomerWith(gone.phone);
      expect(await join(again, banned)).toMatchObject({
        outcome: "not_allowed",
        enrollment_id: null,
      });
      expect(await join(again, welcomed)).toMatchObject({ outcome: "joined", welcome: 0 });
      expect(
        await count("ledger_entry WHERE enrollment_id = $1", [await enrollmentOf(again, welcomed)]),
      ).toBe(0);
      const stranger = await newPlayer();
      expect(await join(stranger.id, banned)).toMatchObject({ outcome: "joined", welcome: 20 });
    });

    it("keeps a ban through a contact the account held before a change", async () => {
      const event = await newEvent();
      const earlier = `+9665${String(60_000_000 + counter).slice(-8)}`;
      const gone = await newPlayer([earlier]);
      await join(gone.id, event);
      await owner("UPDATE enrollment SET status = 'banned' WHERE id = $1", [
        await enrollmentOf(gone.id, event),
      ]);
      await deleteAccount(gone);
      expect(await join(await newcomerWith(earlier), event)).toMatchObject({
        outcome: "not_allowed",
      });
    });

    it("lets a welcome mark end with the event, while a ban mark stays", async () => {
      const event = await newEvent({ welcome: 10 });
      const gone = await newPlayer();
      await join(gone.id, event);
      await deleteAccount(gone);
      expect(
        await owner<{ kind: string; ends: boolean }>(
          `SELECT m.kind, m.expires_at = e.ends_at AS ends FROM erased_mark m JOIN event e ON e.id = m.event_id
           WHERE m.fingerprint = $1`,
          [fp(gone.email)],
        ),
      ).toEqual([{ kind: "welcomed", ends: true }]);
      await owner(
        "UPDATE erased_mark SET expires_at = now() - interval '1 second' WHERE fingerprint = $1",
        [fp(gone.email)],
      );
      expect(await join(await newcomerWith(gone.email), event)).toMatchObject({ welcome: 10 });
    });

    it("lets a platform-banned account delete itself, then refuses its contact at sign-in and in a contact change", async () => {
      const gone = await newPlayer();
      await owner("UPDATE player SET status = 'banned' WHERE id = $1", [gone.id]);
      expect(await deleteAccount(gone)).toMatchObject({ outcome: "erased" });
      expect(
        await owner("SELECT event_id, kind FROM erased_mark WHERE fingerprint = $1", [
          fp(gone.phone),
        ]),
      ).toEqual([{ event_id: null, kind: "banned" }]);

      const token = bytes();
      const code = bytes();
      await as({}, "SELECT start_player_challenge($1, $2, 'phone', $3, $4, $5, '0.1', '0.1', $6)", [
        randomUUID(),
        sha(token),
        gone.phone,
        bytes(),
        code,
        fp(gone.phone),
      ]);
      const [signIn] = await as<{ outcome: string }>(
        {},
        "SELECT * FROM sign_in_player($1, $2, $3, $4, $5, $6)",
        [sha(token), code, bytes(), bytes(), randomUUID(), bytes()],
      );
      expect(signIn?.outcome).toBe("banned");

      const other = await newPlayer();
      const changeToken = bytes();
      const changeCode = bytes();
      await as({ playerId: other.id }, "SELECT start_contact_change($1, $2, 'phone', $3, $4, $5)", [
        randomUUID(),
        sha(changeToken),
        gone.phone,
        changeCode,
        fp(gone.phone),
      ]);
      const [changed] = await as<{ outcome: string }>(
        { playerId: other.id },
        "SELECT * FROM confirm_contact_change($1, $2, $3)",
        [sha(changeToken), changeCode, randomUUID()],
      );
      expect(changed?.outcome).toBe("taken");
    });

    it("records the fingerprint at sign-up and at a contact change", async () => {
      const token = bytes();
      const code = bytes();
      const signup = bytes();
      const phone = "+966588880001";
      await as({}, "SELECT start_player_challenge($1, $2, 'phone', $3, $4, $5, '0.1', '0.1', $6)", [
        randomUUID(),
        sha(token),
        phone,
        bytes(),
        code,
        fp(phone),
      ]);
      await as({}, "SELECT * FROM sign_in_player($1, $2, $3, $4, $5, $6)", [
        sha(token),
        code,
        bytes(),
        bytes(),
        randomUUID(),
        sha(signup),
      ]);
      const [made] = await as<{ player_id: string }>(
        {},
        "SELECT * FROM create_player($1, 'fresh_fp', 1990, 'falcon', $2, $3, $4)",
        [sha(signup), bytes(), bytes(), randomUUID()],
      );
      const player = made?.player_id ?? "";
      const changeToken = bytes();
      const changeCode = bytes();
      await as(
        { playerId: player },
        "SELECT start_contact_change($1, $2, 'email', 'fresh_fp@example.com', $3, $4)",
        [randomUUID(), sha(changeToken), changeCode, fp("fresh_fp@example.com")],
      );
      await as({ playerId: player }, "SELECT * FROM confirm_contact_change($1, $2, $3)", [
        sha(changeToken),
        changeCode,
        randomUUID(),
      ]);
      const held = await owner<{ fingerprint: Buffer }>(
        "SELECT fingerprint FROM player_fingerprint WHERE player_id = $1 ORDER BY created_at",
        [player],
      );
      expect(held.map((row) => row.fingerprint.toString("hex")).toSorted()).toEqual(
        [fp(phone), fp("fresh_fp@example.com")].map((value) => value.toString("hex")).toSorted(),
      );
    });
  });

  describe("pending handovers (FR-128, ADR-178)", () => {
    it("lists a reservation and changes nothing without a forfeit; with one it ends the reservation and gives the unit back", async () => {
      const event = await newEvent({ welcome: 20 });
      const gone = await newPlayer();
      await join(gone.id, event);
      const [reserved] = await as<{ redemption_id: string }>(
        { playerId: gone.id },
        "SELECT * FROM reserve_reward($1, $2)",
        [event.reward, randomUUID()],
      );
      const deletion = await tokenFor(gone);
      expect(
        await as({}, "SELECT redemption_id, item_en, rank_prize FROM deletion_pending($1)", [
          sha(deletion),
        ]),
      ).toEqual([{ redemption_id: reserved?.redemption_id, item_en: "Spa", rank_prize: false }]);
      expect(await erase(deletion)).toEqual({ outcome: "handover_pending", events: [] });
      expect(await owner("SELECT status FROM player WHERE id = $1", [gone.id])).toEqual([
        { status: "active" },
      ]);

      expect(await erase(deletion, true)).toMatchObject({ outcome: "erased" });
      expect(
        await owner("SELECT status, ended_by FROM redemption WHERE id = $1", [
          reserved?.redemption_id,
        ]),
      ).toEqual([{ status: "cancelled", ended_by: "erasure" }]);
      expect(await owner("SELECT units_out FROM reward WHERE id = $1", [event.reward])).toEqual([
        { units_out: 0 },
      ]);
      expect(
        await owner("SELECT kind, actor FROM ledger_entry WHERE redemption_id = $1 ORDER BY id", [
          reserved?.redemption_id,
        ]),
      ).toEqual([
        { kind: "redeem", actor: "player" },
        { kind: "redeem_return", actor: "system" },
      ]);
    });

    it("keeps a forfeited rank prize on its place as cancelled, the order and score frozen, the name gone", async () => {
      const [event] = await owner<{ id: string }>(
        `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at, desk_location_en)
         VALUES ($1, 'DELRANK', 'Prize Fest', 'live', now() - interval '2 days', now() - interval '1 hour', 'Hall B')
         RETURNING id`,
        [ids.orgA],
      );
      const eventId = event?.id ?? "";
      const [category] = await owner<{ id: string }>(
        "INSERT INTO category (event_id, name_en) VALUES ($1, 'General') RETURNING id",
        [eventId],
      );
      const players = [await newPlayer(), await newPlayer()];
      for (const [index, player] of players.entries()) {
        const [enrolled] = await owner<{ id: string }>(
          "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3) RETURNING id",
          [ids.orgA, eventId, player.id],
        );
        const [quest] = await owner<{ id: string }>(
          `INSERT INTO quest (event_id, category_id, type, title_en, points, visible, type_config)
           VALUES ($1, $2, 'scan_qr', 'Lion', $3, true, '{}') RETURNING id`,
          [eventId, category?.id, 50 - index * 10],
        );
        const [done] = await owner<{ id: string }>(
          `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                         idempotency_key, created_at)
           VALUES ($1, $2, $3, $4, 1, 'qr', $5, now() - interval '2 hours') RETURNING id`,
          [ids.orgA, eventId, enrolled?.id, quest?.id, randomUUID()],
        );
        await owner(
          `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                     completion_id, quest_id, actor)
           VALUES ($1, $2, $3, 'quest', $4, $4, $5, $6, 'player')`,
          [ids.orgA, eventId, enrolled?.id, 50 - index * 10, done?.id, quest?.id],
        );
      }
      await owner(
        `INSERT INTO rank_prize (event_id, rank_from, rank_to, kind, name_en, name_ar)
         VALUES ($1, 1, 1, 'item', 'Trophy', 'كأس')`,
        [eventId],
      );
      const places = async () =>
        as<{
          rank: number;
          username: string | null;
          score: string;
          redemption_status: string | null;
        }>(teamA(), "SELECT rank, username, score, redemption_status FROM results_places($1)", [
          eventId,
        ]);
      const seen = (await places()).map((place) => place);
      const expected = (
        await as<{ enrollment_id: string }>(
          teamA(),
          "SELECT enrollment_id FROM results_places($1)",
          [eventId],
        )
      ).map((row) => row.enrollment_id);
      expect(seen).toHaveLength(2);
      await as(teamA(), "SELECT confirm_results($1, $2, $3)", [eventId, expected, randomUUID()]);
      await as(teamA(), "SELECT reveal_results($1, $2, $3)", [
        eventId,
        new Date(Date.now() + 24 * HOUR),
        randomUUID(),
      ]);
      const winner = players[0] as Player;
      const deletion = await tokenFor(winner);
      expect(
        await as({}, "SELECT rank_prize, item_en FROM deletion_pending($1)", [sha(deletion)]),
      ).toEqual([{ rank_prize: true, item_en: "Trophy" }]);
      expect(await erase(deletion, true)).toMatchObject({ outcome: "erased" });
      const after = await places();
      expect(after.map((place) => [place.rank, place.username, place.score])).toEqual([
        [1, null, "50"],
        [
          2,
          (
            await owner<{ username: string }>("SELECT username FROM player WHERE id = $1", [
              players[1]?.id,
            ])
          )[0]?.username,
          "40",
        ],
      ]);
      expect(after[0]?.redemption_status).toBe("cancelled");
      const member = await as<{ rank: number; username: string | null }>(
        { playerId: players[1]?.id ?? "" },
        "SELECT rank, username FROM event_results($1)",
        [eventId],
      );
      expect(member[0]).toEqual({ rank: 1, username: null });
    });
  });

  describe("the readers that show a deleted player", () => {
    it("names a deleted operator's claimed invite and a deleted player's ledger lines with no name", async () => {
      const event = await newEvent();
      const gone = await newPlayer();
      await join(gone.id, event);
      const enrollment = await enrollmentOf(gone.id, event);
      await as(teamA(), "SELECT * FROM staff_award($1, $2, NULL, 3, 'Thanks', $3, $4)", [
        event.id,
        enrollment,
        randomUUID(),
        randomUUID(),
      ]);
      const [invite] = await owner<{ id: string }>(
        `INSERT INTO operator_invite (organizer_id, event_id, kind, label, abilities, created_by, expires_at,
                                      claimed_by, claimed_at)
         VALUES ($1, $2, 'personal', 'Gate', '{scan_quests}', $3, now() + interval '1 day', $4, now()) RETURNING id`,
        [ids.orgA, event.id, ownerA, gone.id],
      );
      await deleteAccount(gone);
      const invites = await as<{
        id: string;
        claimed_by_username: string | null;
        claimed: boolean;
      }>(
        teamA(),
        "SELECT id, claimed_by_username, claimed_at IS NOT NULL AS claimed FROM event_operator_invites($1)",
        [event.id],
      );
      expect(invites.find((row) => row.id === invite?.id)).toMatchObject({
        claimed_by_username: null,
        claimed: true,
      });
      const lines = await as<{ enrollment_id: string; username: string | null }>(
        teamA(),
        "SELECT enrollment_id, username FROM manual_awards($1, NULL, 50)",
        [event.id],
      );
      expect(lines.filter((line) => line.enrollment_id === enrollment)).not.toHaveLength(0);
      expect(
        lines.filter((line) => line.enrollment_id === enrollment).map((line) => line.username),
      ).toEqual(lines.filter((line) => line.enrollment_id === enrollment).map(() => null));
    });
  });

  /**
   * Holds a deletion open, starts `work` on another connection, waits until it blocks on the deletion's locks,
   * commits the deletion and returns how `work` ended.
   */
  const whileDeleting = async (player: Player, work: (client: Client) => Promise<unknown>) => {
    const deletion = await tokenFor(player);
    const holder = await connect();
    const other = await connect();
    try {
      await holder.query("BEGIN");
      const [held] = (
        await holder.query<Erased>("SELECT outcome, events FROM erase_player($1, true, $2)", [
          sha(deletion),
          randomUUID(),
        ])
      ).rows;
      expect(held?.outcome).toBe("erased");
      const pid = await pidOf(other);
      const running = work(other).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error: String(error) }),
      );
      await waitUntilBlocked(pid);
      await holder.query("COMMIT");
      return await running;
    } finally {
      await Promise.all([holder.end(), other.end()]);
    }
  };

  describe("races", () => {
    it("makes a join in flight wait for the deletion, then refuse", async () => {
      const event = await newEvent({ welcome: 5 });
      const gone = await newPlayer();
      const ended = await whileDeleting(gone, (client) => join(gone.id, event, client));
      expect(ended).toMatchObject({
        ok: false,
        error: expect.stringMatching(/not an active player/),
      });
      expect(await count("enrollment WHERE player_id = $1", [gone.id])).toBe(0);
    });

    it("makes a join request in flight wait for the deletion, then refuse", async () => {
      const event = await newEvent({ access: "private" });
      const gone = await newPlayer();
      const ended = await whileDeleting(gone, (client) => join(gone.id, event, client));
      expect(ended).toMatchObject({
        ok: false,
        error: expect.stringMatching(/not an active player/),
      });
      expect(await count("enrollment WHERE player_id = $1", [gone.id])).toBe(0);
    });

    it("makes a reservation in flight wait for the deletion, then refuse", async () => {
      const event = await newEvent({ welcome: 20 });
      const gone = await newPlayer();
      await join(gone.id, event);
      const ended = await whileDeleting(gone, (client) =>
        as(
          { playerId: gone.id },
          "SELECT * FROM reserve_reward($1, $2)",
          [event.reward, randomUUID()],
          client,
        ),
      );
      expect(ended).toMatchObject({ ok: false });
      expect(await count("redemption WHERE event_id = $1", [event.id])).toBe(0);
    });

    it("makes an operator's My QR scan in flight wait for the deletion, then refuse", async () => {
      const event = await newEvent();
      const gone = await newPlayer();
      await join(gone.id, event);
      const operator = await newPlayer();
      await owner(
        `INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities)
         VALUES ($1, $2, $3, '{scan_quests}')`,
        [ids.orgA, event.id, operator.id],
      );
      const [booth] = await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, verification)
         SELECT $1, q.category_id, 'scan_qr', 'Desk', 10, '{my_qr}' FROM quest q WHERE q.id = $2 RETURNING id`,
        [event.id, event.quest],
      );
      const ended = await whileDeleting(gone, (client) =>
        as(
          { playerId: operator.id },
          "SELECT * FROM operator_complete_quest($1, $2, 1, $3)",
          [booth?.id, gone.id, randomUUID()],
          client,
        ),
      );
      expect(ended).toMatchObject({ ok: false });
      expect(await count("quest_completion WHERE quest_id = $1", [booth?.id])).toBe(0);
    });
  });

  describe("closed doors", () => {
    it("keeps the erasure helpers and the new tables away from the API role", async () => {
      for (const sql of [
        "SELECT * FROM player_fingerprint",
        "SELECT * FROM erased_mark",
        "SELECT * FROM player_deletion_challenge",
        "SELECT erased_marked(gen_random_uuid(), NULL, 'banned')",
        "SELECT platform_marked('\\x00')",
        "SELECT deletion_holder('\\x00')",
        "SELECT erase_rows(gen_random_uuid(), '{}', NULL)",
      ]) {
        await expect(db.app.query(sql), sql).rejects.toThrow(/permission denied/);
      }
    });
  });
});
