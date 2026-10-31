import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BAR_KEYS,
  DEFAULT_COMPOSED_LAYOUT,
  DEFAULT_LAYOUT,
  HOME_KEYS,
  LAYOUT_PRESETS,
  type ComposedLayout,
} from "@questify/shared";
import {
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { pushFixture, type PushFixture } from "#test/support/push";
import { TEST_DATABASE_URL } from "#test/support/test-db";

const codeOf = (response: { statusCode: number; json: () => { code?: string } }) => [
  response.statusCode,
  response.json().code,
];

type Player = { id: string; token: string };

const custom = {
  bar: { order: ["rewards", "index", "scan", "quests", "profile"], hidden: ["quests"] },
  home: { order: HOME_KEYS.toReversed(), hidden: ["sponsors", "streak"] },
};

/**
 * An event's bar and Home layout over HTTP (T-606, FR-1749, FR-1750, FR-1764): who may save it, that Home, the scan button,
 * Profile and the protected blocks can never be hidden whatever the caller sends, what the app's configuration then holds,
 * and that a damaged stored layout still reads safely.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("event layout over HTTP", () => {
  let fixture: PushFixture;
  let test: TestApp;
  let owner: string;
  let editor: string;
  let other: string;
  let stranger: string;

  const bearer = async (id: string): Promise<string> => {
    const value = randomBytes(32).toString("base64url");
    await fixture.owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [id, createHash("sha256").update(value).digest()],
    );
    return value;
  };

  beforeAll(async () => {
    fixture = await pushFixture();
    test = await startApp(fixture.db);
    const staff = async (name: string, role: string, organizer = fixture.ids.orgA) => {
      const email = name + "@layout.test";
      const id = await createStaff(fixture.db.owner, { email });
      await fixture.owner(
        "INSERT INTO organizer_member (organizer_id, staff_user_id, role, event_scope) VALUES ($1, $2, $3, NULL)",
        [organizer, id, role],
      );
      return signInFully(test, email);
    };
    await fixture.owner("UPDATE organizer_member SET role = 'editor' WHERE organizer_id = $1", [
      fixture.ids.orgA,
    ]);
    owner = await staff("owner", "owner");
    editor = await staff("editor", "editor");
    other = await staff("other", "owner", fixture.ids.orgB);
    await createStaff(fixture.db.owner, { email: "stranger@layout.test" });
    stranger = await signInFully(test, "stranger@layout.test");
  });
  afterAll(async () => {
    await test.close();
    await fixture.close();
  });

  const base = (id: string) => `/v1/organizers/${fixture.ids.orgA}/events/${id}`;
  const put = (id: string, payload: unknown, session = owner) =>
    test.app.inject({
      method: "PUT",
      url: `${base(id)}/layout`,
      headers: withSession(session, { "idempotency-key": randomUUID() }),
      payload: payload as object,
    });
  const eventView = async (id: string) =>
    (
      await test.app.inject({
        method: "GET",
        url: base(id),
        headers: withSession(owner),
      })
    ).json<{ event: { layout: unknown } }>().event;
  const liveEvent = async () => {
    const id = await fixture.newEvent({ phase: "live" });
    const player = await fixture.newPlayer();
    await fixture.join(id, player);
    return { id, member: { id: player, token: await bearer(player) } satisfies Player };
  };
  const appConfig = async (id: string, member: Player) =>
    (
      await test.app.inject({
        method: "GET",
        url: `/v1/config?event=${id}`,
        headers: { authorization: `Bearer ${member.token}` },
      })
    ).json<{ layout: ComposedLayout; features: Record<string, { enabled: boolean }> }>();

  it("starts as Questify's layout and reaches the app as what is shown", async () => {
    const { id, member } = await liveEvent();
    expect(await eventView(id)).toMatchObject({ layout: DEFAULT_LAYOUT });
    expect((await appConfig(id, member)).layout).toEqual(DEFAULT_COMPOSED_LAYOUT);
  });

  it("lets an owner or an editor save a reorder and a hidden item, and the app then receives it", async () => {
    const { id, member } = await liveEvent();
    for (const session of [owner, editor]) {
      const saved = await put(id, custom, session);
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toEqual({ layout: custom });
    }
    expect(await eventView(id)).toMatchObject({ layout: custom });
    const config = await appConfig(id, member);
    expect(config.layout.bar).toEqual(["rewards", "index", "scan", "profile"]);
    expect(config.layout.home).toEqual(
      HOME_KEYS.toReversed().filter((key) => key !== "sponsors" && key !== "streak"),
    );
  });

  it.each(LAYOUT_PRESETS.map((preset) => preset.id))(
    "applies the approved preset %s by name, whatever the layout was",
    async (presetId) => {
      const { id, member } = await liveEvent();
      await put(id, custom);
      const saved = await put(id, { preset: presetId });
      expect(saved.statusCode).toBe(200);
      const expected = LAYOUT_PRESETS.find((preset) => preset.id === presetId)?.layout;
      expect(saved.json()).toEqual({ layout: expected });
      expect(await eventView(id)).toMatchObject({ layout: expected });
      expect((await appConfig(id, member)).layout.bar).toHaveLength(
        BAR_KEYS.length - (expected?.bar.hidden.length ?? 0),
      );
    },
  );

  it("refuses a preset the team does not offer, and keeps the layout as it was", async () => {
    const { id } = await liveEvent();
    await put(id, custom);
    expect(codeOf(await put(id, { preset: "retired" }))).toEqual([422, "invalid_layout"]);
    expect(await eventView(id)).toMatchObject({ layout: custom });
  });

  describe("the protected items", () => {
    it.each([
      ["Home", "bar", "index"],
      ["the scan button", "bar", "scan"],
      ["Profile (Settings, legal, account deletion)", "bar", "profile"],
      ["the points and balance", "home", "standing"],
      ["prizes and results", "home", "prizes"],
      ["history and event info", "home", "links"],
    ] as const)(
      "refuses a layout that hides %s with 422 layout_item_protected, naming it, and stores nothing",
      async (_name, list, item) => {
        const { id } = await liveEvent();
        const payload = {
          bar: { order: BAR_KEYS, hidden: [] },
          home: { order: HOME_KEYS, hidden: [] },
          [list]: { order: list === "bar" ? BAR_KEYS : HOME_KEYS, hidden: [item] },
        };
        for (const session of [owner, editor]) {
          const refused = await put(id, payload, session);
          expect(codeOf(refused)).toEqual([422, "layout_item_protected"]);
          expect(refused.json<{ details: unknown }>().details).toMatchObject({ item });
        }
        expect(await eventView(id)).toMatchObject({ layout: DEFAULT_LAYOUT });
        const audit = await fixture.owner(
          "SELECT 1 FROM audit_log WHERE event_id = $1 AND action = 'event.layout.update'",
          [id],
        );
        expect(audit).toEqual([]);
      },
    );

    it("refuses a layout that hides the scanner even when it also hides something allowed", async () => {
      const { id } = await liveEvent();
      const refused = await put(id, {
        ...custom,
        bar: { order: BAR_KEYS, hidden: ["rewards", "scan"] },
      });
      expect(codeOf(refused)).toEqual([422, "layout_item_protected"]);
      expect(await eventView(id)).toMatchObject({ layout: DEFAULT_LAYOUT });
    });
  });

  it.each([
    ["six bar slots", { ...custom, bar: { order: [...BAR_KEYS, "map"], hidden: [] } }],
    ["an unknown block", { ...custom, home: { order: [...HOME_KEYS, "confetti"], hidden: [] } }],
    [
      "a block listed twice",
      { ...custom, home: { order: [...HOME_KEYS.slice(1), "goal"], hidden: [] } },
    ],
    ["a missing bar item", { ...custom, bar: { order: ["index", "scan", "profile"], hidden: [] } }],
    ["a hidden item that is not listed", { ...custom, bar: { order: BAR_KEYS, hidden: ["map"] } }],
    ["an extra field", { ...custom, theme: "dark" }],
    ["no Home list", { bar: custom.bar }],
    ["nothing", {}],
  ])("refuses %s with 422 invalid_layout and changes nothing", async (_label, payload) => {
    const { id } = await liveEvent();
    expect(codeOf(await put(id, payload))).toEqual([422, "invalid_layout"]);
    expect(await eventView(id)).toMatchObject({ layout: DEFAULT_LAYOUT });
  });

  it("refuses another organizer's owner and a signed-in stranger, and a signed-out caller", async () => {
    const { id } = await liveEvent();
    for (const session of [other, stranger]) {
      expect([403, 404]).toContain((await put(id, custom, session)).statusCode);
    }
    const signedOut = await test.app.inject({
      method: "PUT",
      url: `${base(id)}/layout`,
      payload: custom,
    });
    expect([401, 403]).toContain(signedOut.statusCode);
    expect(await eventView(id)).toMatchObject({ layout: DEFAULT_LAYOUT });
  });

  it("refuses a player, who holds no staff session", async () => {
    const { id, member } = await liveEvent();
    const refused = await test.app.inject({
      method: "PUT",
      url: `${base(id)}/layout`,
      headers: { authorization: `Bearer ${member.token}`, "idempotency-key": randomUUID() },
      payload: custom,
    });
    expect([401, 403]).toContain(refused.statusCode);
    expect(await eventView(id)).toMatchObject({ layout: DEFAULT_LAYOUT });
  });

  it("audits a change once, keeps the event's other settings, and refuses an archived event", async () => {
    const { id } = await liveEvent();
    await fixture.owner(
      `UPDATE event SET config = jsonb_set(config, '{branding}', '{"accent":"sky"}'::jsonb, true) WHERE id = $1`,
      [id],
    );
    await put(id, custom);
    await put(id, custom);
    const audit = await fixture.owner<{ after: unknown }>(
      "SELECT after FROM audit_log WHERE event_id = $1 AND action = 'event.layout.update'",
      [id],
    );
    expect(audit).toEqual([{ after: { layout: custom } }]);
    expect(await eventView(id)).toMatchObject({ branding: { accent: "sky" }, layout: custom });
    await fixture.owner("UPDATE event SET status = 'archived' WHERE id = $1", [id]);
    expect(codeOf(await put(id, { preset: "classic" }))).toEqual([409, "event_archived"]);
  });

  it("leaves a feature switch alone: a layout that shows Rewards does not turn the shop back on", async () => {
    const { id, member } = await liveEvent();
    await test.app.inject({
      method: "PUT",
      url: `${base(id)}/features/shop`,
      headers: withSession(owner, { "idempotency-key": randomUUID() }),
      payload: { enabled: false },
    });
    await put(id, { preset: "prizes_first" });
    const config = await appConfig(id, member);
    expect(config.layout.bar).toContain("rewards");
    expect(config.features["shop"]?.enabled).toBe(false);
  });

  it("gives the configuration outside an event Questify's layout, whatever an event saved", async () => {
    const { id } = await liveEvent();
    await put(id, custom);
    const outside = await test.app.inject({ method: "GET", url: "/v1/config" });
    expect(outside.json<{ layout: unknown }>().layout).toEqual(DEFAULT_COMPOSED_LAYOUT);
  });

  it("reads a damaged stored layout safely: nothing protected is hidden and unknown names are dropped", async () => {
    const { id, member } = await liveEvent();
    await fixture.owner(
      `UPDATE event SET config = jsonb_set(config, '{layout}', $2::jsonb, true) WHERE id = $1`,
      [
        id,
        JSON.stringify({
          bar: { order: ["scan", "map", "index"], hidden: ["scan", "index", "profile", "quests"] },
          home: "broken",
        }),
      ],
    );
    const config = await appConfig(id, member);
    expect(config.layout.bar).toEqual(["scan", "index", "rewards", "profile"]);
    expect(config.layout.home).toEqual(DEFAULT_COMPOSED_LAYOUT.home);
    expect(await eventView(id)).toMatchObject({
      layout: { bar: { hidden: ["quests"] }, home: DEFAULT_LAYOUT.home },
    });
  });
});
