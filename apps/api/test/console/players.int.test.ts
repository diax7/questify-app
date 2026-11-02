import { randomBytes, randomUUID } from "node:crypto";
import {
  ledgerPageSchema,
  playerRecordSchema,
  playerSearchSchema,
  revealedContactsSchema,
} from "@questify/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuthKeys } from "#src/auth/keys";
import { BUCKETS } from "#src/auth/throttle";
import {
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Row = Record<string, unknown>;
type Method = "GET" | "POST";

const PHONE = "+966512345671";
const EMAIL = "layla.records@example.test";
const NOTE = "Ticket 5512: the player proved the phone by code.";

/**
 * The console's player tools over HTTP (T-704): 404 to everyone but a platform admin; search and the contact reveal are
 * POST reads that are never kept or replayed; rename and reset take an Idempotency-Key; every action needs a reason;
 * no contact, code or note reaches a log line; per-admin rate limits.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("console player tools over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let adminId: string;
  let adminCookie: string;
  let memberCookie: string;
  let playerId: string;
  const lines: string[] = [];
  const keys = createAuthKeys("t".repeat(40));

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const audits = async (action: string) =>
    owner<{ actor_id: string; after: unknown }>(
      "SELECT actor_id, after FROM audit_log WHERE action = $1 ORDER BY id",
      [action],
    );
  const newPlayer = async (name: string, phone: string | null, email: string | null) => {
    const [made] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [name],
    );
    await owner("INSERT INTO player_contact (player_id, phone_e164, email) VALUES ($1, $2, $3)", [
      made?.id,
      phone,
      email,
    ]);
    return made?.id ?? "";
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db, {
      level: "info",
      stream: { write: (line: string) => void lines.push(line) },
    });
    adminId = await createStaff(db.owner, { email: "support@questify.test", admin: true });
    await createStaff(db.owner, { email: "owner@najd.test" });
    adminCookie = await signInFully(test, "support@questify.test");
    memberCookie = await signInFully(test, "owner@najd.test");
    playerId = await newPlayer("layla_records", PHONE, EMAIL);
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const call = (
    method: Method,
    url: string,
    cookie: string,
    payload?: object,
    key: string | null = randomUUID(),
  ) =>
    test.app.inject({
      method,
      url,
      headers: withSession(cookie, key === null ? {} : { "idempotency-key": key }),
      ...(payload === undefined ? {} : { payload }),
    });
  const reveal = { reasonCode: "support_request", note: NOTE };

  it("answers 404 to a member and 401 or 403 to nobody signed in, on every route", async () => {
    const paths: [Method, string, object?][] = [
      ["POST", "/v1/admin/players/search", { by: "username", q: "layla" }],
      ["GET", `/v1/admin/players/${playerId}`],
      ["GET", `/v1/admin/players/${playerId}/ledger`],
      ["POST", `/v1/admin/players/${playerId}/contact`, reveal],
      ["POST", `/v1/admin/players/${playerId}/username`, { ...reveal, username: "x_new_name" }],
      ["POST", `/v1/admin/players/${playerId}/reset-sign-in`, reveal],
    ];
    for (const [method, url, payload] of paths) {
      expect((await call(method, url, memberCookie, payload)).statusCode, url).toBe(404);
      const anonymous = await test.app.inject({
        method,
        url,
        headers: { "idempotency-key": randomUUID() },
        ...(payload === undefined ? {} : { payload }),
      });
      expect(anonymous.statusCode, url).toBeGreaterThanOrEqual(401);
      expect(anonymous.statusCode, url).toBeLessThanOrEqual(403);
    }
    expect(await owner("SELECT 1 FROM player_admin_action")).toEqual([]);
  });

  it("searches by a phone typed any way, masked, and never keeps or replays the answer", async () => {
    const key = randomUUID();
    const first = await call(
      "POST",
      "/v1/admin/players/search",
      adminCookie,
      { by: "phone", q: "0512 345 671" },
      key,
    );
    expect(first.statusCode).toBe(200);
    const players = playerSearchSchema.parse(first.json().players);
    expect(players.map((row) => row.id)).toEqual([playerId]);
    expect(players[0]?.contacts.phone).toBe("+9665•••••71");
    const again = await call(
      "POST",
      "/v1/admin/players/search",
      adminCookie,
      { by: "phone", q: "0512 345 671" },
      key,
    );
    expect(again.headers["idempotent-replayed"]).toBeUndefined();
    expect(await audits("console.players_search")).toHaveLength(2);
    const bad = await call("POST", "/v1/admin/players/search", adminCookie, {
      by: "email",
      q: "not an email",
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe("invalid_player_search");
  });

  it("shows the record and the points record, read-only, and answers 404 for an unknown player", async () => {
    const answer = await call("GET", `/v1/admin/players/${playerId}`, adminCookie);
    expect(answer.statusCode).toBe(200);
    expect(answer.headers["cache-control"]).toMatch(/no-store/);
    const shown = playerRecordSchema.parse(answer.json());
    expect(shown.player.username).toBe("layla_records");
    expect(shown.contacts).toEqual({ phone: "+9665•••••71", email: "l•••@example.test" });
    const ledger = await call("GET", `/v1/admin/players/${playerId}/ledger`, adminCookie);
    expect(ledgerPageSchema.parse(ledger.json().entries)).toEqual([]);
    expect(ledger.json().nextCursor).toBeNull();
    expect((await call("GET", `/v1/admin/players/${randomUUID()}`, adminCookie)).statusCode).toBe(
      404,
    );
  });

  it("reveals the contacts with a reason only, a fresh audit entry every time, without an Idempotency-Key", async () => {
    const short = await call("POST", `/v1/admin/players/${playerId}/contact`, adminCookie, {
      reasonCode: "support_request",
      note: "short",
    });
    expect(short.statusCode).toBe(400);
    expect(short.json().code).toBe("invalid_player_action");
    const wrongCode = await call("POST", `/v1/admin/players/${playerId}/contact`, adminCookie, {
      reasonCode: "offensive",
      note: NOTE,
    });
    expect(wrongCode.statusCode).toBe(400);
    const before = (await audits("console.player_contact_read")).length;
    for (let i = 0; i < 2; i += 1) {
      const shown = await call(
        "POST",
        `/v1/admin/players/${playerId}/contact`,
        adminCookie,
        reveal,
        null,
      );
      expect(shown.statusCode).toBe(200);
      expect(revealedContactsSchema.parse(shown.json())).toEqual({ phone: PHONE, email: EMAIL });
    }
    expect(await audits("console.player_contact_read")).toHaveLength(before + 2);
  });

  it("renames with the shared rules and an Idempotency-Key, and answers the refusals", async () => {
    await newPlayer("taken_by_other", null, "other@example.test");
    const url = `/v1/admin/players/${playerId}/username`;
    const body = { reasonCode: "offensive", note: NOTE };
    expect((await call("POST", url, adminCookie, { ...body, username: "a" })).json().code).toBe(
      "invalid_username",
    );
    expect(
      (await call("POST", url, adminCookie, { ...body, username: "TAKEN_by_other" })).statusCode,
    ).toBe(409);
    expect(
      (await call("POST", url, adminCookie, { ...body, username: "layla_records" })).json().code,
    ).toBe("username_unchanged");
    const missingKey = await call(
      "POST",
      url,
      adminCookie,
      { ...body, username: "layla_new" },
      null,
    );
    expect(missingKey.statusCode).toBe(400);
    const done = await call("POST", url, adminCookie, { ...body, username: "layla_new" });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ username: "layla_new" });
    expect(
      (
        await owner<{ username: string }>("SELECT username FROM player WHERE id = $1", [playerId])
      )[0]?.username,
    ).toBe("layla_new");
  });

  it("resets sign-in: ends the tokens and clears the contacts' code throttles, keeping the others", async () => {
    const family = randomUUID();
    const session = randomBytes(32);
    await owner(
      `INSERT INTO player_refresh (player_id, family, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + interval '180 days')`,
      [playerId, family, randomBytes(32)],
    );
    await owner(
      `INSERT INTO player_session (player_id, token_hash, expires_at, refresh_family)
       VALUES ($1, $2, now() + interval '1 hour', $3)`,
      [playerId, session, family],
    );
    const mine = [keys.contactThrottleKey(PHONE), keys.contactThrottleKey(EMAIL)];
    const elsewhere = keys.contactThrottleKey("+966599999999");
    for (const key of [...mine, elsewhere]) {
      for (const bucket of [BUCKETS.playerCodeContact, BUCKETS.playerFailContact]) {
        await owner("INSERT INTO auth_throttle (bucket, key, at) VALUES ($1, $2, now())", [
          bucket,
          key,
        ]);
      }
    }
    const address = keys.addressKey("203.0.113.0");
    await owner("INSERT INTO auth_throttle (bucket, key, at) VALUES ($1, $2, now())", [
      BUCKETS.playerCodeAddress,
      address,
    ]);
    const done = await call("POST", `/v1/admin/players/${playerId}/reset-sign-in`, adminCookie, {
      reasonCode: "locked_out",
      note: NOTE,
    });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ endedSignIns: 1 });
    const left = async (key: Buffer) =>
      (await owner("SELECT 1 FROM auth_throttle WHERE key = $1", [key])).length;
    expect(await left(mine[0] ?? Buffer.alloc(0))).toBe(0);
    expect(await left(mine[1] ?? Buffer.alloc(0))).toBe(0);
    expect(await left(elsewhere)).toBe(2);
    expect(await left(address)).toBe(1);
    expect(
      (
        await owner("SELECT 1 FROM player_session WHERE token_hash = $1 AND revoked_at IS NULL", [
          session,
        ])
      ).length,
    ).toBe(0);
  });

  it("holds an admin to 20 contact reveals an hour", async () => {
    const key = keys.userKey(`${BUCKETS.consolePlayerContact}:${adminId}`);
    await owner(
      "INSERT INTO auth_throttle (bucket, key, at) SELECT $1, $2, now() FROM generate_series(1, 20)",
      [BUCKETS.consolePlayerContact, key],
    );
    const refused = await call(
      "POST",
      `/v1/admin/players/${playerId}/contact`,
      adminCookie,
      reveal,
    );
    expect(refused.statusCode).toBe(429);
    expect(refused.headers["retry-after"]).toBeDefined();
  });

  it("writes no contact, note or searched text to any log line", () => {
    const logged = lines.join("\n");
    for (const secret of [PHONE, EMAIL, NOTE, "0512 345 671", "512345671"]) {
      expect(logged).not.toContain(secret);
    }
  });
});
