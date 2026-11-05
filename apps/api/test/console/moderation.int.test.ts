import { createHash, randomBytes, randomUUID } from "node:crypto";
import { reportDetailSchema, reportQueueSchema, teamHoldsSchema } from "@questify/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createStaff,
  signInConsole,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Row = Record<string, unknown>;
type Method = "GET" | "POST" | "PATCH";

const NOTE = "The quest title uses a slur against a group.";

/**
 * Reports and moderation over HTTP (T-705b): a player's report (the same answer for a repeat, 404 for what they cannot
 * see, 422 for a mixed target, no username in any access log line), the console's queue, one target's reports,
 * closing them, unpublishing and republishing, the flags list (404 to anyone but an admin), the team's held items, and
 * HD423 answered as one clear 423 when the team tries to show a held quest.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("reports and moderation over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let adminCookie: string;
  let teamCookie: string;
  let org: string;
  let event: string;
  let quest: string;
  let serial = 0;
  const lines: string[] = [];

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const player = async () => {
    serial += 1;
    const username = `reporter_${serial}`;
    const [row] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [username],
    );
    const token = randomBytes(32).toString("base64url");
    await owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [row?.id, createHash("sha256").update(token).digest()],
    );
    await owner("INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)", [
      org,
      event,
      row?.id,
    ]);
    return { id: row?.id ?? "", username, token };
  };
  const send = (token: string, payload: object) =>
    test.app.inject({
      method: "POST",
      url: "/v1/reports",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": randomUUID() },
      payload,
    });
  const call = (method: Method, url: string, cookie: string, payload?: object) =>
    test.app.inject({
      method,
      url,
      headers: withSession(
        cookie,
        method === "GET" ? {} : { "idempotency-key": randomUUID() },
        url,
      ),
      ...(payload === undefined ? {} : { payload }),
    });

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db, {
      level: "info",
      stream: { write: (line: string) => void lines.push(line) },
    });
    await createStaff(db.owner, { email: "mod@questify.test", admin: true });
    const staff = await createStaff(db.owner, { email: "owner@mod.test" });
    adminCookie = await signInConsole(test, "mod@questify.test");
    teamCookie = await signInFully(test, "owner@mod.test");
    [org] = (
      await owner<{ id: string }>(
        "INSERT INTO organizer (name, slug) VALUES ('Mod Org', 'mod-org') RETURNING id",
      )
    ).map((row) => row.id ?? "") as [string];
    await owner(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [org, staff],
    );
    [event] = (
      await owner<{ id: string }>(
        `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
         VALUES ($1, 'MOD1', 'Mod Fest', 'live', now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
        [org],
      )
    ).map((row) => row.id ?? "") as [string];
    [quest] = (
      await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, visible, type_config)
         SELECT $1, id, 'scan_qr', 'Rude quest', 10, true, '{}' FROM category WHERE event_id = $1 LIMIT 1
         RETURNING id`,
        [event],
      )
    ).map((row) => row.id ?? "") as [string];
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  it("takes a report once, answers a repeat the same, and keeps the name out of the access log", async () => {
    const [me, other] = [await player(), await player()];
    const first = await send(me.token, { kind: "quest", targetId: quest, reason: "offensive" });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toEqual({ status: "received" });
    expect(
      (await send(me.token, { kind: "quest", targetId: quest, reason: "spam" })).statusCode,
    ).toBe(201);
    const named = await send(me.token, {
      kind: "username",
      username: other.username,
      eventId: event,
      reason: "hateful",
    });
    expect(named.statusCode).toBe(201);
    expect(await owner("SELECT count(*)::int AS n FROM content_report")).toEqual([{ n: 2 }]);
    expect(lines.filter((line) => line.includes(other.username))).toEqual([]);
    for (const payload of [
      { kind: "quest", reason: "spam" },
      { kind: "username", targetId: quest, username: other.username, reason: "spam" },
      { kind: "quest", targetId: quest, eventId: event, reason: "spam" },
    ]) {
      expect((await send(me.token, payload)).statusCode, JSON.stringify(payload)).toBe(422);
    }
    expect(
      (await send(me.token, { kind: "quest", targetId: quest, reason: "rude" })).statusCode,
    ).toBe(400);
    expect(
      (await send(me.token, { kind: "quest", targetId: randomUUID(), reason: "spam" })).statusCode,
    ).toBe(404);
    const anonymous = await test.app.inject({
      method: "POST",
      url: "/v1/reports",
      headers: { "idempotency-key": randomUUID() },
      payload: { kind: "quest", targetId: quest, reason: "spam" },
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it("answers 404 to a team member on every console route", async () => {
    for (const [method, url, payload] of [
      ["GET", "/v1/admin/reports"],
      ["GET", `/v1/admin/reports/quest/${quest}`],
      ["POST", `/v1/admin/reports/quest/${quest}/resolve`, { outcome: "dismissed" }],
      [
        "POST",
        "/v1/admin/holds",
        { kind: "quest", targetId: quest, reasonCode: "spam", note: NOTE },
      ],
      ["POST", "/v1/admin/holds/release", { kind: "quest", targetId: quest, note: NOTE }],
      ["GET", "/v1/admin/flags"],
    ] as [Method, string, object?][]) {
      expect((await call(method, url, teamCookie, payload)).statusCode, url).toBe(404);
    }
  });

  it("lists the queue, shows a target, unpublishes, walls the team and republishes", async () => {
    const queue = await call("GET", "/v1/admin/reports?kind=quest", adminCookie);
    expect(queue.statusCode).toBe(200);
    const parsed = reportQueueSchema.parse(queue.json());
    expect(parsed.targets.map((one) => one.targetId)).toContain(quest);
    const detail = reportDetailSchema.parse(
      (await call("GET", `/v1/admin/reports/quest/${quest}`, adminCookie)).json(),
    );
    expect(detail.reports).toHaveLength(1);
    expect(detail.current?.title?.en).toBe("Rude quest");
    expect(
      (await call("GET", `/v1/admin/reports/quest/${randomUUID()}`, adminCookie)).statusCode,
    ).toBe(404);

    const bad = await call("POST", "/v1/admin/holds", adminCookie, {
      kind: "quest",
      targetId: quest,
      reasonCode: "offensive",
      note: "short",
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: "invalid_hold" });
    const held = await call("POST", "/v1/admin/holds", adminCookie, {
      kind: "quest",
      targetId: quest,
      reasonCode: "offensive",
      note: NOTE,
    });
    expect(held.statusCode).toBe(201);
    expect(held.json()).toMatchObject({ outcome: "unpublished" });
    const again = await call("POST", "/v1/admin/holds", adminCookie, {
      kind: "quest",
      targetId: quest,
      reasonCode: "offensive",
      note: NOTE,
    });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ outcome: "already_unpublished" });

    const holds = teamHoldsSchema.parse(
      (await call("GET", `/v1/organizers/${org}/events/${event}/content-holds`, teamCookie)).json(),
    );
    expect(holds.holds).toEqual([
      expect.objectContaining({
        kind: "quest",
        targetId: quest,
        reasonCode: "offensive",
        note: NOTE,
      }),
    ]);
    const shown = await call(
      "PATCH",
      `/v1/organizers/${org}/events/${event}/quests/${quest}`,
      teamCookie,
      { visible: true, confirm: true },
    );
    expect(shown.statusCode).toBe(423);
    expect(shown.json()).toMatchObject({ code: "content_held" });

    const release = { kind: "quest", targetId: quest, note: "The organizer fixed the title." };
    expect((await call("POST", "/v1/admin/holds/release", adminCookie, release)).statusCode).toBe(
      204,
    );
    const twice = await call("POST", "/v1/admin/holds/release", adminCookie, release);
    expect(twice.statusCode).toBe(409);
    expect(twice.json()).toMatchObject({ code: "not_unpublished" });
  });

  it("closes a target's reports with the action taken and lists the flags", async () => {
    const [me] = [await player()];
    await send(me.token, { kind: "event", targetId: event, reason: "misleading" });
    const closed = await call("POST", `/v1/admin/reports/event/${event}/resolve`, adminCookie, {
      outcome: "event_suspended",
    });
    expect(closed.json()).toEqual({ closed: 1 });
    expect(
      (
        await call("POST", `/v1/admin/reports/event/${event}/resolve`, adminCookie, {
          outcome: "nothing",
        })
      ).statusCode,
    ).toBe(400);
    const flags = await call("GET", "/v1/admin/flags", adminCookie);
    expect(flags.statusCode).toBe(200);
    expect(flags.json()).toMatchObject({ events: [], total: 0 });
  });
});
