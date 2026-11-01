import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BAR_KEYS,
  DEFAULT_COMPOSED_LAYOUT,
  DEFAULT_LAYOUT,
  DEFAULT_LOOKS,
  EMPTY_CONTENT,
  HOME_KEYS,
  INFO_KEYS,
  LAYOUT_PRESETS,
  type ComposedLayout,
  type HomeContent,
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

const words = (en: string, ar = "") => ({ ar, en });

const codeOf = (response: { statusCode: number; json: () => { code?: string } }) => [
  response.statusCode,
  response.json().code,
];

type Player = { id: string; token: string };

const arranged = (looks: unknown) => ({
  bar: { order: BAR_KEYS, hidden: [] },
  home: { order: HOME_KEYS, hidden: ["podium"] },
  info: { order: INFO_KEYS, hidden: ["schedule"] },
  content: EMPTY_CONTENT,
  looks,
});

const custom = {
  bar: { order: ["rewards", "index", "scan", "quests", "profile"], hidden: ["quests"] },
  home: { order: HOME_KEYS.toReversed(), hidden: ["sponsors", "streak"] },
  info: { order: INFO_KEYS, hidden: ["schedule"] },
  content: EMPTY_CONTENT,
  looks: DEFAULT_LOOKS,
};

const layoutWith = (content: unknown, hidden: string[] = ["podium"]) => ({
  bar: { order: BAR_KEYS, hidden: [] },
  home: { order: [...HOME_KEYS, "card:aaaaaa11", "card:bbbbbb22"], hidden },
  info: { order: INFO_KEYS, hidden: ["schedule"] },
  content,
  looks: DEFAULT_LOOKS,
});

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
      ["the official rules", "info", "rules"],
    ] as const)(
      "refuses a layout that hides %s with 422 layout_item_protected, naming it, and stores nothing",
      async (_name, list, item) => {
        const { id } = await liveEvent();
        const payload = {
          bar: { order: BAR_KEYS, hidden: [] },
          home: { order: HOME_KEYS, hidden: [] },
          info: { order: INFO_KEYS, hidden: [] },
          content: EMPTY_CONTENT,
          looks: DEFAULT_LOOKS,
          [list]: {
            order: { bar: BAR_KEYS, home: HOME_KEYS, info: INFO_KEYS }[list],
            hidden: [item],
          },
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

  describe("the content of the Home blocks (T-610)", () => {
    const QUEST = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const empty = { ar: "", en: "" };
    const written = {
      banner: [
        {
          title: { ar: "أهلًا", en: "Welcome" },
          subtitle: empty,
          action: { type: "quest", questId: QUEST },
        },
      ],
      quickLinks: [
        { label: { ar: "", en: "Agenda" }, icon: "calendar", action: { type: "agenda" } },
        {
          label: { ar: "", en: "Site" },
          icon: "info",
          action: { type: "link", url: "https://example.com/x" },
        },
      ],
      featured: { kind: "reward", id: QUEST },
      about: empty,
      faq: [],
      contacts: [],
      page: null,
      cards: [
        { id: "aaaaaa11", kind: "text", title: empty, body: { ar: "", en: "Doors open at 9" } },
        {
          id: "bbbbbb22",
          kind: "countdown",
          label: { ar: "", en: "Doors" },
          at: "2030-01-01T09:00:00.000Z",
          atZero: "message",
          message: { ar: "", en: "Open now" },
        },
      ],
    };
    const slide = written.banner[0];
    const siteLink = written.quickLinks[1];
    const [textCard, countdownCard] = written.cards;

    it("stores what an owner or an editor wrote and sends the app the content of what is shown", async () => {
      const { id, member } = await liveEvent();
      for (const session of [owner, editor]) {
        const saved = await put(id, layoutWith(written), session);
        expect(saved.statusCode).toBe(200);
        expect(saved.json<{ layout: { content: HomeContent } }>().layout.content).toEqual(written);
      }
      const config = await appConfig(id, member);
      expect(config.layout.home).toContain("card:bbbbbb22");
      expect(config.layout).toMatchObject({ content: written });
      expect(await eventView(id)).toMatchObject({ layout: { content: written } });
    });

    it("keeps a hidden block's draft on the server", async () => {
      const { id, member } = await liveEvent();
      await put(id, layoutWith(written, ["podium", "banner", "card:bbbbbb22", "featured"]));
      const config = await appConfig(id, member);
      expect(config.layout.content.banner).toEqual([]);
      expect(config.layout.content.featured).toBeNull();
      expect(config.layout.content.cards.map((card) => card.id)).toEqual(["aaaaaa11"]);
      expect(config.layout.home).not.toContain("banner");
      expect(JSON.stringify(config)).not.toContain("Open now");
      expect(await eventView(id)).toMatchObject({ layout: { content: written } });
    });

    it("cleans the texts: invisible characters go, spaces become one, Arabic-Indic digits become Western", async () => {
      const { id } = await liveEvent();
      const dirty = {
        ...written,
        cards: [
          {
            ...textCard,
            body: { ar: "  القاعة ​٣   مفتوحة ", en: "Hall  4\n\n\n\nopen" },
          },
          countdownCard,
        ],
      };
      const saved = await put(id, layoutWith(dirty));
      const card = saved.json<{ layout: { content: HomeContent } }>().layout.content.cards[0];
      expect(card).toMatchObject({ body: { ar: "القاعة 3 مفتوحة", en: "Hall 4\n\nopen" } });
    });

    it("saves a text with control characters cleaned, never a server error (a NUL fails the JSON write)", async () => {
      const { id } = await liveEvent();
      const dirty = {
        ...written,
        cards: [
          {
            ...textCard,
            title: { ar: "", en: "Hall\u0000 4\u001B" },
            body: { ar: "", en: "Doors\u0000 open\u007F\u0085 at 9" },
          },
          countdownCard,
        ],
      };
      const saved = await put(id, layoutWith(dirty));
      expect(saved.statusCode).toBe(200);
      const card = saved.json<{ layout: { content: HomeContent } }>().layout.content.cards[0];
      expect(card).toMatchObject({
        title: { en: "Hall 4" },
        body: { en: "Doors open at 9" },
      });
      expect(await eventView(id)).toMatchObject({
        layout: { content: { cards: [{ body: { en: "Doors open at 9" } }, {}] } },
      });
    });

    const link = (url: string) => ({ ...siteLink, action: { type: "link", url } });
    it.each([
      ["a javascript link", { quickLinks: [link("javascript:alert(1)")] }],
      ["an http link", { quickLinks: [link("http://example.com")] }],
      ["a link with a login in it", { quickLinks: [link("https://example.com@evil.example/")] }],
      ["a slide with no title", { banner: [{ ...slide, title: empty }] }],
      ["six slides", { banner: Array.from({ length: 6 }, () => slide) }],
      ["a field no block has", { banner: [{ ...slide, image: "https://example.com/a.png" }] }],
      [
        "a card text over its limit",
        { cards: [{ ...textCard, body: { ar: "", en: "x".repeat(401) } }, countdownCard] },
      ],
      ["a countdown with no moment", { cards: [textCard, { ...countdownCard, at: "soon" }] }],
      [
        "a message at zero with no message",
        { cards: [textCard, { ...countdownCard, message: empty }] },
      ],
      ["a card listed twice", { cards: [textCard, textCard] }],
      ["a card the order does not list", { cards: [textCard] }],
      ["a featured item that is not an id", { featured: { kind: "quest", id: "1 OR 1=1" } }],
    ])("refuses %s with 422 invalid_layout and stores nothing", async (_label, change) => {
      const { id } = await liveEvent();
      const refused = await put(id, layoutWith({ ...written, ...change }));
      expect(codeOf(refused)).toEqual([422, "invalid_layout"]);
      expect(await eventView(id)).toMatchObject({ layout: DEFAULT_LAYOUT });
    });

    it("refuses a layout that leaves out its content", async () => {
      const { id } = await liveEvent();
      const { content: _content, ...without } = layoutWith(written);
      expect(codeOf(await put(id, without))).toEqual([422, "invalid_layout"]);
    });

    it("lays a preset over the event's cards and keeps every word", async () => {
      const { id } = await liveEvent();
      await put(id, layoutWith(written, ["podium", "card:aaaaaa11"]));
      const saved = await put(id, { preset: "essentials" });
      expect(saved.statusCode).toBe(200);
      const { layout } = saved.json<{
        layout: { home: { order: string[]; hidden: string[] }; content: HomeContent };
      }>();
      expect(layout.content).toEqual(written);
      expect(layout.home.order.slice(-2)).toEqual(["card:aaaaaa11", "card:bbbbbb22"]);
      expect(layout.home.hidden).toEqual(
        expect.arrayContaining(["streak", "podium", "card:aaaaaa11"]),
      );
      expect(layout.home.hidden).not.toContain("card:bbbbbb22");
    });

    it("reads damaged stored content safely: a bad item is left out and the rest still shows", async () => {
      const { id, member } = await liveEvent();
      const damaged = {
        ...layoutWith(written),
        content: {
          ...written,
          banner: [{ title: 5 }, slide],
          quickLinks: [link("javascript:alert(1)")],
          cards: [{ id: "x" }, textCard],
        },
      };
      await fixture.owner(
        `UPDATE event SET config = jsonb_set(config, '{layout}', $2::jsonb, true) WHERE id = $1`,
        [id, JSON.stringify(damaged)],
      );
      const { content } = (await appConfig(id, member)).layout;
      expect(content.banner).toHaveLength(1);
      expect(content.quickLinks).toEqual([]);
      expect(content.cards.map((card) => card.id)).toEqual(["aaaaaa11"]);
    });

    it("gives nothing outside an event and refuses another organizer's save and a stranger's", async () => {
      const { id } = await liveEvent();
      await put(id, layoutWith(written));
      const outside = await test.app.inject({ method: "GET", url: "/v1/config" });
      expect(outside.json<{ layout: unknown }>().layout).toEqual(DEFAULT_COMPOSED_LAYOUT);
      for (const session of [other, stranger]) {
        const refused = await put(id, layoutWith(EMPTY_CONTENT), session);
        expect([403, 404]).toContain(refused.statusCode);
      }
      expect(await eventView(id)).toMatchObject({ layout: { content: written } });
    });
  });

  describe("the event info page and the extra page (T-613)", () => {
    const written = {
      ...EMPTY_CONTENT,
      about: words("A day of games.", "يوم من الألعاب."),
      faq: [{ question: words("Is parking free?"), answer: words("Yes, in lot B.") }],
      contacts: [
        { label: words("Front desk"), kind: "phone", value: "+966501234567" },
        { label: words("Website"), kind: "link", value: "https://example.com/event" },
      ],
      page: {
        title: words("Venue rules"),
        blocks: [
          { kind: "heading", text: words("Before you come") },
          { kind: "list", items: words("ID card\nTicket") },
          { kind: "link", label: words("Map"), url: "https://example.com/map" },
        ],
      },
    };
    const reordered = ["rules", "faq", "about", "venue", "when", "schedule", "contacts"];
    const infoLayout = (
      content: unknown = written,
      info: { order: string[]; hidden: string[] } = { order: reordered, hidden: ["schedule"] },
      home: { order: string[]; hidden: string[] } = { order: [...HOME_KEYS], hidden: ["podium"] },
    ) => ({ bar: { order: BAR_KEYS, hidden: [] }, home, info, content, looks: DEFAULT_LOOKS });

    it("stores what an owner or an editor wrote and the app gets the shown sections in order", async () => {
      const { id, member } = await liveEvent();
      for (const session of [owner, editor]) {
        const saved = await put(id, infoLayout(), session);
        expect(saved.statusCode).toBe(200);
        expect(saved.json<{ layout: { content: HomeContent } }>().layout.content).toEqual(written);
      }
      const config = await appConfig(id, member);
      expect(config.layout.info).toEqual(["rules", "faq", "about", "venue", "when", "contacts"]);
      expect(config.layout.content).toMatchObject({
        about: written.about,
        faq: written.faq,
        contacts: written.contacts,
        page: written.page,
      });
      expect(await eventView(id)).toMatchObject({
        layout: { info: { order: reordered, hidden: ["schedule"] }, content: written },
      });
    });

    const full = (length: number) => words("x".repeat(length), "ا".repeat(length));
    const maximal = {
      ...EMPTY_CONTENT,
      about: full(1000),
      faq: Array.from({ length: 12 }, () => ({ question: full(120), answer: full(500) })),
      contacts: Array.from({ length: 5 }, () => ({
        label: full(40),
        kind: "link",
        value: `https://example.com/${"a".repeat(280)}`,
      })),
      page: {
        title: full(60),
        blocks: Array.from({ length: 12 }, () => ({
          kind: "list",
          items: words(
            Array.from({ length: 10 }, () => "x".repeat(120)).join("\n"),
            Array.from({ length: 10 }, () => "ا".repeat(120)).join("\n"),
          ),
        })),
      },
    };

    it("saves a maximal info page, far past 8 KB, and audits it once", async () => {
      const { id } = await liveEvent();
      const payload = infoLayout(maximal);
      expect(Buffer.byteLength(JSON.stringify(payload))).toBeGreaterThan(60_000);
      const saved = await put(id, payload);
      expect(saved.statusCode).toBe(200);
      expect(saved.json<{ layout: { content: HomeContent } }>().layout.content).toEqual(maximal);
      expect(await eventView(id)).toMatchObject({ layout: { content: maximal } });
      const audit = await fixture.owner(
        "SELECT 1 FROM audit_log WHERE event_id = $1 AND action = 'event.layout.update'",
        [id],
      );
      expect(audit).toHaveLength(1);
    });

    it("refuses a body past the layout limit with 413 and stores nothing", async () => {
      const { id } = await liveEvent();
      const saved = await put(id, infoLayout({ ...maximal, padding: "x".repeat(170 * 1024) }));
      expect(saved.statusCode).toBe(413);
      expect(await eventView(id)).toMatchObject({ layout: DEFAULT_LAYOUT });
    });

    it("keeps the words of a hidden section and of a hidden page link on the server", async () => {
      const { id, member } = await liveEvent();
      const home = { order: [...HOME_KEYS], hidden: ["podium", "page"] };
      await put(id, infoLayout(written, { order: reordered, hidden: ["about", "faq"] }, home));
      const config = await appConfig(id, member);
      expect(config.layout.info).not.toContain("about");
      expect(config.layout.content).toMatchObject({ faq: [], page: null });
      expect(JSON.stringify(config)).not.toContain("Is parking free");
      expect(JSON.stringify(config)).not.toContain("Venue rules");
      expect(await eventView(id)).toMatchObject({ layout: { content: written } });
    });

    it.each([
      ["a section the page does not have", { order: [...INFO_KEYS, "poem"], hidden: [] }],
      ["a section left out", { order: INFO_KEYS.slice(1), hidden: [] }],
      ["a section listed twice", { order: [...INFO_KEYS, "faq"], hidden: [] }],
    ])("refuses %s with 422 invalid_layout", async (_label, info) => {
      const { id } = await liveEvent();
      expect(codeOf(await put(id, infoLayout(written, info)))).toEqual([422, "invalid_layout"]);
      expect(await eventView(id)).toMatchObject({ layout: DEFAULT_LAYOUT });
    });

    it("refuses a layout that leaves the info page out", async () => {
      const { id } = await liveEvent();
      const { info: _info, ...without } = infoLayout();
      expect(codeOf(await put(id, without))).toEqual([422, "invalid_layout"]);
    });

    const contact = (kind: string, value: string) => ({ label: words("Desk"), kind, value });
    const block = (change: Record<string, unknown>) => ({ ...written.page, ...change });
    it.each([
      ["a javascript link as a website", { contacts: [contact("link", "javascript:alert(1)")] }],
      ["an http website", { contacts: [contact("link", "http://example.com")] }],
      ["an email with a header in it", { contacts: [contact("email", "a%0d%0a@example.com")] }],
      ["a phone that is a tel link", { contacts: [contact("phone", "tel:+966501234567")] }],
      [
        "a sixth contact",
        { contacts: Array.from({ length: 6 }, () => contact("phone", "0501234567")) },
      ],
      ["a question with no answer", { faq: [{ question: words("Q"), answer: words("") }] }],
      ["a field no entry has", { faq: [{ ...written.faq[0], html: "<b>x</b>" }] }],
      ["an About text over its limit", { about: words("x".repeat(1001)) }],
      ["a page with no title", { page: block({ title: words("") }) }],
      ["a page with no part", { page: block({ blocks: [] }) }],
      [
        "a page with a video part",
        { page: block({ blocks: [{ kind: "video", url: "https://example.com/v" }] }) },
      ],
      [
        "a page with a picture on a part",
        {
          page: block({
            blocks: [{ kind: "text", text: words("x"), image: "https://example.com/a.png" }],
          }),
        },
      ],
      [
        "a page link over http",
        {
          page: block({
            blocks: [{ kind: "link", label: words("Go"), url: "http://example.com" }],
          }),
        },
      ],
      [
        "a page with thirteen parts",
        {
          page: block({
            blocks: Array.from({ length: 13 }, () => ({ kind: "text", text: words("x") })),
          }),
        },
      ],
    ])("refuses %s with 422 invalid_layout and stores nothing", async (_label, change) => {
      const { id } = await liveEvent();
      const refused = await put(id, infoLayout({ ...written, ...change }));
      expect(codeOf(refused)).toEqual([422, "invalid_layout"]);
      expect(await eventView(id)).toMatchObject({ layout: DEFAULT_LAYOUT });
    });

    it("saves control characters cleaned, never a server error (a NUL fails the JSON write)", async () => {
      const { id } = await liveEvent();
      const dirty = {
        ...written,
        about: words("Doors\u0000 open\u200B at \u0669"),
        faq: [{ question: words("Q\u0007?"), answer: words("A\u0000\u0085") }],
        page: block({
          title: words("Rules\u0000"),
          blocks: [{ kind: "text", text: words("No\u001B bags") }],
        }),
      };
      const saved = await put(id, infoLayout(dirty));
      expect(saved.statusCode).toBe(200);
      const { content } = saved.json<{ layout: { content: HomeContent } }>().layout;
      expect(content.about.en).toBe("Doors open at 9");
      expect(content.faq[0]).toEqual({ question: words("Q?"), answer: words("A") });
      expect(content.page).toEqual({
        title: words("Rules"),
        blocks: [{ kind: "text", text: words("No bags") }],
      });
    });

    it("keeps the info page's order and words when a preset is laid over the layout", async () => {
      const { id } = await liveEvent();
      await put(id, infoLayout());
      const saved = await put(id, { preset: "essentials" });
      expect(saved.statusCode).toBe(200);
      const { layout } = saved.json<{
        layout: { info: { order: string[] }; content: HomeContent };
      }>();
      expect(layout.info.order).toEqual(reordered);
      expect(layout.content).toEqual(written);
    });

    it("reads damaged stored content safely: a bad entry or part is left out and the rest still shows", async () => {
      const { id, member } = await liveEvent();
      const damaged = {
        ...infoLayout(),
        info: { order: ["poem", "faq"], hidden: ["rules"] },
        content: {
          ...written,
          faq: [{ question: 5 }, written.faq[0]],
          contacts: [contact("link", "javascript:alert(1)"), written.contacts[0]],
          page: block({ blocks: [{ kind: "video" }, written.page.blocks[0]] }),
        },
      };
      await fixture.owner(
        "UPDATE event SET config = jsonb_set(config, '{layout}', $2::jsonb, true) WHERE id = $1",
        [id, JSON.stringify(damaged)],
      );
      const { layout } = await appConfig(id, member);
      expect(layout.info).toContain("rules");
      expect(layout.info).not.toContain("poem");
      expect(layout.content.faq).toEqual(written.faq);
      expect(layout.content.contacts).toEqual([written.contacts[0]]);
      expect(layout.content.page?.blocks).toEqual([written.page.blocks[0]]);
    });

    it("gives nothing outside an event and refuses another organizer's save and a stranger's", async () => {
      const { id } = await liveEvent();
      await put(id, infoLayout());
      const outside = await test.app.inject({ method: "GET", url: "/v1/config" });
      expect(outside.json<{ layout: unknown }>().layout).toEqual(DEFAULT_COMPOSED_LAYOUT);
      for (const session of [other, stranger]) {
        const refused = await put(
          id,
          infoLayout(EMPTY_CONTENT, { order: [...INFO_KEYS], hidden: [] }),
          session,
        );
        expect([403, 404]).toContain(refused.statusCode);
      }
      expect(await eventView(id)).toMatchObject({ layout: { content: written } });
    });
  });

  const playedEvent = async (phase: "live" | "ended" = "live") => {
    const id = await fixture.newEvent({ phase });
    const players: Player[] = [];
    for (const points of [910, 870]) {
      const player = await fixture.newPlayer();
      const enrollment = await fixture.join(id, player);
      await fixture.earn(id, enrollment, { points });
      players.push({ id: player, token: await bearer(player) });
    }
    return { id, first: players[0] as Player, second: players[1] as Player };
  };

  describe("how the ranking, quests and shop are drawn (T-611)", () => {
    type Looks = typeof DEFAULT_LOOKS;
    const rankOnly: Looks = {
      ranking: { layout: "podium", scores: "rank_only" },
      quests: "grid",
      shop: "grid",
    };
    type RankingBody = {
      scores: boolean;
      today: boolean;
      rows: { rank: number; username: string; score?: number }[];
      me: { rank: number; score?: number } | null;
    };
    const rankingOf = async (id: string, member: Player, scope = "event") => {
      const response = await test.app.inject({
        method: "GET",
        url: `/v1/events/${id}/ranking?scope=${scope}`,
        headers: { authorization: `Bearer ${member.token}` },
      });
      return {
        status: response.statusCode,
        body: response.body,
        json: response.json<RankingBody>(),
      };
    };
    it("stores the looks, audits the change, and sends them to the app and the dashboard", async () => {
      const { id, member } = await liveEvent();
      for (const session of [owner, editor]) {
        const saved = await put(id, arranged(rankOnly), session);
        expect(saved.statusCode).toBe(200);
        expect(saved.json<{ layout: { looks: Looks } }>().layout.looks).toEqual(rankOnly);
      }
      expect(await eventView(id)).toMatchObject({ layout: { looks: rankOnly } });
      expect((await appConfig(id, member)).layout).toMatchObject({ looks: rankOnly });
      const audit = await fixture.owner(
        "SELECT 1 FROM audit_log WHERE event_id = $1 AND action = 'event.layout.update'",
        [id],
      );
      expect(audit).toHaveLength(1);
    });

    it("starts as the screens have always been drawn, and a preset leaves the looks alone", async () => {
      const { id } = await liveEvent();
      expect(await eventView(id)).toMatchObject({ layout: { looks: DEFAULT_LOOKS } });
      await put(id, arranged(rankOnly));
      const saved = await put(id, { preset: "prizes_first" });
      expect(saved.json<{ layout: { looks: Looks } }>().layout.looks).toEqual(rankOnly);
    });

    it.each([
      ["no looks", undefined],
      ["a look that does not exist", { ...rankOnly, shop: "carousel" }],
      [
        "a scores value that does not exist",
        { ...rankOnly, ranking: { layout: "list", scores: "top3" } },
      ],
      ["a field it does not know", { ...rankOnly, banner: "x" }],
    ])("refuses %s with 422 invalid_layout and stores nothing", async (_label, looks) => {
      const { id } = await liveEvent();
      expect(codeOf(await put(id, arranged(looks)))).toEqual([422, "invalid_layout"]);
      expect(await eventView(id)).toMatchObject({ layout: DEFAULT_LAYOUT });
    });

    it("gives every score in the ranking while the scores are shown", async () => {
      const { id, first, second } = await playedEvent();
      const read = await rankingOf(id, second);
      expect(read.status).toBe(200);
      expect(read.json).toMatchObject({
        scores: true,
        rows: [
          { rank: 1, score: 910 },
          { rank: 2, score: 870 },
        ],
        me: { rank: 2, score: 870 },
      });
      expect((await rankingOf(id, first)).json.me).toMatchObject({ rank: 1, score: 910 });
    });

    it("leaves every score out of the ranking answer on 'rank only', and brings them back when changed", async () => {
      const { id, first, second } = await playedEvent();
      expect((await put(id, arranged(rankOnly))).statusCode).toBe(200);
      for (const member of [first, second]) {
        const read = await rankingOf(id, member);
        expect(read.status).toBe(200);
        expect(read.json.scores).toBe(false);
        expect(read.json.rows.map((row) => [row.rank, "score" in row])).toEqual([
          [1, false],
          [2, false],
        ]);
        expect(read.json.me).not.toBeNull();
        expect(read.json.me).not.toHaveProperty("score");
        expect(read.body).not.toMatch(/910|870|"score"/);
        const today = await rankingOf(id, member, "today");
        expect(today.status).toBe(200);
        expect(today.json.today).toBe(true);
        expect(today.json.scores).toBe(false);
        expect(today.json.rows.map((row) => [row.rank, "score" in row])).toEqual([
          [1, false],
          [2, false],
        ]);
        expect(today.json.me).not.toHaveProperty("score");
        expect(today.body).not.toMatch(/910|870|"score"/);
      }
      expect((await rankingOf(id, second)).json.me).toMatchObject({ rank: 2 });
      await put(id, arranged({ ...rankOnly, ranking: { layout: "podium", scores: "shown" } }));
      expect((await rankingOf(id, second)).json).toMatchObject({
        scores: true,
        me: { rank: 2, score: 870 },
      });
    });

    it("still refuses the ranking when its switch is off, whatever the looks say", async () => {
      const { id, first } = await playedEvent();
      await put(id, arranged(rankOnly));
      const off = await test.app.inject({
        method: "PUT",
        url: `${base(id)}/ranking`,
        headers: withSession(owner, { "idempotency-key": randomUUID() }),
        payload: { enabled: false },
      });
      expect(off.statusCode).toBe(200);
      const refused = await rankingOf(id, first);
      expect(refused.status).toBe(404);
      expect(refused.body).not.toMatch(/910|870|"score"/);
    });

    it("gives a stranger and a signed-out caller nothing, on any looks", async () => {
      const { id } = await playedEvent();
      await put(id, arranged(rankOnly));
      const outsider = await fixture.newPlayer();
      const intruder = await rankingOf(id, { id: outsider, token: await bearer(outsider) });
      expect([403, 404]).toContain(intruder.status);
      expect(intruder.body).not.toMatch(/910|870|"score"/);
      const anonymous = await test.app.inject({ method: "GET", url: `/v1/events/${id}/ranking` });
      expect(anonymous.statusCode).toBe(401);
    });

    it("leaves the final scores out of the revealed results on 'rank only', and gives them otherwise", async () => {
      const { id, first, second } = await playedEvent("ended");
      const team = (method: "GET" | "POST", path: string, payload?: object) =>
        test.app.inject({
          method,
          url: `${base(id)}/results${path}`,
          headers: withSession(owner, { "idempotency-key": randomUUID() }),
          ...(payload === undefined ? {} : { payload }),
        });
      const places = (await team("GET", "")).json<{ places: { enrollmentId: string }[] }>().places;
      const expected = places.map((place) => place.enrollmentId);
      expect((await team("POST", "/confirm", { expected })).statusCode).toBe(200);
      const claimUntil = new Date(Date.now() + 96 * 3_600_000).toISOString();
      expect((await team("POST", "/reveal", { claimUntil })).statusCode).toBe(200);
      type ResultsBody = {
        scores: boolean;
        revealed: boolean;
        places: { rank: number; score?: number }[];
      };
      const results = async (member: Player) => {
        const response = await test.app.inject({
          method: "GET",
          url: `/v1/events/${id}/results`,
          headers: { authorization: `Bearer ${member.token}` },
        });
        return { body: response.body, json: response.json<ResultsBody>() };
      };
      expect((await results(first)).json).toMatchObject({
        scores: true,
        revealed: true,
        places: [
          { rank: 1, score: 910 },
          { rank: 2, score: 870 },
        ],
      });
      await put(id, arranged(rankOnly));
      for (const member of [first, second]) {
        const read = await results(member);
        expect(read.json.scores).toBe(false);
        expect(read.json.revealed).toBe(true);
        expect(read.json.places.map((place) => place.rank)).toEqual([1, 2]);
        expect(read.body).not.toMatch(/910|870|"score"/);
      }
    });
  });
});
