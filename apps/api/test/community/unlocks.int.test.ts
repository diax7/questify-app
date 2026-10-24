import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  target: 10,
  startsAt: inMinutes(0),
  endsAt: inMinutes(60),
  reward: { kind: "nothing" },
  milestones: [],
  ...over,
});
const unlock = (kind: string, id: string) => ({ kind: "unlock", target: { kind, id } });

/**
 * Unlock rewards over HTTP (T-306c): the builder's unlock body and its refusals, the targets on the Community page, a
 * target kept from deletion, the quests, Home and shop shapes with `communityLock`, the reserve, completion and Send
 * refusals, the public page, and the bar's unlock step on /live with its ETag moving at the reach.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("community unlocks over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let settingsPool: Pool;
  let settings: SettingsService;
  let organizer = "";
  let ownerCookie = "";
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    settingsPool = new Pool({ connectionString: db.appUrl, max: 2 });
    settings = createSettingsService({ pool: settingsPool });
    test = await startApp(db, false, {}, { settings });
    organizer =
      (
        await db.owner.query<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ('unlock-org', 'unlock-org') RETURNING id",
        )
      ).rows[0]?.id ?? "";
    const ownerId = await createStaff(db.owner, { email: "owner@unlock.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [organizer, ownerId],
    );
    ownerCookie = await signInFully(test, "owner@unlock.test");
  });
  afterAll(async () => {
    await test.close();
    await settingsPool.end();
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const newEvent = async () => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at, access)
       VALUES ($1, $2, 'Tower Fest', 'live', now() - interval '2 hours', now() + interval '1 day', 'public')
       RETURNING id`,
      [organizer, `ULK${counter}`],
    );
    return event?.id ?? "";
  };
  const categoryOf = async (event: string) =>
    (await owner<{ id: string }>("SELECT id FROM category WHERE event_id = $1 LIMIT 1", [event]))[0]
      ?.id ?? "";
  const newQuest = async (event: string, fields: Row = {}) =>
    (
      await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, type_config, visible)
         VALUES ($1, $2, $3, 'Tower', 10, $4, $5, $6) RETURNING id`,
        [
          event,
          fields["category"] ?? (await categoryOf(event)),
          fields["type"] ?? "enter_code",
          fields["type"] === "vote" ? 1 : 5,
          JSON.stringify(fields["config"] ?? { code: "TOWER" }),
          fields["visible"] ?? true,
        ],
      )
    )[0]?.id ?? "";
  const newReward = async (event: string) =>
    (
      await owner<{ id: string }>(
        "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, 'item', 'Lantern', 1, 5) RETURNING id",
        [event],
      )
    )[0]?.id ?? "";
  const newPlayer = async (event: string) => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`unlock_http_${counter}`],
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
    await owner(
      `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor)
       VALUES ($1, $2, $3, 'welcome', 10, 10, 'system')`,
      [organizer, event, made?.id],
    );
    return { token, enrollment: made?.id ?? "" };
  };
  const dashboard = (method: "GET" | "POST" | "DELETE", path: string, payload?: object) =>
    test.app.inject({
      method,
      url: `/v1/organizers/${organizer}${path}`,
      headers: withSession(ownerCookie, { "idempotency-key": randomUUID() }),
      ...(payload === undefined ? {} : { payload }),
    });
  const asPlayer = (
    token: string,
    method: "GET" | "POST",
    url: string,
    payload?: object,
    headers: Record<string, string> = {},
  ) =>
    test.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": randomUUID(), ...headers },
      ...(payload === undefined ? {} : { payload }),
    });
  const lockWith = async (event: string, kind: string, id: string, over: Row = {}) => {
    const made = await dashboard(
      "POST",
      `/events/${event}/community-goals`,
      goal({ reward: unlock(kind, id), ...over }),
    );
    expect(made.statusCode).toBe(201);
    return (made.json().goal as { id: string }).id;
  };
  /** The tick reaches the goal: its window backdated, 10 points 5 minutes ago, one settle. */
  const reach = async (event: string, id: string) => {
    await owner(
      `UPDATE community_goal SET starts_at = date_trunc('milliseconds', now() - interval '10 minutes')
       WHERE id = $1 AND settled_until IS NULL`,
      [id],
    );
    const giver = await newPlayer(event);
    await owner(
      `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor,
                                 category_id, bonus_period, created_at)
       SELECT n.organizer_id, n.event_id, n.id, 'bonus', 10, 10, 'system', $2, '-infinity',
              coalesce(g.settled_until + interval '1 millisecond', now() - interval '5 minutes')
       FROM enrollment n, community_goal g WHERE n.id = $1 AND g.id = $3`,
      [giver.enrollment, await categoryOf(event), id],
    );
    const client: PoolClient = await test.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT settle_goal($1, true)", [id]);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  };

  describe("the builder", () => {
    it("saves an unlock step and lists its target; names each refusal", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const id = await lockWith(event, "quest", quest);
      const listed = await dashboard("GET", `/events/${event}/community-goals`);
      expect(listed.json().goals[0].steps[0].reward).toEqual({
        kind: "unlock",
        points: null,
        moment: null,
        unlock: { kind: "quest", id: quest, name: { ar: null, en: "Tower" } },
      });
      const taken = await dashboard(
        "POST",
        `/events/${event}/community-goals`,
        goal({ reward: unlock("quest", quest), startsAt: inMinutes(120), endsAt: inMinutes(180) }),
      );
      expect(codeOf(taken)).toEqual([409, "unlock_taken"]);
      const foreign = await dashboard(
        "POST",
        `/events/${event}/community-goals`,
        goal({
          reward: unlock("reward", randomUUID()),
          startsAt: inMinutes(120),
          endsAt: inMinutes(180),
        }),
      );
      expect([foreign.statusCode, foreign.json().details]).toEqual([
        422,
        { issues: ["unlock_target"] },
      ]);
      const other = await newQuest(event);
      const counted = await dashboard(
        "POST",
        `/events/${event}/community-goals`,
        goal({
          measure: "completions",
          questId: other,
          reward: unlock("quest", other),
          startsAt: inMinutes(120),
          endsAt: inMinutes(180),
        }),
      );
      expect([counted.statusCode, counted.json().details]).toEqual([
        422,
        { issues: ["unlock_counted"] },
      ]);
      const shape = await dashboard(
        "POST",
        `/events/${event}/community-goals`,
        goal({ reward: { kind: "unlock", target: { kind: "badge", id: other } } }),
      );
      expect([shape.statusCode, shape.json().details]).toEqual([
        422,
        { issues: ["reward.target.kind"] },
      ]);
      expect(
        codeOf(await dashboard("DELETE", `/events/${event}/quests/${quest}`, { confirm: true })),
      ).toEqual([409, "goal_in_use"]);
      expect(id).not.toBe("");
    });
  });

  describe("what the player reads and is refused", () => {
    it("lists the locked quest and category note, refuses the completion, and opens both at the reach", async () => {
      const event = await newEvent();
      const category = await categoryOf(event);
      const quest = await newQuest(event, { category });
      const player = await newPlayer(event);
      const id = await lockWith(event, "category", category);
      const quests = async () =>
        (await asPlayer(player.token, "GET", `/v1/events/${event}/quests`)).json<{
          categories: {
            communityLock: Row | null;
            quests: { id: string; state: string; lock: string | null; communityLock: Row | null }[];
          }[];
        }>().categories[0];
      const locked = await quests();
      expect(locked?.communityLock).toMatchObject({
        goalId: id,
        measure: "points",
        threshold: 10,
        state: "scheduled",
      });
      expect(locked?.communityLock?.["startsAt"]).toMatch(/Z$/);
      expect(locked?.quests.find((row) => row.id === quest)).toMatchObject({
        state: "locked",
        lock: "community_locked",
        communityLock: { goalId: id },
      });
      const refused = await asPlayer(player.token, "POST", `/v1/quests/${quest}/complete`, {
        proof: { type: "code", code: "TOWER" },
      });
      expect([refused.statusCode, refused.json().code, refused.json().details]).toEqual([
        403,
        "quest_not_open",
        { reason: "community_locked" },
      ]);
      await reach(event, id);
      const open = await quests();
      expect(open?.communityLock).toBeNull();
      expect(open?.quests.find((row) => row.id === quest)).toMatchObject({
        state: "open",
        lock: null,
        communityLock: null,
      });
      expect(
        (
          await asPlayer(player.token, "POST", `/v1/quests/${quest}/complete`, {
            proof: { type: "code", code: "TOWER" },
          })
        ).statusCode,
      ).toBe(200);
    });

    it("shows the shop's locked reward with its note, refuses the reserve, and keeps a pinned goal's note on Home", async () => {
      const event = await newEvent();
      const reward = await newReward(event);
      const player = await newPlayer(event);
      const id = await lockWith(event, "reward", reward);
      const shop = await asPlayer(player.token, "GET", `/v1/events/${event}/shop`);
      expect(shop.json().rewards[0]).toMatchObject({
        id: reward,
        communityLock: { goalId: id, state: "scheduled" },
      });
      const refused = await asPlayer(player.token, "POST", `/v1/rewards/${reward}/reserve`, {});
      expect([refused.statusCode, refused.json().code, refused.json().details]).toEqual([
        403,
        "reward_not_open",
        { reason: "community_locked" },
      ]);
      const home = async () =>
        (await asPlayer(player.token, "GET", `/v1/events/${event}/home`)).json().goal;
      expect(await home()).toBeNull();
      await owner("UPDATE enrollment SET goal_reward_id = $2 WHERE id = $1", [
        player.enrollment,
        reward,
      ]);
      expect(await home()).toMatchObject({
        rewardId: reward,
        pinned: true,
        communityLock: { goalId: id },
      });
      await reach(event, id);
      expect(await home()).toMatchObject({ rewardId: reward, communityLock: null });
      expect(
        (await asPlayer(player.token, "POST", `/v1/rewards/${reward}/reserve`, {})).statusCode,
      ).toBe(201);
    });

    it("leaves a locked quest off the public page, and refuses Send for a poll in a locked category", async () => {
      const event = await newEvent();
      const category = await categoryOf(event);
      const quest = await newQuest(event, { category });
      const poll = await newQuest(event, {
        category,
        type: "vote",
        visible: false,
        config: {
          options: [
            { id: "a", text: { en: "A" } },
            { id: "b", text: { en: "B" } },
          ],
          live: { choices: "one", results: "after_vote", minutes: 5 },
        },
      });
      const [{ join_code: code } = { join_code: "" }] = await owner<{ join_code: string }>(
        "SELECT join_code FROM event WHERE id = $1",
        [event],
      );
      const publicIds = async () =>
        (await test.app.inject({ method: "GET", url: `/v1/public/events/${code}/quests` }))
          .json<{ categories: { quests: { id: string }[] }[] }>()
          .categories.flatMap((row) => row.quests.map((q) => q.id));
      expect(await publicIds()).toContain(quest);
      const id = await lockWith(event, "category", category);
      expect(await publicIds()).not.toContain(quest);
      expect(codeOf(await dashboard("POST", `/events/${event}/quests/${poll}/send`, {}))).toEqual([
        409,
        "community_locked",
      ]);
      await reach(event, id);
      expect(await publicIds()).toContain(quest);
    });

    it("names the unlock on /live only to a player who sees it, and moves the ETag at the reach", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const player = await newPlayer(event);
      const id = await lockWith(event, "quest", quest, {
        target: 20,
        reward: { kind: "nothing" },
        milestones: [{ threshold: 10, reward: unlock("quest", quest) }],
      });
      await owner(
        "UPDATE community_goal SET starts_at = date_trunc('milliseconds', now() - interval '10 minutes') WHERE id = $1",
        [id],
      );
      const client = await test.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT settle_goal($1, true)", [id]);
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      const read = (headers: Record<string, string> = {}) =>
        asPlayer(player.token, "GET", `/v1/events/${event}/live`, undefined, headers);
      const first = await read();
      expect(first.json().community.steps[0]).toMatchObject({
        threshold: 10,
        reward: { kind: "unlock", target: { kind: "quest", id: quest, name: { en: "Tower" } } },
        reachedAt: null,
      });
      await owner("UPDATE quest SET visible = false WHERE id = $1", [quest]);
      await new Promise((resolve) => setTimeout(resolve, 3100));
      expect((await read()).json().community.steps[0].reward).toEqual({ kind: "unlock" });
      await owner("UPDATE quest SET visible = true WHERE id = $1", [quest]);
      await new Promise((resolve) => setTimeout(resolve, 3100));
      const etag = String((await read()).headers["etag"]);
      await reach(event, id);
      await new Promise((resolve) => setTimeout(resolve, 3100));
      const moved = await read({ "if-none-match": etag });
      expect(moved.statusCode).toBe(200);
      expect(moved.json().community.steps[0].reachedAt).toMatch(/Z$/);
    });
  });
});
