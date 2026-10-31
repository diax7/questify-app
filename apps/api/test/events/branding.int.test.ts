import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

const eventUrl = (path: string, id: string) => `/v1/events/${id}/${path}`;

/**
 * An event's accent colour and its shop, live polls, maps and agenda switches over HTTP (T-602, FR-1009, FR-1023): who
 * may change them, what the player's side then refuses, and what a stranger can reach.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("event branding and switches over HTTP", () => {
  let fixture: PushFixture;
  let test: TestApp;
  let owner: string;
  let editor: string;
  let other: string;
  let stranger: string;
  let event: string;
  let member: Player;

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
      const email = name + "@branding.test";
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
    await createStaff(fixture.db.owner, { email: "stranger@branding.test" });
    stranger = await signInFully(test, "stranger@branding.test");
    event = await fixture.newEvent({ phase: "live" });
    const id = await fixture.newPlayer();
    await fixture.join(event, id);
    member = { id, token: await bearer(id) };
  });
  afterAll(async () => {
    await test.close();
    await fixture.close();
  });

  const base = (id = event) => `/v1/organizers/${fixture.ids.orgA}/events/${id}`;
  const team = (method: "GET" | "PUT", url: string, payload?: object, session = owner) =>
    test.app.inject({
      method,
      url,
      headers: withSession(session, { "idempotency-key": randomUUID() }),
      ...(payload === undefined ? {} : { payload }),
    });
  const asPlayer = (method: "GET" | "PUT", url: string, who: Player | null, payload?: object) =>
    test.app.inject({
      method,
      url,
      ...(who === null ? {} : { headers: { authorization: `Bearer ${who.token}` } }),
      ...(payload === undefined ? {} : { payload }),
    });
  const eventView = async (id = event) =>
    (await team("GET", base(id))).json<{ event: Record<string, unknown> }>().event;
  const composed = async (id = event) =>
    (await asPlayer("GET", `/v1/config?event=${id}`, member)).json<{
      branding: { accent: string | null };
      features: Record<string, { enabled: boolean }>;
    }>();

  describe("the accent colour", () => {
    it("starts as none, lets an owner or an editor pick one, and reaches the app's configuration", async () => {
      const ev = await fixture.newEvent({ phase: "live" });
      expect(await eventView(ev)).toMatchObject({ branding: { accent: null } });
      for (const [session, accent] of [
        [owner, "sky"],
        [editor, "honey"],
      ] as const) {
        const saved = await team("PUT", `${base(ev)}/branding`, { accent }, session);
        expect(saved.statusCode).toBe(200);
        expect(saved.json()).toEqual({ branding: { accent } });
        expect(await eventView(ev)).toMatchObject({ branding: { accent } });
      }
      const joined = await fixture.newPlayer();
      await fixture.join(ev, joined);
      const config = await asPlayer("GET", `/v1/config?event=${ev}`, {
        id: joined,
        token: await bearer(joined),
      });
      expect(config.json()).toMatchObject({ branding: { accent: "honey" } });
      const reset = await team("PUT", `${base(ev)}/branding`, { accent: null });
      expect(reset.json()).toEqual({ branding: { accent: null } });
    });

    it.each([
      ["a free colour", { accent: "#FF0000" }],
      ["an unknown name", { accent: "neon" }],
      ["a missing accent", {}],
      ["a font beside it", { accent: "sky", font: "serif" }],
      ["a theme", { accent: "sky", theme: "dark" }],
    ])("refuses %s with 422 invalid_branding and changes nothing", async (_label, payload) => {
      const ev = await fixture.newEvent({ phase: "live" });
      expect(codeOf(await team("PUT", `${base(ev)}/branding`, payload))).toEqual([
        422,
        "invalid_branding",
      ]);
      expect(await eventView(ev)).toMatchObject({ branding: { accent: null } });
    });

    it("refuses another organizer's owner and a signed-in stranger, and a signed-out caller", async () => {
      const ev = await fixture.newEvent({ phase: "live" });
      for (const session of [other, stranger]) {
        const refused = await team("PUT", `${base(ev)}/branding`, { accent: "rose" }, session);
        expect([403, 404]).toContain(refused.statusCode);
      }
      const signedOut = await test.app.inject({
        method: "PUT",
        url: `${base(ev)}/branding`,
        payload: { accent: "rose" },
      });
      expect([401, 403]).toContain(signedOut.statusCode);
      expect(await eventView(ev)).toMatchObject({ branding: { accent: null } });
    });

    it("refuses an archived event, and audits a change once", async () => {
      const ev = await fixture.newEvent({ phase: "live" });
      await team("PUT", `${base(ev)}/branding`, { accent: "violet" });
      await team("PUT", `${base(ev)}/branding`, { accent: "violet" });
      const audit = await fixture.owner<{ after: unknown }>(
        "SELECT after FROM audit_log WHERE event_id = $1 AND action = 'event.branding.update'",
        [ev],
      );
      expect(audit).toEqual([{ after: { branding: { accent: "violet" } } }]);
      await fixture.owner("UPDATE event SET status = 'archived' WHERE id = $1", [ev]);
      expect(codeOf(await team("PUT", `${base(ev)}/branding`, { accent: "sky" }))).toEqual([
        409,
        "event_archived",
      ]);
    });

    it("gives the configuration outside an event no accent, whatever an event picked", async () => {
      await team("PUT", `${base()}/branding`, { accent: "ember" });
      const config = await asPlayer("GET", "/v1/config", null);
      expect(config.json()).toMatchObject({ branding: { accent: null } });
    });
  });

  describe.each(["shop", "polls", "maps", "agenda"] as const)("the %s switch", (feature) => {
    const url = (id = event) => `${base(id)}/features/${feature}`;

    it("starts on, belongs to the owner alone, and shows in the event and the app's configuration", async () => {
      const ev = await fixture.newEvent({ phase: "live" });
      expect(await eventView(ev)).toMatchObject({ [feature]: true });
      expect(codeOf(await team("PUT", url(ev), { enabled: false }, editor))).toEqual([
        403,
        "owner_only",
      ]);
      expect(codeOf(await team("PUT", url(ev), { enabled: false }, other))).toEqual([
        404,
        "not_found",
      ]);
      expect((await team("PUT", url(ev), { enabled: false })).json()).toEqual({ [feature]: false });
      expect(await eventView(ev)).toMatchObject({ [feature]: false });
      const joined = await fixture.newPlayer();
      await fixture.join(ev, joined);
      const config = await asPlayer("GET", `/v1/config?event=${ev}`, {
        id: joined,
        token: await bearer(joined),
      });
      expect(
        config.json<{ features: Record<string, { enabled: boolean }> }>().features[feature],
      ).toEqual({ enabled: false, minAppVersion: null, message: null });
      expect((await team("PUT", url(ev), { enabled: true })).json()).toEqual({ [feature]: true });
    });

    it("keeps the event's other switches as they were", async () => {
      const ev = await fixture.newEvent({ phase: "live" });
      await team("PUT", `${base(ev)}/ranking`, { enabled: false });
      await team("PUT", url(ev), { enabled: false });
      expect(await eventView(ev)).toMatchObject({ ranking: false, [feature]: false });
    });
  });

  describe("what the player's side refuses while a switch is off", () => {
    it("answers the shop, the maps and the agenda with 403 feature_off, and again once they are back on", async () => {
      const ev = await fixture.newEvent({ phase: "live" });
      const joined = await fixture.newPlayer();
      await fixture.join(ev, joined);
      const who = { id: joined, token: await bearer(joined) };
      const doors = ["shop", "maps", "sessions"] as const;
      for (const door of doors) {
        expect((await asPlayer("GET", eventUrl(door, ev), who)).statusCode, door).toBe(200);
      }
      for (const feature of ["shop", "maps", "agenda"]) {
        await team("PUT", `${base(ev)}/features/${feature}`, { enabled: false });
      }
      for (const door of doors) {
        expect(codeOf(await asPlayer("GET", eventUrl(door, ev), who)), door).toEqual([
          403,
          "feature_off",
        ]);
      }
      expect(codeOf(await asPlayer("PUT", eventUrl("goal", ev), who, { rewardId: null }))).toEqual([
        403,
        "feature_off",
      ]);
      for (const feature of ["shop", "maps", "agenda"]) {
        await team("PUT", `${base(ev)}/features/${feature}`, { enabled: true });
      }
      for (const door of doors) {
        expect((await asPlayer("GET", eventUrl(door, ev), who)).statusCode, door).toBe(200);
      }
    });

    it("keeps the team's own pages: maps, sessions and rewards still list for the owner", async () => {
      const ev = await fixture.newEvent({ phase: "live" });
      for (const feature of ["shop", "maps", "agenda"]) {
        await team("PUT", `${base(ev)}/features/${feature}`, { enabled: false });
      }
      for (const page of ["maps", "sessions", "rewards"]) {
        expect((await team("GET", `${base(ev)}/${page}`)).statusCode, page).toBe(200);
      }
    });

    it("lets a non-member see nothing: the doors answer a stranger as they always did", async () => {
      const outsider = await fixture.newPlayer();
      const who = { id: outsider, token: await bearer(outsider) };
      for (const door of ["shop", "maps", "sessions"]) {
        const refused = await asPlayer("GET", eventUrl(door, event), who);
        expect(refused.statusCode, door).toBeGreaterThanOrEqual(400);
      }
      expect((await asPlayer("GET", eventUrl("maps", event), null)).statusCode).toBe(401);
    });

    it("tells a member that the switches are on by default", async () => {
      const config = await composed();
      for (const feature of ["shop", "polls", "maps", "agenda"]) {
        expect(config.features[feature]?.enabled, feature).toBe(true);
      }
    });
  });
});
