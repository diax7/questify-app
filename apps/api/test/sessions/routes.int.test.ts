import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMyCodeKey, myCode } from "#src/quests/qr";
import {
  createStaff,
  signInFully,
  startApp,
  testConfig,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { pushFixture, type PushFixture } from "#test/support/push";
import { TEST_DATABASE_URL } from "#test/support/test-db";

const MY_KEY = createMyCodeKey(testConfig().qrSecret);
const minutes = (count: number): string => new Date(Date.now() + count * 60_000).toISOString();
const codeOf = (response: { statusCode: number; json: () => { code?: string } }) => [
  response.statusCode,
  response.json().code,
];
const talk = (over: Record<string, unknown> = {}) => ({
  kind: "talk",
  titleEn: "Opening",
  titleAr: "الافتتاح",
  startsAt: minutes(120),
  endsAt: minutes(180),
  access: "registration",
  seats: 2,
  ...over,
});
const MESSAGE = {
  titleAr: "تغيير القاعة",
  titleEn: "Room change",
  bodyAr: "انتقلت الورشة إلى القاعة 3.",
  bodyEn: "The workshop moved to hall 3.",
};

describe.skipIf(TEST_DATABASE_URL === undefined)("sessions over HTTP", () => {
  let fixture: PushFixture;
  let test: TestApp;
  let cookie: string;
  let editorCookie: string;
  let otherCookie: string;
  let limitedCookie: string;
  let viewerCookie: string;
  let event: string;
  let player: string;
  let token: string;
  let operatorToken: string;

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
      limited = false,
    ) => {
      const email = name + "@session.test";
      const id = await createStaff(fixture.db.owner, { email });
      await fixture.owner(
        "INSERT INTO organizer_member (organizer_id, staff_user_id, role, event_scope) VALUES ($1, $2, $3, $4)",
        [organizer, id, role, limited ? [fixture.ids.eventA] : null],
      );
      return signInFully(test, email);
    };
    await fixture.owner("UPDATE organizer_member SET role = 'editor' WHERE organizer_id = $1", [
      fixture.ids.orgA,
    ]);
    cookie = await staff("owner", "owner");
    editorCookie = await staff("editor", "editor");
    otherCookie = await staff("other", "owner", fixture.ids.orgB);
    limitedCookie = await staff("limited", "editor", fixture.ids.orgA, true);
    await createStaff(fixture.db.owner, { email: "viewer@session.test" });
    viewerCookie = await signInFully(test, "viewer@session.test");
    event = await fixture.newEvent({ phase: "live" });
    player = await fixture.newPlayer();
    await fixture.join(event, player);
    token = await bearer(player);
    const operator = await fixture.newPlayer();
    await fixture.join(event, operator);
    await fixture.owner(
      "INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities) VALUES ($1, $2, $3, $4)",
      [fixture.ids.orgA, event, operator, ["scan_quests"]],
    );
    operatorToken = await bearer(operator);
  });
  afterAll(async () => {
    await test.close();
    await fixture.close();
  });

  const base = (id = event) => "/v1/organizers/" + fixture.ids.orgA + "/events/" + id + "/sessions";
  const team = (
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    payload?: object,
    session = cookie,
    key = randomUUID(),
  ) =>
    test.app.inject({
      method,
      url,
      headers: withSession(session, { "idempotency-key": key }),
      ...(payload === undefined ? {} : { payload }),
    });
  const asPlayer = (
    method: "GET" | "POST",
    url: string,
    payload?: object,
    bearerToken = token,
    key = randomUUID(),
  ) =>
    test.app.inject({
      method,
      url,
      headers: { authorization: "Bearer " + bearerToken, "idempotency-key": key },
      ...(payload === undefined ? {} : { payload }),
    });
  const agenda = (id = event) => "/v1/events/" + id + "/sessions";
  const add = async (over: Record<string, unknown> = {}, session = cookie) => {
    const made = await team("POST", base(), talk(over), session);
    expect(made.statusCode).toBe(201);
    return made.json<{ id: string }>();
  };

  it("adds, edits, lists with its numbers and deletes a session, and never lets the body set a price", async () => {
    const made = await add({ titleEn: "Keynote" });
    expect(made).toMatchObject({
      titleEn: "Keynote",
      seats: 2,
      registered: 0,
      registrationOpen: true,
    });
    const edited = await team(
      "PUT",
      base() + "/" + made.id,
      talk({ titleEn: "Keynote 2", seats: 3 }),
      editorCookie,
    );
    expect(edited.json()).toMatchObject({ id: made.id, titleEn: "Keynote 2", seats: 3 });
    const listed = await team("GET", base());
    expect(listed.headers["cache-control"]).toContain("no-store");
    expect(listed.json().sessions.map((row: { id: string }) => row.id)).toContain(made.id);
    expect(codeOf(await team("POST", base(), { ...talk(), price: 10 }))).toEqual([
      422,
      "invalid_session",
    ]);
    expect(await team("DELETE", base() + "/" + made.id)).toMatchObject({ statusCode: 200 });
    expect(
      (await team("GET", base())).json().sessions.map((row: { id: string }) => row.id),
    ).not.toContain(made.id);
  });

  it("names the first bad field and reads the database's issue for the rest", async () => {
    const noTitle = await team("POST", base(), talk({ titleEn: null, titleAr: null }));
    expect(codeOf(noTitle)).toEqual([422, "invalid_session"]);
    expect(noTitle.json().details).toEqual({ issue: "title" });
    const backwards = await team(
      "POST",
      base(),
      talk({ startsAt: minutes(60), endsAt: minutes(30) }),
    );
    expect(backwards.json().details).toEqual({ issue: "endsAt:before_start" });
    const badSeats = await team("POST", base(), talk({ seats: 0 }));
    expect(badSeats.json().details).toEqual({ issue: "seats" });
    const control = await team("POST", base(), talk({ titleEn: "bad\u0007" }));
    expect(codeOf(control)).toEqual([422, "invalid_session"]);
    const open = await team("POST", base(), talk({ access: "open", seats: 5 }));
    expect(open.json()).toMatchObject({ access: "open", seats: null, walkIns: false });
  });

  it("registers a player once, warns about an overlap, and keeps seats exact", async () => {
    const first = await add({ titleEn: "Seat test", seats: 1 });
    const seen = await asPlayer("GET", agenda());
    expect(seen.headers["cache-control"]).toContain("no-store");
    expect(seen.json().sessions.find((row: { id: string }) => row.id === first.id)).toMatchObject({
      status: "available",
      seatsLeft: 1,
      registered: false,
    });
    const url = agenda() + "/" + first.id;
    const key = randomUUID();
    const registered = await asPlayer("POST", url + "/register", {}, token, key);
    expect(registered.json()).toMatchObject({ outcome: "registered" });
    const replay = await asPlayer("POST", url + "/register", {}, token, key);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    const clash = await add({
      titleEn: "Clash",
      startsAt: minutes(130),
      endsAt: minutes(170),
      seats: 5,
    });
    const warned = await asPlayer("POST", agenda() + "/" + clash.id + "/register");
    expect(warned.json()).toMatchObject({ outcome: "overlap", overlaps: [{ id: first.id }] });
    const confirmed = await asPlayer("POST", agenda() + "/" + clash.id + "/register", {
      confirmOverlap: true,
    });
    expect(confirmed.json()).toMatchObject({ outcome: "registered" });
    const second = await fixture.newPlayer();
    await fixture.join(event, second);
    const full = await asPlayer("POST", url + "/register", {}, await bearer(second));
    expect(codeOf(full)).toEqual([409, "session_full"]);
    expect((await asPlayer("POST", url + "/cancel", {})).json()).toEqual({ status: "cancelled" });
    const taken = await asPlayer("POST", url + "/register", {}, await bearer(second));
    expect(taken.json()).toMatchObject({ outcome: "registered" });
  });

  it("closes and reopens registration, refuses seats below the registered number, and reports", async () => {
    const made = await add({
      titleEn: "Close test",
      startsAt: minutes(400),
      endsAt: minutes(460),
      seats: 5,
    });
    const url = base() + "/" + made.id + "/registration";
    const closed = await team("PUT", url, { open: false, seats: 5 });
    expect(closed.json()).toMatchObject({ registrationOpen: false });
    const refused = await asPlayer("POST", agenda() + "/" + made.id + "/register", {});
    expect(codeOf(refused)).toEqual([409, "session_closed"]);
    await team("PUT", url, { open: true, seats: 5 });
    expect((await asPlayer("POST", agenda() + "/" + made.id + "/register", {})).statusCode).toBe(
      200,
    );
    expect((await team("PUT", url, { open: true, seats: 1 })).statusCode).toBe(200);
    const row = (await team("GET", base()))
      .json()
      .sessions.find((s: { id: string }) => s.id === made.id);
    expect(row).toMatchObject({ registered: 1, attended: 0, noShows: 0 });
    expect(codeOf(await team("PUT", url, { open: true, seats: 0 }))).toEqual([
      422,
      "invalid_session",
    ]);
  });

  it("imports rows in one transaction and refuses more than 500", async () => {
    const rows = [
      talk({ titleEn: "Import 1" }),
      talk({ titleEn: "Import 2", access: "open", seats: null }),
    ];
    const done = await team("POST", base() + "/import", { rows });
    expect(done.statusCode).toBe(201);
    expect(done.json()).toEqual({ created: 2 });
    const bad = await team("POST", base() + "/import", {
      rows: [talk({ titleEn: "Fine" }), talk({ startsAt: minutes(60), endsAt: minutes(30) })],
    });
    expect(bad.statusCode).toBe(422);
    const many = await team("POST", base() + "/import", {
      rows: Array.from({ length: 501 }, () => talk()),
    });
    expect(codeOf(many)).toEqual([422, "invalid_session"]);
    const titles = (await team("GET", base()))
      .json()
      .sessions.map((row: { titleEn: string }) => row.titleEn);
    expect(titles).not.toContain("Fine");
  });

  it("checks in at the door by My QR and counts the attendance", async () => {
    const made = await add({
      titleEn: "Door test",
      startsAt: minutes(20),
      endsAt: minutes(80),
      seats: 4,
    });
    await asPlayer("POST", agenda() + "/" + made.id + "/register", {});
    const door = (code: string, who = operatorToken) =>
      asPlayer("POST", "/v1/operator/sessions/" + made.id + "/check-in", { code }, who);
    const done = await door(myCode(MY_KEY, player, 1));
    expect(done.headers["cache-control"]).toContain("no-store");
    expect(done.json()).toMatchObject({ result: "checked_in", walkIn: false });
    expect(done.json().player).toHaveProperty("username");
    expect((await door(myCode(MY_KEY, player, 1))).json()).toMatchObject({ result: "already" });
    expect((await door("not-a-code")).json()).toEqual({
      result: "refused",
      reason: "invalid_code",
      player: null,
    });
    expect((await door(myCode(MY_KEY, player, 9))).json()).toMatchObject({
      result: "refused",
      reason: "old_code",
    });
    expect((await door(myCode(MY_KEY, player, 1), token)).statusCode).toBe(403);
    const row = (await team("GET", base()))
      .json()
      .sessions.find((s: { id: string }) => s.id === made.id);
    expect(row).toMatchObject({ registered: 1, attended: 1, noShows: 0 });
    const anonymous = await test.app.inject({
      method: "POST",
      url: "/v1/operator/sessions/" + made.id + "/check-in",
      payload: { code: "x" },
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it("messages registrants once per key and refuses an empty session", async () => {
    const made = await add({
      titleEn: "Message test",
      startsAt: minutes(600),
      endsAt: minutes(660),
      seats: 5,
    });
    const empty = await team("POST", base() + "/" + made.id + "/message", MESSAGE);
    expect(codeOf(empty)).toEqual([409, "session_nobody"]);
    await asPlayer("POST", agenda() + "/" + made.id + "/register", {});
    const key = randomUUID();
    const sent = await team("POST", base() + "/" + made.id + "/message", MESSAGE, cookie, key);
    expect(sent.statusCode).toBe(201);
    expect(sent.json()).toMatchObject({ recipients: 1, replayed: false });
    const again = await team("POST", base() + "/" + made.id + "/message", MESSAGE, cookie, key);
    expect(again.json().id).toBe(sent.json().id);
    const address = await team("POST", base() + "/" + made.id + "/message", {
      ...MESSAGE,
      bodyEn: "example.com",
    });
    expect(codeOf(address)).toEqual([422, "invalid_session"]);
    expect(address.body).not.toContain("example.com");
  });

  it("refuses foreign, event-limited, viewer, player and public seats on every team door", async () => {
    const made = await add({ titleEn: "Guarded" });
    const doors: ["GET" | "POST" | "PUT" | "DELETE", string, object | undefined][] = [
      ["GET", base(), undefined],
      ["POST", base(), talk()],
      ["PUT", base() + "/" + made.id, talk()],
      ["DELETE", base() + "/" + made.id, undefined],
      ["PUT", base() + "/" + made.id + "/registration", { open: false, seats: 1 }],
      ["POST", base() + "/import", { rows: [talk()] }],
      ["POST", base() + "/" + made.id + "/message", MESSAGE],
    ];
    for (const session of [otherCookie, limitedCookie, viewerCookie]) {
      for (const [method, url, payload] of doors) {
        expect((await team(method, url, payload, session)).statusCode, method + " " + url).toBe(
          404,
        );
      }
    }
    for (const headers of [{}, { authorization: "Bearer " + token }]) {
      expect((await test.app.inject({ method: "GET", url: base(), headers })).statusCode).toBe(401);
    }
    const stranger = await fixture.newEvent({ phase: "live" });
    expect(codeOf(await asPlayer("GET", agenda(stranger)))).toEqual([403, "not_enrolled"]);
    expect(
      codeOf(await asPlayer("POST", agenda(stranger) + "/" + made.id + "/register", {})),
    ).toEqual([403, "not_enrolled"]);
    expect((await asPlayer("POST", agenda() + "/" + randomUUID() + "/cancel", {})).statusCode).toBe(
      404,
    );
  });

  it("reauthorizes a revoked editor scope before replaying a stored write", async () => {
    const fresh = await fixture.newEvent({ phase: "live" });
    const key = randomUUID();
    const made = await team("POST", base(fresh), talk(), editorCookie, key);
    expect(made.statusCode).toBe(201);
    await fixture.owner(
      "UPDATE organizer_member SET event_scope = $1 WHERE staff_user_id = (SELECT id FROM staff_user WHERE email = 'editor@session.test')",
      [[fixture.ids.eventA]],
    );
    expect((await team("POST", base(fresh), talk(), editorCookie, key)).statusCode).toBe(404);
  });
});

it("the sessions module sends no email, SMS or invitation and holds no price", () => {
  for (const file of readdirSync("apps/api/src/sessions")) {
    expect(readFileSync("apps/api/src/sessions/" + file, "utf8")).not.toMatch(
      /sms|smtp|gmail|msegat|invitation|outbound|sendEmail|price|payment/i,
    );
  }
});
