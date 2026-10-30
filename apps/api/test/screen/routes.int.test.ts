import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DASHBOARD_ORIGIN,
  createStaff,
  freshIp,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Row = Record<string, unknown>;
type Response = Readonly<{
  statusCode: number;
  headers: Record<string, unknown>;
  body: string;
  json: <T = Row>() => T;
}>;

const codeOf = (response: Response) => [
  response.statusCode,
  response.json<{ code?: string }>().code,
];
const hoursAhead = (hours: number): string =>
  new Date(Date.now() + hours * 3_600_000).toISOString();
const cookieOf = (response: Response): string => {
  const header = response.headers["set-cookie"];
  return String(Array.isArray(header) ? header[0] : header).split(";")[0] ?? "";
};

/**
 * The big screen over HTTP (T-504): a paired screen reads its scenes (and a station, a pending device, a revoked one,
 * a player and a staff cookie cannot), the rate limit, and the team's Big screen page (read, save, every refusal).
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("big screen over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let organizer = "";
  let ownerCookie = "";
  let otherCookie = "";
  let editorCookie = "";
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db, undefined, {});
    const made = async (slug: string, email: string) => {
      const org =
        (
          await db.owner.query<{ id: string }>(
            "INSERT INTO organizer (name, slug) VALUES ($1, $1) RETURNING id",
            [slug],
          )
        ).rows[0]?.id ?? "";
      const id = await createStaff(db.owner, { email });
      await db.owner.query(
        "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
        [org, id],
      );
      return org;
    };
    organizer = await made("screen-org", "owner@screen.test");
    await made("other-org", "other@screen.test");
    ownerCookie = await signInFully(test, "owner@screen.test");
    otherCookie = await signInFully(test, "other@screen.test");
    const editor = await createStaff(db.owner, { email: "editor@screen.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'editor')",
      [organizer, editor],
    );
    editorCookie = await signInFully(test, "editor@screen.test");
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const newEvent = async (addon = true): Promise<string> => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Hall Fest', 'live', now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
      [organizer, `SCR${counter}`],
    );
    if (addon) {
      await owner(
        "INSERT INTO event_entitlement (event_id, organizer_id, feature) VALUES ($1, $2, 'bigScreen')",
        [event?.id, organizer],
      );
    }
    return event?.id ?? "";
  };
  const scored = async (event: string, points: number): Promise<void> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username, avatar) VALUES ($1, 'owl') RETURNING id",
      [`screen_p_${counter}`],
    );
    await owner("INSERT INTO player_contact (player_id, email) VALUES ($1, $2)", [
      player?.id,
      `sp${counter}@najd.sa`,
    ]);
    const [enrollment] = await owner<{ id: string }>(
      "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3) RETURNING id",
      [organizer, event, player?.id],
    );
    await owner(
      `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor,
                                 staff_user_id)
       SELECT $1, $2, $3, 'award', $4, $4, 'staff', staff_user_id FROM organizer_member WHERE organizer_id = $1 LIMIT 1`,
      [organizer, event, enrollment?.id, points],
    );
  };
  const pair = (kind: string) =>
    test.app.inject({
      method: "POST",
      url: "/v1/device/pairing",
      headers: { origin: DASHBOARD_ORIGIN, "x-forwarded-for": freshIp() },
      payload: { kind },
    }) as Promise<Response>;
  const device = (method: "GET" | "POST", url: string, cookie: string, payload?: object) =>
    test.app.inject({
      method,
      url,
      headers: { cookie, origin: DASHBOARD_ORIGIN },
      ...(payload === undefined ? {} : { payload }),
    }) as Promise<Response>;
  const dashboard = (
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    payload?: object,
    cookie = ownerCookie,
    headers: Record<string, string> = { "idempotency-key": randomUUID() },
  ) =>
    test.app.inject({
      method,
      url: `/v1/organizers/${organizer}${path}`,
      headers: withSession(cookie, headers),
      ...(payload === undefined ? {} : { payload }),
    }) as Promise<Response>;
  /** A device of `kind` paired from the dashboard and activated: its current cookie and id. */
  const paired = async (event: string, kind = "screen") => {
    const made = await pair(kind);
    expect(made.statusCode, made.body).toBe(201);
    const page = { cookie: cookieOf(made), code: made.json<{ code: string }>().code };
    let questId: string | null = null;
    if (kind === "station") {
      questId =
        (
          await owner<{ id: string }>(
            `INSERT INTO quest (event_id, category_id, type, title_en, points, verification)
             SELECT $1, id, 'scan_qr', 'Gate', 10, ARRAY['screen_qr'] FROM category WHERE event_id = $1 LIMIT 1
             RETURNING id`,
            [event],
          )
        )[0]?.id ?? null;
    }
    const claimed = await dashboard("POST", `/events/${event}/devices`, {
      code: page.code,
      kind,
      questId,
      label: "Hall TV",
    });
    expect(claimed.statusCode, claimed.body).toBe(201);
    const activated = await device("POST", "/v1/device/activate", page.cookie, {});
    expect(activated.statusCode, activated.body).toBe(200);
    return { cookie: cookieOf(activated), id: claimed.json<{ id: string }>().id };
  };
  const scene = (cookie: string, name: string) =>
    device("GET", `/v1/device/screen/${name}`, cookie);

  describe("a screen reads its scenes", () => {
    it("answers each scene for its own event, never cached", async () => {
      const event = await newEvent();
      await scored(event, 30);
      await scored(event, 50);
      const screen = await paired(event);
      const ranking = await scene(screen.cookie, "ranking");
      expect(ranking.statusCode, ranking.body).toBe(200);
      expect(ranking.headers["cache-control"]).toBe("no-store");
      expect(ranking.json<{ rows: Row[] }>().rows.map((row) => row["score"])).toEqual([50, 30]);
      expect(ranking.json()).toMatchObject({ shut: null });
      expect((await scene(screen.cookie, "community")).json()).toEqual({ shut: null, goal: null });
      expect((await scene(screen.cookie, "poll")).json()).toEqual({ shut: null, poll: null });
      const state = await device("GET", "/v1/device", screen.cookie);
      expect(state.json()).toMatchObject({
        state: "paired",
        kind: "screen",
        shut: null,
        scenes: ["ranking", "community", "poll"],
      });
    });

    it("moves the scene list with a save on the dashboard, within one poll", async () => {
      const event = await newEvent();
      const screen = await paired(event);
      const saved = await dashboard("PUT", `/events/${event}/big-screen`, {
        scenes: ["poll", "ranking"],
      });
      expect(saved.statusCode, saved.body).toBe(200);
      expect((await device("GET", "/v1/device", screen.cookie)).json()).toMatchObject({
        scenes: ["poll", "ranking"],
      });
    });

    it("refuses an unknown scene name", async () => {
      const screen = await paired(await newEvent());
      expect(codeOf(await scene(screen.cookie, "photos"))).toEqual([400, "invalid_request"]);
      expect(codeOf(await scene(screen.cookie, "cheers"))).toEqual([400, "invalid_request"]);
    });

    it("is shut without the add-on", async () => {
      const screen = await paired(await newEvent(false));
      expect((await scene(screen.cookie, "ranking")).json()).toEqual({ shut: "feature_off" });
      expect((await device("GET", "/v1/device", screen.cookie)).json()).toMatchObject({
        shut: "feature_off",
        scenes: null,
      });
    });

    it("answers device_unpaired to a station, a pending device, a stranger and every other credential", async () => {
      const event = await newEvent();
      const station = await paired(event, "station");
      expect(codeOf(await scene(station.cookie, "ranking"))).toEqual([401, "device_unpaired"]);
      const pending = cookieOf(await pair("screen"));
      expect(codeOf(await scene(pending, "ranking"))).toEqual([401, "device_unpaired"]);
      expect(codeOf(await scene("", "ranking"))).toEqual([401, "device_unpaired"]);
      const fake = `__Host-qs_device=${randomBytes(32).toString("base64url")}`;
      expect(codeOf(await scene(fake, "ranking"))).toEqual([401, "device_unpaired"]);
      const staff = await test.app.inject({
        method: "GET",
        url: "/v1/device/screen/ranking",
        headers: withSession(ownerCookie),
      });
      expect(staff.statusCode).toBe(401);
      const token = randomBytes(32).toString("base64url");
      const [player] = await owner<{ id: string }>(
        "INSERT INTO player (username) VALUES ('screen_bearer') RETURNING id",
      );
      await owner(
        "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
        [player?.id, createHash("sha256").update(token).digest()],
      );
      const bearer = await test.app.inject({
        method: "GET",
        url: "/v1/device/screen/ranking",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(bearer.statusCode).toBe(401);
    });

    it("answers device_unpaired at the next read after Revoke", async () => {
      const event = await newEvent();
      const screen = await paired(event);
      expect((await scene(screen.cookie, "ranking")).statusCode).toBe(200);
      const revoked = await dashboard("POST", `/events/${event}/devices/${screen.id}/revoke`, {});
      expect(revoked.statusCode).toBe(204);
      expect(codeOf(await scene(screen.cookie, "ranking"))).toEqual([401, "device_unpaired"]);
    });

    it("holds a screen at 40 reads a minute", async () => {
      const screen = await paired(await newEvent());
      for (let index = 0; index < 40; index += 1) {
        expect((await scene(screen.cookie, "community")).statusCode).toBe(200);
      }
      const held = await scene(screen.cookie, "community");
      expect(codeOf(held)).toEqual([429, "too_many_attempts"]);
      expect(held.headers["retry-after"]).toBeDefined();
    });
  });

  describe("the team's Big screen page", () => {
    it("reads and saves the picked scenes, in order, and audits the save", async () => {
      const event = await newEvent();
      const first = await dashboard("GET", `/events/${event}/big-screen`);
      expect(first.json()).toEqual({
        scenes: ["ranking", "community", "poll"],
        offered: ["ranking", "community", "poll"],
        enabled: true,
      });
      const saved = await dashboard("PUT", `/events/${event}/big-screen`, {
        scenes: ["community", "poll"],
      });
      expect(saved.json()).toMatchObject({ scenes: ["community", "poll"] });
      expect((await dashboard("GET", `/events/${event}/big-screen`)).json()).toMatchObject({
        scenes: ["community", "poll"],
      });
      const audit = await owner(
        "SELECT after FROM audit_log WHERE action = 'big_screen.update' AND event_id = $1",
        [event],
      );
      expect(audit).toEqual([{ after: { scenes: ["community", "poll"] } }]);
    });

    it("refuses an unknown, repeated or too many scenes with invalid_big_screen", async () => {
      const event = await newEvent();
      for (const scenes of [
        ["photos"],
        ["poll", "poll"],
        ["ranking", "community", "poll", "poll"],
      ]) {
        const refused = await dashboard("PUT", `/events/${event}/big-screen`, { scenes });
        expect(refused.statusCode).toBe(422);
        expect(refused.json()).toMatchObject({
          code: "invalid_big_screen",
          details: { field: "scenes" },
        });
      }
      const empty = await dashboard("PUT", `/events/${event}/big-screen`, { scenes: [] });
      expect(empty.statusCode).toBe(200);
      const extra = await dashboard("PUT", `/events/${event}/big-screen`, {
        scenes: ["poll"],
        extra: 1,
      });
      expect(extra.statusCode).toBe(400);
    });

    it("does not offer the ranking while it is off, and refuses a save that names it", async () => {
      const event = await newEvent();
      await owner(
        `UPDATE event SET config = jsonb_set(coalesce(config, '{}'::jsonb), '{features}', '{"ranking": false}')
         WHERE id = $1`,
        [event],
      );
      expect((await dashboard("GET", `/events/${event}/big-screen`)).json()).toMatchObject({
        scenes: ["community", "poll"],
        offered: ["community", "poll"],
      });
      const refused = await dashboard("PUT", `/events/${event}/big-screen`, {
        scenes: ["ranking"],
      });
      expect(refused.json()).toMatchObject({
        code: "invalid_big_screen",
        details: { field: "ranking_off" },
      });
    });

    it("refuses a save without the add-on, and says on the page that it is off", async () => {
      const event = await newEvent(false);
      expect((await dashboard("GET", `/events/${event}/big-screen`)).json()).toMatchObject({
        enabled: false,
      });
      const refused = await dashboard("PUT", `/events/${event}/big-screen`, { scenes: ["poll"] });
      expect(codeOf(refused)).toEqual([403, "big_screen_off"]);
    });

    it("answers another organizer's team and no session as not found or unauthenticated", async () => {
      const event = await newEvent();
      const other = await dashboard("GET", `/events/${event}/big-screen`, undefined, otherCookie);
      expect(other.statusCode).toBe(404);
      const write = await dashboard(
        "PUT",
        `/events/${event}/big-screen`,
        { scenes: ["poll"] },
        otherCookie,
      );
      expect(write.statusCode).toBe(404);
      const none = await test.app.inject({
        method: "GET",
        url: `/v1/organizers/${organizer}/events/${event}/big-screen`,
      });
      expect(none.statusCode).toBe(401);
      expect((await dashboard("GET", `/events/${randomUUID()}/big-screen`)).statusCode).toBe(404);
      expect(await owner("SELECT 1 FROM big_screen WHERE event_id = $1", [event])).toEqual([]);
    });

    it("needs the Origin and an Idempotency-Key on a save", async () => {
      const event = await newEvent();
      const noKey = await dashboard(
        "PUT",
        `/events/${event}/big-screen`,
        { scenes: ["poll"] },
        ownerCookie,
        {},
      );
      expect(noKey.statusCode).toBeGreaterThanOrEqual(400);
      const noOrigin = await test.app.inject({
        method: "PUT",
        url: `/v1/organizers/${organizer}/events/${event}/big-screen`,
        headers: { cookie: ownerCookie, "idempotency-key": randomUUID() },
        payload: { scenes: ["poll"] },
      });
      expect(noOrigin.statusCode).toBe(403);
    });
  });

  const finale = (
    event: string,
    method: "GET" | "PUT" | "DELETE",
    payload?: object,
    cookie = ownerCookie,
  ) => dashboard(method, `/events/${event}/finale`, payload, cookie);

  describe("the live finale", () => {
    it("sets, reads and clears it, and the screen's list and scene follow within one poll", async () => {
      const event = await newEvent();
      const screen = await paired(event);
      const quiet = await paired(await newEvent());
      const empty = await scene(quiet.cookie, "finale");
      expect(empty.statusCode, empty.body).toBe(200);
      expect(empty.headers["cache-control"]).toBe("no-store");
      expect(empty.json()).toMatchObject({ shut: null, finale: null });
      expect(typeof empty.json<{ serverNow: string }>().serverNow).toBe("string");
      expect((await scene(screen.cookie, "ranking")).json()).not.toHaveProperty("serverNow");

      const when = hoursAhead(1);
      const saved = await finale(event, "PUT", { startsAt: when, goalId: null });
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.json()).toMatchObject({
        enabled: true,
        state: "not_ended",
        finale: { started: false, goalId: null, goal: null },
      });
      expect((await finale(event, "GET")).json()).toMatchObject({ finale: { goalId: null } });
      expect((await device("GET", "/v1/device", screen.cookie)).json()).toMatchObject({
        scenes: ["ranking", "community", "poll", "finale"],
      });
      const counting = (await scene(screen.cookie, "finale")).json<{
        shut: string | null;
        finale: { phase: string; startsAt: string };
      }>();
      expect(counting).toMatchObject({ shut: null, finale: { phase: "countdown" } });
      expect(new Date(counting.finale.startsAt).getTime()).toBe(new Date(when).getTime());

      const cleared = await finale(event, "DELETE");
      expect(cleared.statusCode, cleared.body).toBe(200);
      expect(cleared.json()).toMatchObject({ finale: null });
      expect((await device("GET", "/v1/device", screen.cookie)).json()).toMatchObject({
        scenes: ["ranking", "community", "poll"],
      });
    });

    it("refuses a time outside the event's window and a body with anything else in it", async () => {
      const event = await newEvent();
      const early = await finale(event, "PUT", { startsAt: hoursAhead(-1), goalId: null });
      expect(early.statusCode).toBe(422);
      expect(early.json()).toMatchObject({
        code: "invalid_finale",
        details: { field: "startsAt" },
      });
      const goal = await finale(event, "PUT", { startsAt: hoursAhead(1), goalId: randomUUID() });
      expect(goal.json()).toMatchObject({ code: "invalid_finale", details: { field: "goal" } });
      for (const body of [
        { startsAt: "tomorrow", goalId: null },
        { startsAt: hoursAhead(1) },
        { startsAt: hoursAhead(1), goalId: null, extra: 1 },
      ]) {
        expect((await finale(event, "PUT", body)).statusCode).toBe(400);
      }
      expect(await owner("SELECT 1 FROM finale WHERE event_id = $1", [event])).toEqual([]);
    });

    it("refuses a change once the time has come, but clears it", async () => {
      const event = await newEvent();
      await finale(event, "PUT", { startsAt: hoursAhead(1), goalId: null });
      await owner("UPDATE finale SET starts_at = now() - interval '1 minute' WHERE event_id = $1", [
        event,
      ]);
      const refused = await finale(event, "PUT", { startsAt: hoursAhead(2), goalId: null });
      expect(codeOf(refused)).toEqual([409, "finale_started"]);
      expect((await finale(event, "DELETE")).statusCode).toBe(200);
    });

    it("is the owner's to set and clear, any member's to read, and needs the add-on", async () => {
      const event = await newEvent();
      await finale(event, "PUT", { startsAt: hoursAhead(1), goalId: null });
      const write = await finale(
        event,
        "PUT",
        { startsAt: hoursAhead(2), goalId: null },
        editorCookie,
      );
      expect(codeOf(write)).toEqual([403, "owner_only"]);
      expect(codeOf(await finale(event, "DELETE", undefined, editorCookie))).toEqual([
        403,
        "owner_only",
      ]);
      expect((await finale(event, "GET", undefined, editorCookie)).statusCode).toBe(200);
      const bare = await newEvent(false);
      expect(codeOf(await finale(bare, "PUT", { startsAt: hoursAhead(1), goalId: null }))).toEqual([
        403,
        "big_screen_off",
      ]);
    });

    it("answers another organizer's team and no session as not found or unauthenticated", async () => {
      const event = await newEvent();
      const body = { startsAt: hoursAhead(1), goalId: null };
      expect((await finale(event, "GET", undefined, otherCookie)).statusCode).toBe(404);
      expect((await finale(event, "PUT", body, otherCookie)).statusCode).toBe(404);
      expect((await finale(event, "DELETE", undefined, otherCookie)).statusCode).toBe(404);
      const none = await test.app.inject({
        method: "GET",
        url: `/v1/organizers/${organizer}/events/${event}/finale`,
      });
      expect(none.statusCode).toBe(401);
      expect((await finale(randomUUID(), "GET")).statusCode).toBe(404);
      expect(await owner("SELECT 1 FROM finale WHERE event_id = $1", [event])).toEqual([]);
    });

    it("needs an Idempotency-Key to set or clear it", async () => {
      const event = await newEvent();
      for (const method of ["PUT", "DELETE"] as const) {
        const refused = await dashboard(
          method,
          `/events/${event}/finale`,
          method === "PUT" ? { startsAt: hoursAhead(1), goalId: null } : undefined,
          ownerCookie,
          {},
        );
        expect(refused.statusCode, method).toBeGreaterThanOrEqual(400);
      }
    });
  });
});
