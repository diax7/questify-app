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

const GOOD = {
  titleAr: "تغيير البوابة",
  titleEn: "Gate change",
  bodyAr: "البوابة 3 مغلقة. استخدموا البوابة 1.",
  bodyEn: "Gate 3 is closed. Use gate 1.",
};

/**
 * Operator activity and the staff briefing over HTTP (T-617, FR-1844): the Operators page's read, and a short push to the
 * event's operators only, once per Idempotency-Key, for the event's own team.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("operator activity over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let organizer = "";
  let event = "";
  let ownerCookie = "";
  let counter = 0;

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  const newEvent = async (status = "live"): Promise<string> => {
    counter += 1;
    const [row] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, access, starts_at, ends_at)
       VALUES ($1, $2, 'Activity Fest', $3, 'public', now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
      [organizer, `ACT${counter}`, status],
    );
    const id = row?.id ?? "";
    await owner("INSERT INTO category (event_id, name_en) VALUES ($1, 'General')", [id]);
    return id;
  };
  const newOperator = async (ev: string) => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`activity_${counter}`],
    );
    await owner(
      "INSERT INTO staff_assignment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)",
      [organizer, ev, player?.id],
    );
    return { player: player?.id ?? "", username: `activity_${counter}` };
  };
  const read = (
    ev: string,
    options: Readonly<{ cookie?: string | null; org?: string; query?: string }> = {},
  ) => {
    const cookie = options.cookie === undefined ? ownerCookie : options.cookie;
    return test.app.inject({
      method: "GET",
      url: `/v1/organizers/${options.org ?? organizer}/events/${ev}/operators/activity${options.query ?? ""}`,
      ...(cookie === null ? {} : { headers: withSession(cookie) }),
    });
  };
  const brief = (
    ev: string,
    options: Readonly<{
      cookie?: string | null;
      org?: string;
      body?: object;
      key?: string | null;
    }> = {},
  ) => {
    const cookie = options.cookie === undefined ? ownerCookie : options.cookie;
    const key = options.key === undefined ? randomUUID() : options.key;
    return test.app.inject({
      method: "POST",
      url: `/v1/organizers/${options.org ?? organizer}/events/${ev}/operators/briefing`,
      headers: withSession(cookie ?? "", key === null ? {} : { "idempotency-key": key }),
      payload: options.body ?? GOOD,
    });
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
    organizer =
      (
        await db.owner.query<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ('activity-org', 'activity-org') RETURNING id",
        )
      ).rows[0]?.id ?? "";
    const ownerId = await createStaff(db.owner, { email: "owner@activity.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [organizer, ownerId],
    );
    ownerCookie = await signInFully(test, "owner@activity.test");
    event = await newEvent();
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  it("reads an event with no operators, never cached", async () => {
    const answer = await read(await newEvent());
    expect(answer.statusCode).toBe(200);
    expect(answer.headers["cache-control"]).toBe("private, no-store");
    expect(answer.json()).toMatchObject({ operators: [], recent: [], briefings: [] });
  });

  it("lists the operators with their numbers and no player", async () => {
    const ev = await newEvent();
    const op = await newOperator(ev);
    const body = (await read(ev)).json();
    expect(body.operators).toHaveLength(1);
    expect(body.operators[0]).toMatchObject({
      username: op.username,
      scans: 0,
      lastAt: null,
      lastAction: null,
    });
  });

  it("takes the page size of the recent list, 1 to 50, and refuses anything else", async () => {
    for (const query of ["?recent=1", "?recent=50", ""]) {
      expect((await read(event, { query })).statusCode, query).toBe(200);
    }
    for (const query of ["?recent=0", "?recent=51", "?recent=abc", "?recent=5&x=1"]) {
      expect((await read(event, { query })).statusCode, query).toBe(400);
    }
  });

  it("sends a briefing to the operators once per key and answers a replay with the first result", async () => {
    const ev = await newEvent();
    await newOperator(ev);
    await newOperator(ev);
    const key = randomUUID();
    const first = await brief(ev, { key });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ recipients: 2, replayed: false });
    const again = await brief(ev, { key });
    expect(again.json()).toEqual(first.json());
    expect(again.headers["idempotent-replayed"]).toBe("true");
    const { briefings } = (await read(ev)).json();
    expect(briefings).toHaveLength(1);
    expect(briefings[0]).toMatchObject({ titleEn: "Gate change", recipients: 2 });
    const [notice] = await owner<{ n: number }>(
      "SELECT count(*)::int AS n FROM notice WHERE event_id = $1 AND kind = 'staff_briefing'",
      [ev],
    );
    expect(notice?.n).toBe(2);
  });

  it("cleans the text like an announcement and refuses a bad field, naming it", async () => {
    const ev = await newEvent();
    await newOperator(ev);
    const cleaned = await brief(ev, { body: { ...GOOD, titleEn: "  Gate\n change  " } });
    expect(cleaned.statusCode).toBe(201);
    expect((await read(ev)).json().briefings[0].titleEn).toBe("Gate change");
    const cases: [object, string, string][] = [
      [{ ...GOOD, titleAr: "" }, "titleAr", "required"],
      [{ ...GOOD, bodyEn: "x".repeat(141) }, "bodyEn", "too_long"],
      [{ ...GOOD, bodyAr: "اتصل 0551234567" }, "bodyAr", "looks_like_phone"],
      [{ ...GOOD, bodyEn: "see example.com" }, "bodyEn", "looks_like_address"],
    ];
    for (const [body, field, issue] of cases) {
      const refused = await brief(ev, { body });
      expect([refused.statusCode, refused.json().code, refused.json().details]).toEqual([
        422,
        "invalid_briefing",
        { field, issue },
      ]);
    }
    expect((await brief(ev, { body: { ...GOOD, extra: "x" } })).statusCode).toBe(422);
    expect((await brief(ev, { body: { titleEn: "only" } })).statusCode).toBe(422);
  });

  it("answers the database's refusals: nobody to tell, an ended event, the rate limit", async () => {
    const empty = await newEvent();
    expect(await brief(empty).then((r) => [r.statusCode, r.json().code])).toEqual([
      409,
      "briefing_nobody",
    ]);
    const ended = await newEvent("archived");
    await newOperator(ended);
    expect(await brief(ended).then((r) => [r.statusCode, r.json().code])).toEqual([
      409,
      "briefing_event_closed",
    ]);
    const busy = await newEvent();
    await newOperator(busy);
    for (let i = 0; i < 3; i += 1) expect((await brief(busy)).statusCode).toBe(201);
    const limited = await brief(busy);
    expect([limited.statusCode, limited.json().code, limited.json().details]).toEqual([
      429,
      "briefing_limit",
      { window: "hour" },
    ]);
    expect(limited.json().message).toEqual({
      ar: expect.any(String),
      en: expect.any(String),
    });
  });

  it("needs an Idempotency-Key and a signed-in member", async () => {
    const ev = await newEvent();
    await newOperator(ev);
    expect((await brief(ev, { key: null })).statusCode).toBe(400);
    expect((await read(ev, { cookie: null })).statusCode).toBe(401);
    const unsigned = await test.app.inject({
      method: "POST",
      url: `/v1/organizers/${organizer}/events/${ev}/operators/briefing`,
      headers: { "idempotency-key": randomUUID() },
      payload: GOOD,
    });
    expect([401, 403]).toContain(unsigned.statusCode);
  });

  it("refuses another organizer's team and an unknown event, and keeps an editor to their limit", async () => {
    const ev = await newEvent();
    await newOperator(ev);
    const rival = (
      await db.owner.query<{ id: string }>(
        "INSERT INTO organizer (name, slug) VALUES ('rival-activity', 'rival-activity') RETURNING id",
      )
    ).rows[0]?.id as string;
    const rivalStaff = await createStaff(db.owner, { email: "owner@rival-activity.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [rival, rivalStaff],
    );
    const rivalCookie = await signInFully(test, "owner@rival-activity.test");
    for (const [cookie, org, target] of [
      [rivalCookie, rival, ev],
      [rivalCookie, organizer, ev],
      [ownerCookie, rival, ev],
      [ownerCookie, organizer, randomUUID()],
    ] as const) {
      const options = { cookie, org };
      expect([
        (await read(target, options)).statusCode,
        (await read(target, options)).json().code,
      ]).toEqual([404, "not_found"]);
      expect((await brief(target, options)).statusCode).toBe(404);
    }
    const outside = await newEvent();
    const editor = await createStaff(db.owner, { email: "editor@activity.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role, event_scope) VALUES ($1, $2, 'editor', $3)",
      [organizer, editor, [ev]],
    );
    const cookie = await signInFully(test, "editor@activity.test");
    expect((await read(ev, { cookie })).statusCode).toBe(200);
    expect((await brief(ev, { cookie })).statusCode).toBe(201);
    expect((await read(outside, { cookie })).statusCode).toBe(404);
    expect((await brief(outside, { cookie })).statusCode).toBe(404);
    expect((await read("not-a-uuid")).statusCode).toBe(400);
  });
});
