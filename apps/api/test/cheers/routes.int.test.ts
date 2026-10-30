import { createHash, randomBytes, randomUUID } from "node:crypto";
import { CHEERS_PER_MINUTE } from "@questify/shared";
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

/**
 * Cheers over HTTP (T-509, ADR-377): the owner's switch, start and stop, the player's cheer with its limit, and the live
 * read that tells the app when to show its button, each from every seat that must be refused.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("cheers over HTTP", () => {
  let fixture: PushFixture;
  let test: TestApp;
  let owner: string;
  let editor: string;
  let other: string;

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
      const email = name + "@cheers.test";
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
  });
  afterAll(async () => {
    await test.close();
    await fixture.close();
  });

  /** A live event with the big-screen add-on. */
  const newEvent = async (addon = true): Promise<string> => {
    const event = await fixture.newEvent({ phase: "live" });
    if (addon) {
      await fixture.owner(
        "INSERT INTO event_entitlement (event_id, organizer_id, feature) VALUES ($1, $2, 'bigScreen')",
        [event, fixture.ids.orgA],
      );
    }
    return event;
  };
  const base = (event: string) => "/v1/organizers/" + fixture.ids.orgA + "/events/" + event;
  const team = (method: "GET" | "POST" | "PUT", url: string, payload?: object, session = owner) =>
    test.app.inject({
      method,
      url,
      headers: withSession(session, { "idempotency-key": randomUUID() }),
      ...(payload === undefined ? {} : { payload }),
    });
  const member = async (event: string): Promise<Player> => {
    const id = await fixture.newPlayer();
    await fixture.join(event, id);
    return { id, token: await bearer(id) };
  };
  const asPlayer = (method: "GET" | "POST", url: string, player: Player | null, payload?: object) =>
    test.app.inject({
      method,
      url,
      ...(player === null ? {} : { headers: { authorization: "Bearer " + player.token } }),
      ...(payload === undefined ? {} : { payload }),
    });
  const cheer = (event: string, player: Player | null, reaction: unknown = "heart") =>
    asPlayer("POST", "/v1/events/" + event + "/cheers", player, { reaction });
  const live = (event: string, player: Player) =>
    asPlayer("GET", "/v1/events/" + event + "/live", player);

  describe("the owner's side", () => {
    it("reads, starts and stops a moment for the owner, and only reads for an editor", async () => {
      const event = await newEvent();
      const first = await team("GET", base(event) + "/cheers");
      expect(first.headers["cache-control"]).toContain("no-store");
      expect(first.json()).toEqual({ enabled: true, switch: true, platformOn: true, live: null });
      expect((await team("GET", base(event) + "/cheers", undefined, editor)).statusCode).toBe(200);
      const started = await team("POST", base(event) + "/cheers/start", { minutes: 5 });
      expect(started.statusCode).toBe(200);
      expect(started.json().live).toMatchObject({ endsAt: expect.any(String) });
      expect((await team("POST", base(event) + "/cheers/stop", {})).json().live).toBeNull();
    });

    it("refuses an editor, another tenant, no add-on, bad lengths, extra fields and a switched-off event", async () => {
      const event = await newEvent();
      const start = (payload: object, session = owner) =>
        team("POST", base(event) + "/cheers/start", payload, session);
      expect(codeOf(await start({ minutes: 5 }, editor))).toEqual([403, "owner_only"]);
      expect(codeOf(await team("POST", base(event) + "/cheers/stop", {}, editor))).toEqual([
        403,
        "owner_only",
      ]);
      expect(codeOf(await start({ minutes: 5 }, other))).toEqual([404, "not_found"]);
      expect(codeOf(await team("GET", base(event) + "/cheers", undefined, other))).toEqual([
        404,
        "not_found",
      ]);
      for (const minutes of [0, 31, -3]) {
        expect(codeOf(await start({ minutes })), String(minutes)).toEqual([422, "invalid_cheer"]);
      }
      expect(codeOf(await start({ minutes: 5, extra: 1 }))).toEqual([400, "invalid_request"]);
      expect(codeOf(await start({ minutes: "5" }))).toEqual([400, "invalid_request"]);
      expect(codeOf(await start({}))).toEqual([400, "invalid_request"]);
      expect(
        codeOf(await team("POST", base(await newEvent(false)) + "/cheers/start", { minutes: 5 })),
      ).toEqual([403, "big_screen_off"]);
      expect(
        codeOf(await team("PUT", base(event) + "/cheers", { enabled: false }, editor)),
      ).toEqual([403, "owner_only"]);
      expect((await team("PUT", base(event) + "/cheers", { enabled: false })).json()).toEqual({
        cheers: false,
      });
      expect(codeOf(await start({ minutes: 5 }))).toEqual([409, "cheers_off"]);
      expect((await team("GET", base(event) + "/cheers")).json()).toMatchObject({ switch: false });
      await team("PUT", base(event) + "/cheers", { enabled: true });
      expect((await start({ minutes: 5 })).statusCode).toBe(200);
    });
  });

  describe("the player's side", () => {
    it("takes a cheer only while a moment is live, from a member, and says plainly why not", async () => {
      const event = await newEvent();
      const fan = await member(event);
      expect(codeOf(await cheer(event, fan))).toEqual([409, "cheers_not_live"]);
      await team("POST", base(event) + "/cheers/start", { minutes: 5 });
      const sent = await cheer(event, fan, "fire");
      expect(sent.statusCode).toBe(201);
      expect(sent.json()).toEqual({ sent: true });
      expect(sent.headers["cache-control"]).toContain("no-store");
      expect(codeOf(await cheer(event, fan, "poop"))).toEqual([422, "invalid_cheer"]);
      expect(codeOf(await cheer(event, fan, 7))).toEqual([400, "invalid_request"]);
      expect(
        codeOf(
          await asPlayer("POST", "/v1/events/" + event + "/cheers", fan, {
            reaction: "heart",
            text: "hi",
          }),
        ),
      ).toEqual([400, "invalid_request"]);
      expect(codeOf(await cheer(event, null))[0]).toBe(401);
      const stranger = await member(await newEvent());
      expect(codeOf(await cheer(event, stranger))).toEqual([404, "not_found"]);
      await team("POST", base(event) + "/cheers/stop", {});
      expect(codeOf(await cheer(event, fan))).toEqual([409, "cheers_not_live"]);
    });

    it("answers 429 with Retry-After past the per-minute limit and keeps other players free", async () => {
      const event = await newEvent();
      const fan = await member(event);
      const friend = await member(event);
      await team("POST", base(event) + "/cheers/start", { minutes: 5 });
      for (let sent = 0; sent < CHEERS_PER_MINUTE; sent += 1) {
        expect((await cheer(event, fan)).statusCode).toBe(201);
      }
      const slow = await cheer(event, fan);
      expect(codeOf(slow)).toEqual([429, "too_many_attempts"]);
      const wait = Number(slow.headers["retry-after"]);
      expect(wait).toBeGreaterThanOrEqual(1);
      expect(wait).toBeLessThanOrEqual(60);
      expect((await cheer(event, friend)).statusCode).toBe(201);
    });
  });

  describe("the live read", () => {
    it("tells a member when a moment is live and nobody else", async () => {
      const event = await newEvent();
      const fan = await member(event);
      const stranger = await member(await newEvent());
      await team("POST", base(event) + "/cheers/start", { minutes: 5 });
      const seen = await live(event, fan);
      expect(seen.statusCode).toBe(200);
      expect(seen.json().cheers).toEqual({ endsAt: expect.any(String) });
      expect((await live(event, stranger)).json().cheers).toBeNull();
      await team("POST", base(event) + "/cheers/stop", {});
      expect((await live(event, fan)).json().cheers).toBeNull();
    });

    it("shows nothing before a moment, and the button goes when the switch goes off", async () => {
      const quiet = await newEvent();
      expect((await live(quiet, await member(quiet))).json().cheers).toBeNull();
      const event = await newEvent();
      const fan = await member(event);
      await team("POST", base(event) + "/cheers/start", { minutes: 5 });
      expect((await live(event, fan)).json().cheers).not.toBeNull();
      await team("PUT", base(event) + "/cheers", { enabled: false });
      expect((await live(event, fan)).json().cheers).toBeNull();
      expect(codeOf(await cheer(event, fan))).toEqual([409, "cheers_not_live"]);
    });
  });
});
