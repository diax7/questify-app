import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { settleAndPay } from "#src/community/payer";
import { createSettingsService, type SettingsService } from "#src/settings/service";
import {
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Row = Record<string, unknown>;

const codeOf = (response: { statusCode: number; json: () => { code?: string } }) => [
  response.statusCode,
  response.json().code,
];
const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const goal = (over: Row = {}): Row => ({
  title: { en: "Light the tower", ar: "أضيئوا البرج" },
  measure: "points",
  target: 100,
  startsAt: inMinutes(10),
  endsAt: inMinutes(40),
  reward: { kind: "points", points: 20 },
  milestones: [{ threshold: 50, reward: { kind: "moment", moment: { en: "The band plays" } } }],
  ...over,
});

/**
 * Community quests over HTTP (T-306b): the builder's body and refusals, the platform switch, the owner's Settle and pay
 * now (`paid`, `paying`, `community_settling` with Retry-After), the results confirm refusal, a counted quest kept from
 * deletion, and the live read's community card with its ETag.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("community quests over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let settingsPool: Pool;
  let settings: SettingsService;
  let organizer = "";
  let ownerId = "";
  let ownerCookie = "";
  let editorCookie = "";
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    settingsPool = new Pool({ connectionString: db.appUrl, max: 2 });
    settings = createSettingsService({ pool: settingsPool });
    test = await startApp(db, false, {}, { settings });
    organizer =
      (
        await db.owner.query<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ('tower-org', 'tower-org') RETURNING id",
        )
      ).rows[0]?.id ?? "";
    ownerId = await createStaff(db.owner, { email: "owner@tower.test" });
    const editorId = await createStaff(db.owner, { email: "editor@tower.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'editor')",
      [organizer, ownerId, editorId],
    );
    ownerCookie = await signInFully(test, "owner@tower.test");
    editorCookie = await signInFully(test, "editor@tower.test");
  });
  afterAll(async () => {
    await test.close();
    await settingsPool.end();
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const newEvent = async (status = "live", endsIn = "1 day") => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Tower Fest', $3, now() - interval '2 hours', now() + $4::interval) RETURNING id`,
      [organizer, `TWR${counter}`, status, endsIn],
    );
    return event?.id ?? "";
  };
  const dashboard = (
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    payload?: object,
    cookie = ownerCookie,
  ) =>
    test.app.inject({
      method,
      url: `/v1/organizers/${organizer}${path}`,
      headers: withSession(cookie, { "idempotency-key": randomUUID() }),
      ...(payload === undefined ? {} : { payload }),
    });
  const platform = async (enabled: boolean) => {
    await owner(
      `INSERT INTO platform_setting (key, value) VALUES ('features', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify({ community: { enabled } })],
    );
    settings.forget();
  };
  const newPlayer = async (event: string) => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`tower_http_${counter}`],
    );
    const token = randomBytes(32).toString("base64url");
    await owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [player?.id, createHash("sha256").update(token).digest()],
    );
    const [made] = await owner<{ id: string }>(
      "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3) RETURNING id",
      [organizer, event, player?.id],
    );
    return { token, enrollment: made?.id ?? "" };
  };
  /** Points earned `ago` before now, written as the engine writes them. */
  const earn = async (enrollment: string, points: number, ago = "5 minutes") => {
    const [quest] = await owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap)
       SELECT n.event_id, (SELECT id FROM category WHERE event_id = n.event_id LIMIT 1), 'scan_qr', 'Scan', $2, 1
       FROM enrollment n WHERE n.id = $1 RETURNING id`,
      [enrollment, points],
    );
    await owner(
      `WITH c AS (
         INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                       idempotency_key, created_at)
         SELECT n.organizer_id, n.event_id, n.id, $2, 1, 'qr', gen_random_uuid()::text, now() - $4::interval
         FROM enrollment n WHERE n.id = $1 RETURNING *)
       INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                 completion_id, quest_id, actor, created_at)
       SELECT c.organizer_id, c.event_id, c.enrollment_id, 'quest', $3, $3, c.id, c.quest_id, 'player', c.created_at
       FROM c`,
      [enrollment, quest?.id, points, ago],
    );
  };
  /** A goal saved through the dashboard, then moved to start `ago` before now and end `endsIn` from now. */
  const running = async (event: string, over: Row = {}, ago = "8 minutes", endsIn = "1 hour") => {
    const made = await dashboard("POST", `/events/${event}/community-goals`, goal(over));
    expect(made.statusCode).toBe(201);
    const id = (made.json().goal as { id: string }).id;
    await owner(
      `UPDATE community_goal SET starts_at = date_trunc('milliseconds', now() - $2::interval),
                                 ends_at = date_trunc('milliseconds', now() + $3::interval) WHERE id = $1`,
      [id, ago, endsIn],
    );
    return id;
  };
  const settleTick = (id: string) =>
    test.pool.connect().then(async (client: PoolClient) => {
      try {
        await client.query("BEGIN");
        await client.query("SELECT settle_goal($1, true)", [id]);
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    });

  describe("the builder", () => {
    it("creates, lists, edits before the start and deletes a goal; an editor may too", async () => {
      const event = await newEvent();
      const made = await dashboard(
        "POST",
        `/events/${event}/community-goals`,
        goal(),
        editorCookie,
      );
      expect(made.statusCode).toBe(201);
      const created = made.json().goal as { id: string; steps: unknown[]; status: string };
      expect(created).toMatchObject({ status: "scheduled", paidTo: "contributors", target: 100 });
      expect(created.steps).toEqual([
        expect.objectContaining({
          threshold: 50,
          isGoal: false,
          reward: {
            kind: "moment",
            points: null,
            moment: { ar: null, en: "The band plays" },
            unlock: null,
          },
        }),
        expect.objectContaining({
          threshold: 100,
          isGoal: true,
          reward: { kind: "points", points: 20, moment: null, unlock: null },
        }),
      ]);
      const listed = await dashboard("GET", `/events/${event}/community-goals`);
      expect(listed.json().goals).toHaveLength(1);
      const edited = await dashboard(
        "PATCH",
        `/events/${event}/community-goals/${created.id}`,
        goal({ target: 300, paidTo: "everyone" }),
      );
      expect(edited.statusCode).toBe(200);
      expect(edited.json().goal).toMatchObject({ target: 300, paidTo: "everyone" });
      expect(
        (await dashboard("DELETE", `/events/${event}/community-goals/${created.id}`)).statusCode,
      ).toBe(204);
      expect(
        codeOf(await dashboard("DELETE", `/events/${event}/community-goals/${created.id}`)),
      ).toEqual([404, "not_found"]);
    });

    it("names the fields at fault, and refuses an overlap, a locked edit and a started delete", async () => {
      const event = await newEvent();
      const bad = await dashboard(
        "POST",
        `/events/${event}/community-goals`,
        goal({
          measure: "points",
          questId: randomUUID(),
          target: 50,
          milestones: [{ threshold: 50, reward: { kind: "nothing" } }],
        }),
      );
      expect(codeOf(bad)).toEqual([422, "invalid_goal"]);
      expect(bad.json().details.issues.toSorted()).toEqual(["measure", "milestones"]);
      const unknownQuest = await dashboard(
        "POST",
        `/events/${event}/community-goals`,
        goal({ measure: "completions", questId: randomUUID() }),
      );
      expect([unknownQuest.statusCode, unknownQuest.json().details]).toEqual([
        422,
        { issues: ["questId"] },
      ]);
      await dashboard("POST", `/events/${event}/community-goals`, goal());
      expect(
        codeOf(
          await dashboard(
            "POST",
            `/events/${event}/community-goals`,
            goal({ startsAt: inMinutes(20), endsAt: inMinutes(50) }),
          ),
        ),
      ).toEqual([409, "goal_overlap"]);
      const started = await running(
        event,
        { startsAt: inMinutes(60), endsAt: inMinutes(90) },
        "1 minute",
        "1 hour",
      );
      const [row] = await owner<{ starts_at: Date; ends_at: Date }>(
        "SELECT starts_at, ends_at FROM community_goal WHERE id = $1",
        [started],
      );
      const same = goal({
        startsAt: row?.starts_at.toISOString(),
        endsAt: row?.ends_at.toISOString(),
      });
      const locked = await dashboard("PATCH", `/events/${event}/community-goals/${started}`, {
        ...same,
        target: 999,
      });
      expect([locked.statusCode, locked.json().code, locked.json().details]).toEqual([
        409,
        "goal_locked",
        { field: "target" },
      ]);
      expect(
        (
          await dashboard("PATCH", `/events/${event}/community-goals/${started}`, {
            ...same,
            title: { en: "New name" },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        codeOf(await dashboard("DELETE", `/events/${event}/community-goals/${started}`)),
      ).toEqual([409, "goal_started"]);
      const ended = await newEvent("ended", "-1 minute");
      expect(codeOf(await dashboard("POST", `/events/${ended}/community-goals`, goal()))).toEqual([
        409,
        "event_ended",
      ]);
    });

    it("refuses writes while the platform switch is off, and keeps a counted quest from deletion", async () => {
      const event = await newEvent();
      await platform(false);
      try {
        expect(codeOf(await dashboard("POST", `/events/${event}/community-goals`, goal()))).toEqual(
          [403, "feature_off"],
        );
        expect((await dashboard("GET", `/events/${event}/community-goals`)).statusCode).toBe(200);
      } finally {
        await platform(true);
      }
      const [category] = await owner<{ id: string }>(
        "SELECT id FROM category WHERE event_id = $1 LIMIT 1",
        [event],
      );
      const [quest] = await owner<{ id: string }>(
        "INSERT INTO quest (event_id, category_id, type, title_en, points) VALUES ($1, $2, 'scan_qr', 'Scan', 5) RETURNING id",
        [event, category?.id],
      );
      await dashboard(
        "POST",
        `/events/${event}/community-goals`,
        goal({ measure: "completions", questId: quest?.id, milestones: [] }),
      );
      expect(
        codeOf(
          await dashboard("DELETE", `/events/${event}/quests/${quest?.id}`, { confirm: true }),
        ),
      ).toEqual([409, "goal_in_use"]);
    });

    it("lets the owner turn community quests off for an event, which finishes its running goal", async () => {
      const event = await newEvent();
      const id = await running(event, { milestones: [] });
      await settleTick(id);
      const off = await dashboard("PUT", `/events/${event}/community`, { enabled: false });
      expect([off.statusCode, off.json()]).toEqual([200, { community: false }]);
      expect(
        (
          await owner<{ status: string }>("SELECT status FROM community_goal WHERE id = $1", [id])
        )[0]?.status,
      ).toBe("missed");
      expect(
        codeOf(
          await dashboard("PUT", `/events/${event}/community`, { enabled: true }, editorCookie),
        ),
      ).toEqual([403, "owner_only"]);
    });
  });

  describe("Settle and pay now, and the results", () => {
    it("pays and lets the owner confirm, refusing the confirm while rewards are due", async () => {
      const event = await newEvent("live", "2 hours");
      const player = await newPlayer(event);
      await running(event, { target: 10, milestones: [] }, "1 hour", "30 minutes");
      await earn(player.enrollment, 15, "40 minutes");
      await owner(
        "UPDATE event SET status = 'ended', ends_at = now() - interval '1 second' WHERE id = $1",
        [event],
      );
      const refused = await dashboard("POST", `/events/${event}/results/confirm`, {
        expected: [player.enrollment],
      });
      expect([refused.statusCode, refused.json().code, refused.json().details]).toEqual([
        409,
        "community_paying",
        { goals: 1, due: 0 },
      ]);
      expect(
        codeOf(await dashboard("POST", `/events/${event}/community/settle`, {}, editorCookie)),
      ).toEqual([403, "owner_only"]);
      const settled = await dashboard("POST", `/events/${event}/community/settle`, {});
      expect([settled.statusCode, settled.json()]).toEqual([
        200,
        { status: "paid", goals: 0, due: 0 },
      ]);
      const [score] = await owner<{ score: string }>("SELECT score FROM enrollment WHERE id = $1", [
        player.enrollment,
      ]);
      expect(score?.score).toBe("35");
      expect(
        (
          await dashboard("POST", `/events/${event}/results/confirm`, {
            expected: [player.enrollment],
          })
        ).statusCode,
      ).toBe(200);
    });

    it("answers paying when the budget runs out, and community_settling with Retry-After while a window's transaction is open", async () => {
      const event = await newEvent();
      const player = await newPlayer(event);
      await running(event, { target: 10, milestones: [] }, "1 hour", "-50 minutes");
      await earn(player.enrollment, 15, "55 minutes");
      const context = { organizerId: organizer, staffUserId: ownerId };
      const answer = await settleAndPay(
        { pool: test.pool, settings },
        context,
        { eventId: event, requestId: randomUUID() },
        0,
      );
      expect(answer).toEqual({ kind: "done", value: { status: "paying", goals: 0, due: 1 } });
      const second = await newEvent();
      const late = await running(second, { target: 10, milestones: [] }, "1 hour", "1 hour");
      const open = await test.pool.connect();
      try {
        await open.query("BEGIN");
        await open.query("SELECT 1");
        await owner("UPDATE community_goal SET ends_at = clock_timestamp() WHERE id = $1", [late]);
        await new Promise((resolve) => setTimeout(resolve, 20));
        const busy = await dashboard("POST", `/events/${second}/community/settle`, {});
        expect([busy.statusCode, busy.json().code, busy.headers["retry-after"]]).toEqual([
          409,
          "community_settling",
          "5",
        ]);
        await open.query("COMMIT");
      } finally {
        open.release();
      }
    });
  });

  describe("the live card", () => {
    it("shows the running goal on /live, moves the ETag with progress, and hides it with the platform switch off", async () => {
      const event = await newEvent();
      const player = await newPlayer(event);
      const id = await running(event, {
        target: 100,
        milestones: [{ threshold: 10, reward: { kind: "points", points: 3 } }],
      });
      await earn(player.enrollment, 15);
      await settleTick(id);
      const read = (headers: Record<string, string> = {}) =>
        test.app.inject({
          method: "GET",
          url: `/v1/events/${event}/live`,
          headers: { authorization: `Bearer ${player.token}`, ...headers },
        });
      const first = await read();
      expect(first.statusCode).toBe(200);
      expect(first.json().community).toMatchObject({
        goalId: id,
        status: "running",
        progress: 15,
        contributed: true,
        steps: [
          { threshold: 10, isGoal: false, reward: { kind: "points", points: 3 }, mine: "due" },
          {
            threshold: 100,
            isGoal: true,
            reward: { kind: "points", points: 20 },
            reachedAt: null,
            mine: null,
          },
        ],
      });
      expect(first.json().community.endsAt).toMatch(/Z$/);
      const etag = String(first.headers["etag"]);
      expect((await read({ "if-none-match": etag })).statusCode).toBe(304);
      await earn(player.enrollment, 5, "1 second");
      await settleTick(id);
      await new Promise((resolve) => setTimeout(resolve, 3100));
      const moved = await read({ "if-none-match": etag });
      expect([moved.statusCode, moved.json().community.progress]).toEqual([200, 20]);
      await platform(false);
      try {
        expect((await read()).json().community).toBeNull();
      } finally {
        await platform(true);
      }
    });
  });
});
