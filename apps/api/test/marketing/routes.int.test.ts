import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  MARKETING_TEXT_VERSION,
  consentHistorySchema,
  forYouSchema,
  interestsSchema,
  marketingSchema,
  preferencesSchema,
} from "@questify/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuthKeys } from "#src/auth/keys";
import { optOutToken } from "#src/marketing/opt-out";
import {
  createStaff,
  signInFully,
  startApp,
  testConfig,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { questifyFixture, type QuestifyFixture } from "#test/support/questify";
import { TEST_DATABASE_URL } from "#test/support/test-db";

type Method = "GET" | "POST" | "PUT";

/** A consent body for the settings screen, with any field replaced. */
const body = (overrides: object = {}) => ({
  textVersion: MARKETING_TEXT_VERSION,
  method: "settings",
  channels: { sms: true },
  ...overrides,
});

/**
 * Marketing consent, preferences and "For you" over HTTP (T-407): the player's doors with every refusal mapped, staff
 * kept out of player doors, the opt-out link end to end, the interest list, the admin's audited read of a player's
 * consent, and the profile's one-time step flag.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("marketing and preferences over HTTP", () => {
  let f: QuestifyFixture;
  let test: TestApp;
  let adminCookie = "";
  let staffCookie = "";
  const keys = createAuthKeys(testConfig().auth.secret);

  beforeAll(async () => {
    f = await questifyFixture();
    test = await startApp(f.db);
    await createStaff(f.db.owner, { email: "root@marketing.test", admin: true });
    adminCookie = await signInFully(test, "root@marketing.test");
    await createStaff(f.db.owner, { email: "staff@marketing.test" });
    staffCookie = await signInFully(test, "staff@marketing.test");
  });
  afterAll(async () => {
    await test.close();
    await f.close();
  });

  const year = async () =>
    Number(
      (
        await f.owner<{ y: string }>(
          "SELECT extract(year FROM now() AT TIME ZONE 'Asia/Riyadh')::int AS y",
        )
      )[0]?.y,
    );
  /** A player with a session token; `age` is this year minus the birth year. */
  const newSession = async (age = 25) => {
    const player = await f.newPlayer();
    await f.owner("UPDATE player SET birth_year = $2 WHERE id = $1", [
      player,
      (await year()) - age,
    ]);
    const token = randomBytes(32).toString("base64url");
    await f.owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [player, createHash("sha256").update(token).digest()],
    );
    return { player, token };
  };
  const as = (token: string, method: Method, url: string, payload?: object) =>
    test.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload }),
    });

  const consoleGet = (cookie: string | null, player: string) =>
    test.app.inject({
      method: "GET",
      url: `/v1/admin/players/${player}/marketing-consent`,
      headers: cookie === null ? {} : withSession(cookie),
    });

  const optOut = (token: string) =>
    test.app.inject({ method: "POST", url: "/v1/public/marketing/opt-out", payload: { token } });

  describe("consent", () => {
    it("starts off, records a skipped step, then a change, and says so on the profile", async () => {
      const { token } = await newSession();
      const first = marketingSchema.parse((await as(token, "GET", "/v1/me/marketing")).json());
      expect(first).toMatchObject({ asked: false, canOptIn: true });
      expect(Object.values(first.channels).every((channel) => !channel.optedIn)).toBe(true);
      const profile = await as(token, "GET", "/v1/me");
      expect(profile.json().marketing).toEqual({ asked: false, canOptIn: true });

      const skipped = await as(
        token,
        "PUT",
        "/v1/me/marketing",
        body({ method: "signup", channels: { push: false, sms: false, email: false } }),
      );
      expect(skipped.statusCode).toBe(200);
      expect(skipped.headers["cache-control"]).toBe("private, no-store");
      expect(marketingSchema.parse(skipped.json()).asked).toBe(true);
      expect((await as(token, "GET", "/v1/me")).json().marketing).toEqual({
        asked: true,
        canOptIn: true,
      });

      const on = marketingSchema.parse((await as(token, "PUT", "/v1/me/marketing", body())).json());
      expect(on.channels.sms.optedIn).toBe(true);
      expect(on.channels.sms.changedAt).not.toBeNull();
      expect(on.channels.push.optedIn).toBe(false);
    });

    it("refuses outdated wording, a possible minor and a bad body", async () => {
      const { token } = await newSession();
      const outdated = await as(token, "PUT", "/v1/me/marketing", body({ textVersion: "0.1" }));
      expect(outdated.statusCode).toBe(409);
      expect(outdated.json()).toMatchObject({ code: "consent_text_outdated" });
      const minor = await newSession(15);
      const refused = await as(minor.token, "PUT", "/v1/me/marketing", body());
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ code: "consent_age" });
      expect(
        (await as(minor.token, "PUT", "/v1/me/marketing", body({ channels: { sms: false } })))
          .statusCode,
      ).toBe(200);
      expect((await as(minor.token, "GET", "/v1/me")).json().marketing).toEqual({
        asked: true,
        canOptIn: false,
      });
      expect((await as(token, "PUT", "/v1/me/marketing", body({ channels: {} }))).statusCode).toBe(
        400,
      );
    });

    it("saves a turn-off from an app on old wording, so Settings and the skip can never be trapped", async () => {
      const { token } = await newSession();
      await as(token, "PUT", "/v1/me/marketing", body({ channels: { sms: true } }));
      const old = await as(
        token,
        "PUT",
        "/v1/me/marketing",
        body({ textVersion: "0.1", channels: { sms: false } }),
      );
      expect(old.statusCode).toBe(200);
      expect(marketingSchema.parse(old.json()).channels.sms.optedIn).toBe(false);
      const fresh = await newSession();
      const skip = await as(
        fresh.token,
        "PUT",
        "/v1/me/marketing",
        body({
          textVersion: "0.1",
          method: "signup",
          channels: { push: false, sms: false, email: false },
        }),
      );
      expect(skip.statusCode).toBe(200);
      expect(marketingSchema.parse(skip.json()).asked).toBe(true);
      expect((await as(fresh.token, "GET", "/v1/me")).json().marketing.asked).toBe(true);
    });

    it("keeps staff and signed-out callers out of the player doors", async () => {
      for (const [method, url] of [
        ["GET", "/v1/me/marketing"],
        ["PUT", "/v1/me/marketing"],
        ["GET", "/v1/me/preferences"],
        ["PUT", "/v1/me/preferences"],
        ["GET", "/v1/me/for-you"],
      ] as const) {
        const payload = method === "PUT" ? { payload: body() } : {};
        const none = await test.app.inject({ method, url, ...payload });
        expect(none.statusCode, `${method} ${url}`).toBe(401);
        const staff = await test.app.inject({
          method,
          url,
          headers: withSession(staffCookie),
          ...payload,
        });
        expect(staff.statusCode, `${method} ${url}`).toBe(401);
      }
    });
  });

  describe("the opt-out link", () => {
    it("turns the channel off with no sign-in, once and again, and records its method", async () => {
      const { player, token } = await newSession();
      await as(token, "PUT", "/v1/me/marketing", body({ channels: { sms: true, email: true } }));
      const link = optOutToken(keys, { playerId: player, channel: "sms" });
      expect((await optOut(link)).statusCode).toBe(204);
      expect((await optOut(link)).statusCode).toBe(204);
      const state = marketingSchema.parse((await as(token, "GET", "/v1/me/marketing")).json());
      expect(state.channels.sms.optedIn).toBe(false);
      expect(state.channels.email.optedIn).toBe(true);
      const log = await f.owner<{ channel: string; granted: boolean; method: string }>(
        "SELECT channel, granted, method FROM marketing_consent WHERE player_id = $1 ORDER BY id",
        [player],
      );
      expect(log.at(-1)).toEqual({ channel: "sms", granted: false, method: "opt_out_link" });
      expect(log).toHaveLength(3);
    });

    it("answers a stranger's forged token with 400, and an unknown player with 204 like a known one", async () => {
      const forged = optOutToken(createAuthKeys("z".repeat(40)), {
        playerId: randomUUID(),
        channel: "push",
      });
      expect((await optOut(forged)).statusCode).toBe(400);
      expect(
        (await optOut(optOutToken(keys, { playerId: randomUUID(), channel: "push" }))).statusCode,
      ).toBe(204);
    });
  });

  describe("preferences and For you", () => {
    it("lists the interests publicly and saves a player's city and interests", async () => {
      const list = interestsSchema.parse(
        (await test.app.inject({ method: "GET", url: "/v1/interests" })).json(),
      );
      expect(list.interests).toHaveLength(12);
      const { token } = await newSession();
      const saved = await as(token, "PUT", "/v1/me/preferences", {
        cityId: "sa-riyadh",
        interests: ["music", "sport"],
      });
      expect(preferencesSchema.parse(saved.json())).toEqual({
        cityId: "sa-riyadh",
        interests: ["sport", "music"],
      });
      expect(
        preferencesSchema.parse((await as(token, "GET", "/v1/me/preferences")).json()),
      ).toEqual({ cityId: "sa-riyadh", interests: ["sport", "music"] });
      const cleared = await as(token, "PUT", "/v1/me/preferences", { cityId: null, interests: [] });
      expect(preferencesSchema.parse(cleared.json())).toEqual({ cityId: null, interests: [] });
    });

    it("refuses an unknown city or interest in a 422 that names the field", async () => {
      const { token } = await newSession();
      const city = await as(token, "PUT", "/v1/me/preferences", {
        cityId: "sa-nowhere",
        interests: [],
      });
      expect(city.statusCode).toBe(422);
      expect(city.json()).toMatchObject({
        code: "invalid_preferences",
        details: { field: "cityId" },
      });
      const interest = await as(token, "PUT", "/v1/me/preferences", {
        cityId: null,
        interests: ["bogus"],
      });
      expect(interest.json()).toMatchObject({ details: { field: "interests" } });
    });

    it("recommends a matching public event and no private one", async () => {
      const { token } = await newSession();
      const shown = await f.newEvent({ phase: "scheduled", cityId: "sa-yanbu" });
      const hidden = await f.newEvent({
        phase: "scheduled",
        access: "private",
        cityId: "sa-yanbu",
      });
      await f.owner(
        "UPDATE event SET join_methods = '{code,qr,link,public_list}', interests = '{art}' WHERE id = $1",
        [shown],
      );
      await f.owner("UPDATE event SET interests = '{art}' WHERE id = $1", [hidden]);
      await as(token, "PUT", "/v1/me/preferences", { cityId: "sa-yanbu", interests: ["art"] });
      const list = forYouSchema.parse((await as(token, "GET", "/v1/me/for-you")).json());
      expect(list.events.map((event) => event.id)).toEqual([shown]);
      expect(list.events[0]).toMatchObject({ city: { en: "Yanbu" }, interests: ["art"] });
    });
  });

  describe("an admin's read of a player's consent", () => {
    it("shows channels and the dated log to a platform admin, and audits the read", async () => {
      const { player, token } = await newSession();
      await as(token, "PUT", "/v1/me/marketing", body({ method: "signup" }));
      const response = await consoleGet(adminCookie, player);
      expect(response.statusCode).toBe(200);
      const history = consentHistorySchema.parse(response.json());
      expect(history.channels.sms.optedIn).toBe(true);
      expect(history.history).toMatchObject([
        { channel: "sms", granted: true, method: "signup", textVersion: MARKETING_TEXT_VERSION },
      ]);
      const [row] = await f.owner<{ n: string }>(
        "SELECT count(*) AS n FROM audit_log WHERE action = 'marketing.consent_read' AND target_id = $1",
        [player],
      );
      expect(Number(row?.n)).toBe(1);
    });

    it("answers 404 to staff who are not admins and for an unknown player, 401 to nobody signed in", async () => {
      const { player } = await newSession();
      expect((await consoleGet(staffCookie, player)).statusCode).toBe(404);
      expect((await consoleGet(null, player)).statusCode).toBe(401);
      expect((await consoleGet(adminCookie, randomUUID())).statusCode).toBe(404);
      expect((await consoleGet(adminCookie, "not-a-uuid")).statusCode).toBe(400);
    });
  });
});
