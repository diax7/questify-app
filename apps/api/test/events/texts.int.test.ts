import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_LAYOUT, EVENT_TEXT_MAX, type EventTexts } from "@questify/shared";
import {
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { pushFixture, type PushFixture } from "#test/support/push";
import { TEST_DATABASE_URL } from "#test/support/test-db";

const NONE: EventTexts = { ar: {}, en: {} };
const PRIZES = { ar: { "nav.rewards": "الهدايا" }, en: { "nav.rewards": "Prizes" } };

const codeOf = (response: { statusCode: number; json: () => { code?: string } }) => [
  response.statusCode,
  response.json().code,
];

type Player = { id: string; token: string };

/**
 * An event's renamed labels over HTTP (T-614, FR-1843): who may save them, that only the approved labels are accepted and
 * cleaned, that a blank one returns to the platform's text, that one event's labels never reach another, and that a damaged
 * stored value still reads safely.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("event labels over HTTP", () => {
  let fixture: PushFixture;
  let test: TestApp;
  let owner: string;
  let editor: string;
  let scoped: string;
  let other: string;
  let stranger: string;
  let scopedEvent: string;

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
    const staff = async (
      name: string,
      role: string,
      organizer = fixture.ids.orgA,
      scope: string[] | null = null,
    ) => {
      const email = name + "@texts.test";
      const id = await createStaff(fixture.db.owner, { email });
      await fixture.owner(
        "INSERT INTO organizer_member (organizer_id, staff_user_id, role, event_scope) VALUES ($1, $2, $3, $4)",
        [organizer, id, role, scope],
      );
      return signInFully(test, email);
    };
    await fixture.owner("UPDATE organizer_member SET role = 'editor' WHERE organizer_id = $1", [
      fixture.ids.orgA,
    ]);
    scopedEvent = await fixture.newEvent({ phase: "live" });
    owner = await staff("owner", "owner");
    editor = await staff("editor", "editor");
    scoped = await staff("scoped", "editor", fixture.ids.orgA, [scopedEvent]);
    other = await staff("other", "owner", fixture.ids.orgB);
    await createStaff(fixture.db.owner, { email: "stranger@texts.test" });
    stranger = await signInFully(test, "stranger@texts.test");
  });
  afterAll(async () => {
    await test.close();
    await fixture.close();
  });

  const base = (id: string) => `/v1/organizers/${fixture.ids.orgA}/events/${id}`;
  const put = (id: string, payload: unknown, session = owner) =>
    test.app.inject({
      method: "PUT",
      url: `${base(id)}/texts`,
      headers: withSession(session, { "idempotency-key": randomUUID() }),
      payload: payload as object,
    });
  const eventView = async (id: string) =>
    (await test.app.inject({ method: "GET", url: base(id), headers: withSession(owner) })).json<{
      event: { texts: EventTexts; terms: unknown };
    }>().event;
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
    ).json<{ texts: EventTexts }>();
  const auditOf = (id: string) =>
    fixture.owner<{ before: unknown; after: unknown }>(
      "SELECT before, after FROM audit_log WHERE event_id = $1 AND action = 'event.texts.update' ORDER BY id",
      [id],
    );

  it("starts with no renamed label, in the dashboard's read and the app's configuration", async () => {
    const { id, member } = await liveEvent();
    expect((await eventView(id)).texts).toEqual(NONE);
    expect((await appConfig(id, member)).texts).toEqual(NONE);
    const list = await test.app.inject({
      method: "GET",
      url: `/v1/organizers/${fixture.ids.orgA}/events`,
      headers: withSession(owner),
    });
    expect(list.json<{ events: object[] }>().events[0]).not.toHaveProperty("texts");
  });

  it("lets an owner or an editor rename a label in both languages, and the app receives it", async () => {
    const { id, member } = await liveEvent();
    for (const session of [owner, editor]) {
      const saved = await put(id, PRIZES, session);
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toEqual({ texts: PRIZES });
    }
    expect((await eventView(id)).texts).toEqual(PRIZES);
    expect((await appConfig(id, member)).texts).toEqual(PRIZES);
  });

  it("changes that event only: another event of the organizer and the platform keep the platform's text", async () => {
    const first = await liveEvent();
    const second = await liveEvent();
    await put(first.id, PRIZES);
    expect((await appConfig(second.id, second.member)).texts).toEqual(NONE);
    expect((await eventView(second.id)).texts).toEqual(NONE);
    const outside = await test.app.inject({ method: "GET", url: "/v1/config" });
    expect(outside.json<{ texts: unknown }>().texts).toEqual(NONE);
  });

  it("falls back to the platform's text for a blank label, one language at a time", async () => {
    const { id, member } = await liveEvent();
    await put(id, PRIZES);
    const englishBlank = await put(id, {
      ar: PRIZES.ar,
      en: { "nav.rewards": "   " },
    });
    expect(englishBlank.json()).toEqual({ texts: { ar: PRIZES.ar, en: {} } });
    expect((await appConfig(id, member)).texts).toEqual({ ar: PRIZES.ar, en: {} });
    const allBlank = await put(id, { ar: { "nav.rewards": "" }, en: {} });
    expect(allBlank.json()).toEqual({ texts: NONE });
    expect((await appConfig(id, member)).texts).toEqual(NONE);
    expect(codeOf(await put(id, {}))).toEqual([200, undefined]);
  });

  it("refuses a label that is not on the approved list and stores nothing", async () => {
    const { id } = await liveEvent();
    for (const key of ["legal.terms.title", "common.loading", "wizard.rewards.name", "nav.fake"]) {
      const refused = await put(id, { ar: { "nav.rewards": "الهدايا" }, en: { [key]: "Hello" } });
      expect(codeOf(refused), key).toEqual([422, "invalid_texts"]);
      expect(refused.json()).toMatchObject({ details: { field: `en.${key}` } });
    }
    expect((await eventView(id)).texts).toEqual(NONE);
    expect(await auditOf(id)).toEqual([]);
  });

  it("refuses a lost or foreign placeholder, a text that is too long and a body of the wrong shape", async () => {
    const { id } = await liveEvent();
    const refusals: [unknown, string][] = [
      [{ en: { "nav.rewards": "{count} prizes" } }, "en.nav.rewards"],
      [{ ar: { "nav.rewards": "جوائز {points}" } }, "ar.nav.rewards"],
      [{ en: { "nav.rewards": "a".repeat(EVENT_TEXT_MAX + 1) } }, "en.nav.rewards"],
      [{ en: { "nav.rewards": 5 } }, "en.nav.rewards"],
      [{ en: [] }, "en"],
      [{ fr: {} }, "fr"],
      [[], "body"],
    ];
    for (const [payload, field] of refusals) {
      const refused = await put(id, payload);
      expect(codeOf(refused), JSON.stringify(payload)).toEqual([422, "invalid_texts"]);
      expect(refused.json()).toMatchObject({ details: { field } });
    }
    expect((await eventView(id)).texts).toEqual(NONE);
  });

  it("lets a label drop the event's own word, but keeps it when the label uses it", async () => {
    const { id } = await liveEvent();
    const saved = await put(id, {
      ar: { "nav.quests": "مغامرات" },
      en: { "nav.quests": "Adventures" },
    });
    expect(saved.json()).toEqual({
      texts: { ar: { "nav.quests": "مغامرات" }, en: { "nav.quests": "Adventures" } },
    });
    expect((await put(id, { en: { "nav.quests": "Big {questCap}" } })).statusCode).toBe(200);
  });

  it("cleans the text: invisible, control and bidi override characters go, digits become Western", async () => {
    const { id, member } = await liveEvent();
    const saved = await put(id, {
      ar: { "nav.scan": "  امسح​   ٢٠٢٦\u0000 " },
      en: { "nav.scan": "‮nacS‬\u0007  now" },
    });
    expect(saved.statusCode).toBe(200);
    const expected = { ar: { "nav.scan": "امسح 2026" }, en: { "nav.scan": "nacS now" } };
    expect(saved.json()).toEqual({ texts: expected });
    expect((await appConfig(id, member)).texts).toEqual(expected);
  });

  it("keeps the event's other settings, audits a change once, and refuses an archived event", async () => {
    const { id } = await liveEvent();
    await fixture.owner(
      `UPDATE event SET config = jsonb_set(config, '{branding}', '{"accent":"sky"}'::jsonb, true) WHERE id = $1`,
      [id],
    );
    await put(id, PRIZES);
    await put(id, PRIZES);
    expect(await auditOf(id)).toEqual([{ before: { texts: NONE }, after: { texts: PRIZES } }]);
    const view = await eventView(id);
    expect(view).toMatchObject({ texts: PRIZES });
    expect(view.terms).toBeDefined();
    const stored = await fixture.owner<{ config: { layout?: unknown; branding: unknown } }>(
      "SELECT config FROM event WHERE id = $1",
      [id],
    );
    expect(stored[0]?.config.branding).toEqual({ accent: "sky" });
    expect(stored[0]?.config.layout ?? DEFAULT_LAYOUT).toEqual(DEFAULT_LAYOUT);
    await fixture.owner("UPDATE event SET status = 'archived' WHERE id = $1", [id]);
    expect(codeOf(await put(id, NONE))).toEqual([409, "event_archived"]);
  });

  it("gives a copy of the event its labels, and the copy changes on its own", async () => {
    const { id } = await liveEvent();
    await put(id, PRIZES);
    const copy = await test.app.inject({
      method: "POST",
      url: `${base(id)}/duplicate`,
      headers: withSession(owner, { "idempotency-key": randomUUID() }),
      payload: {
        name: { en: "Copy" },
        startsAt: "2031-01-01T09:00",
        endsAt: "2031-01-01T17:00",
      },
    });
    expect(copy.statusCode).toBe(201);
    const copyId = copy.json<{ event: { id: string } }>().event.id;
    expect((await eventView(copyId)).texts).toEqual(PRIZES);
    await put(copyId, { en: { "nav.rewards": "Gifts" } });
    expect((await eventView(id)).texts).toEqual(PRIZES);
  });

  it("refuses another organizer's owner, an editor outside the event, a stranger and a signed-out caller", async () => {
    const { id } = await liveEvent();
    for (const session of [other, stranger, scoped]) {
      expect([403, 404]).toContain((await put(id, PRIZES, session)).statusCode);
    }
    const signedOut = await test.app.inject({
      method: "PUT",
      url: `${base(id)}/texts`,
      payload: PRIZES,
    });
    expect([401, 403]).toContain(signedOut.statusCode);
    expect((await eventView(id)).texts).toEqual(NONE);
    expect(await auditOf(id)).toEqual([]);
  });

  it("lets an editor limited to an event change that event only", async () => {
    expect((await put(scopedEvent, PRIZES, scoped)).statusCode).toBe(200);
    expect((await eventView(scopedEvent)).texts).toEqual(PRIZES);
  });

  it("refuses a player, who holds no staff session", async () => {
    const { id, member } = await liveEvent();
    const refused = await test.app.inject({
      method: "PUT",
      url: `${base(id)}/texts`,
      headers: { authorization: `Bearer ${member.token}`, "idempotency-key": randomUUID() },
      payload: PRIZES,
    });
    expect([401, 403]).toContain(refused.statusCode);
    expect((await appConfig(id, member)).texts).toEqual(NONE);
  });

  it("reads damaged stored labels safely: only the usable ones reach the app", async () => {
    const { id, member } = await liveEvent();
    const damaged = {
      ar: { "nav.rewards": "الهدايا", "nav.scan": 5, "legal.terms.title": "x" },
      en: {
        "nav.rewards": "Pri‮zes",
        "nav.profile": "Me {points}",
        "nav.ranking": "Board",
        "nav.home": "   ",
      },
    };
    await fixture.owner(
      `UPDATE event SET config = jsonb_set(config, '{texts}', $2::jsonb, true) WHERE id = $1`,
      [id, JSON.stringify(damaged)],
    );
    expect((await appConfig(id, member)).texts).toEqual({
      ar: { "nav.rewards": "الهدايا" },
      en: { "nav.ranking": "Board" },
    });
    expect((await eventView(id)).texts).toEqual({
      ar: { "nav.rewards": "الهدايا" },
      en: { "nav.ranking": "Board" },
    });
  });

  it("reads a stored value that is not even an object as no renamed label", async () => {
    const { id, member } = await liveEvent();
    await fixture.owner(
      `UPDATE event SET config = jsonb_set(config, '{texts}', '"damaged"'::jsonb, true) WHERE id = $1`,
      [id],
    );
    expect((await appConfig(id, member)).texts).toEqual(NONE);
    expect((await eventView(id)).texts).toEqual(NONE);
  });
});
