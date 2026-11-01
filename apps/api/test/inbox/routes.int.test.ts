import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Row = Record<string, unknown>;

/**
 * The owner's Inbox counts over HTTP (T-616, FR-1825): the open help requests by kind, join requests, submissions and
 * flags in one read, counts only, for the event's own team.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("inbox over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let organizer = "";
  let event = "";
  let ownerCookie = "";
  let counter = 0;

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  const newEvent = async (access = "public"): Promise<string> => {
    counter += 1;
    const [row] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, access, starts_at, ends_at)
       VALUES ($1, $2, 'Inbox Fest', 'live', $3, now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
      [organizer, `INB${counter}`, access],
    );
    const id = row?.id ?? "";
    await owner("INSERT INTO category (event_id, name_en) VALUES ($1, 'General')", [id]);
    return id;
  };
  const addPlayer = async (ev: string, status = "active") => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`inbox_${counter}`],
    );
    const [enrolled] = await owner<{ id: string }>(
      "INSERT INTO enrollment (organizer_id, event_id, player_id, status) VALUES ($1, $2, $3, $4) RETURNING id",
      [organizer, ev, player?.id, status],
    );
    return {
      player: player?.id ?? "",
      enrollment: enrolled?.id ?? "",
      username: `inbox_${counter}`,
    };
  };
  const ask = async (ev: string, who: Awaited<ReturnType<typeof addPlayer>>, kind: string) =>
    owner(
      `INSERT INTO ticket (player_id, organizer_id, event_id, enrollment_id, kind, body, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, 'Where is my prize?', $6)`,
      [who.player, organizer, ev, who.enrollment, kind, randomUUID()],
    );
  const read = (ev: string, cookie: string | null = ownerCookie, org = organizer) =>
    test.app.inject({
      method: "GET",
      url: `/v1/organizers/${org}/events/${ev}/inbox`,
      ...(cookie === null ? {} : { headers: withSession(cookie) }),
    });

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
    organizer =
      (
        await db.owner.query<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ('inbox-org', 'inbox-org') RETURNING id",
        )
      ).rows[0]?.id ?? "";
    const ownerId = await createStaff(db.owner, { email: "owner@inbox.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [organizer, ownerId],
    );
    ownerCookie = await signInFully(test, "owner@inbox.test");
    event = await newEvent();
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  it("answers zeros for a quiet event, never cached", async () => {
    const answer = await read(await newEvent());
    expect(answer.statusCode).toBe(200);
    expect(answer.headers["cache-control"]).toBe("private, no-store");
    expect(answer.json()).toEqual({
      tickets: { question: 0, problem: 0, prize: 0, report_player: 0 },
      withQuestify: 0,
      joinRequests: { pending: 0, private: false },
      submissions: 0,
      flags: 0,
    });
  });

  it("counts what waits, by kind, and shows no player, name or text", async () => {
    const ev = await newEvent("private");
    const asker = await addPlayer(ev);
    await ask(ev, asker, "prize");
    await ask(ev, asker, "prize");
    await ask(ev, asker, "report_player");
    await addPlayer(ev, "pending");
    const body = (await read(ev)).json();
    expect(body.tickets).toEqual({ question: 0, problem: 0, prize: 2, report_player: 1 });
    expect(body.joinRequests).toEqual({ pending: 1, private: true });
    expect(JSON.stringify(body)).not.toMatch(new RegExp(`${asker.username}|Where is my prize`));
  });

  it("refuses a stranger, another organizer's team, a bad id and an unknown event", async () => {
    const rival = (
      await db.owner.query<{ id: string }>(
        "INSERT INTO organizer (name, slug) VALUES ('rival-inbox', 'rival-inbox') RETURNING id",
      )
    ).rows[0]?.id as string;
    const rivalStaff = await createStaff(db.owner, { email: "owner@rival-inbox.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [rival, rivalStaff],
    );
    const rivalCookie = await signInFully(test, "owner@rival-inbox.test");
    expect((await read(event, null)).statusCode).toBe(401);
    for (const [cookie, org, ev] of [
      [rivalCookie, rival, event],
      [rivalCookie, organizer, event],
      [ownerCookie, rival, event],
      [ownerCookie, organizer, randomUUID()],
    ] as const) {
      const refused = await read(ev, cookie, org);
      expect([refused.statusCode, refused.json().code]).toEqual([404, "not_found"]);
    }
    expect((await read("not-a-uuid")).statusCode).toBe(400);
  });

  it("keeps an editor to the events in their limit", async () => {
    const outside = await newEvent();
    const editor = await createStaff(db.owner, { email: "editor@inbox.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role, event_scope) VALUES ($1, $2, 'editor', $3)",
      [organizer, editor, [event]],
    );
    const cookie = await signInFully(test, "editor@inbox.test");
    expect((await read(event, cookie)).statusCode).toBe(200);
    expect((await read(outside, cookie)).statusCode).toBe(404);
  });
});
