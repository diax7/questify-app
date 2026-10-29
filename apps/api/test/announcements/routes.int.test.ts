import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { ANNOUNCEMENT_FIELDS } from "@questify/shared";
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

const GOOD = {
  titleAr: "الغداء جاهز",
  titleEn: "Lunch is ready",
  bodyAr: "الغداء في القاعة",
  bodyEn: "Lunch in the hall",
};
const codeOf = (response: { statusCode: number; json: () => { code?: string } }) => [
  response.statusCode,
  response.json().code,
];

describe.skipIf(TEST_DATABASE_URL === undefined)("announcements over HTTP", () => {
  let fixture: PushFixture;
  let test: TestApp;
  let cookie: string;
  let otherCookie: string;
  let editorCookie: string;
  let limitedCookie: string;
  let viewerCookie: string;
  let event: string;
  let token: string;
  beforeAll(async () => {
    fixture = await pushFixture();
    test = await startApp(fixture.db);
    const staff = async (
      name: string,
      role: string,
      organizer = fixture.ids.orgA,
      limited = false,
    ) => {
      const email = name + "@announcement.test";
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
    otherCookie = await staff("other", "owner", fixture.ids.orgB);
    editorCookie = await staff("editor", "editor");
    limitedCookie = await staff("limited", "editor", fixture.ids.orgA, true);
    await createStaff(fixture.db.owner, { email: "unassigned@announcement.test" });
    viewerCookie = await signInFully(test, "unassigned@announcement.test");
    event = await fixture.newEvent({ phase: "live" });
    const player = await fixture.newPlayer();
    await fixture.join(event, player);
    token = randomBytes(32).toString("base64url");
    await fixture.owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [player, createHash("sha256").update(token).digest()],
    );
  });
  afterAll(async () => {
    await test.close();
    await fixture.close();
  });
  const path = (id = event) =>
    "/v1/organizers/" + fixture.ids.orgA + "/events/" + id + "/announcements";
  const dashboard = (
    method: "GET" | "POST",
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

  it("previews, sends cleaned text once per key, lists and reads it as a member", async () => {
    const preview = await dashboard("GET", path() + "/preview");
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toEqual({ members: 1, phase: "live" });
    expect(preview.headers["cache-control"]).toContain("no-store");
    const key = randomUUID();
    const body = { ...GOOD, titleEn: "  Lunch\n is ready  " };
    const made = await dashboard("POST", path(), body, cookie, key);
    expect(made.statusCode).toBe(201);
    expect(made.json()).toMatchObject({ status: "sent", replayed: false });
    const replay = await dashboard("POST", path(), body, cookie, key);
    expect(replay.statusCode).toBe(201);
    expect(replay.json().id).toBe(made.json().id);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    const rows = (await dashboard("GET", path())).json().announcements;
    expect(rows[0]).toMatchObject({ titleEn: "Lunch is ready", status: "sent", delivering: true });
    const mine = await test.app.inject({
      method: "GET",
      url: "/v1/events/" + event + "/announcements?size=3",
      headers: { authorization: "Bearer " + token },
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().announcements[0]).toMatchObject({
      id: made.json().id,
      title: { en: "Lunch is ready" },
    });
    expect(mine.headers["cache-control"]).toContain("no-store");
  });

  it("schedules and cancels through the editor seat, and refuses a sent row", async () => {
    const scheduled = await dashboard(
      "POST",
      path(),
      { ...GOOD, sendAt: new Date(Date.now() + 600_000).toISOString() },
      editorCookie,
    );
    expect(scheduled.statusCode).toBe(201);
    expect(scheduled.json().status).toBe("scheduled");
    const cancelPath = path() + "/" + scheduled.json().id + "/cancel";
    expect((await dashboard("POST", cancelPath, {}, editorCookie)).json()).toEqual({
      status: "cancelled",
    });
    expect((await dashboard("POST", cancelPath, {})).json()).toEqual({ status: "cancelled" });
    const rows = (await dashboard("GET", path())).json().announcements as {
      id: string;
      status: string;
    }[];
    const sent = rows.find((row) => row.status === "sent");
    expect(codeOf(await dashboard("POST", path() + "/" + sent?.id + "/cancel", {}))).toEqual([
      409,
      "announcement_already_sent",
    ]);
  });

  it("paginates 31 valid pending schedules earliest first and cancels on either page", async () => {
    const target = await fixture.newEvent({ phase: "live" });
    await fixture.owner("UPDATE event SET ends_at = now() + interval '60 days' WHERE id = $1", [
      target,
    ]);
    const ids: string[] = [];
    for (let day = 1; day <= 31; day += 1) {
      const response = await dashboard("POST", path(target), {
        ...GOOD,
        sendAt: new Date(Date.now() + day * 86400_000).toISOString(),
      });
      expect(response.statusCode).toBe(201);
      ids.push(response.json().id);
    }
    const first = (await dashboard("GET", path(target) + "?pending=true")).json();
    expect(first.announcements.map((row: { id: string }) => row.id)).toEqual(ids.slice(0, 30));
    expect(first.next).toEqual({ afterAt: first.announcements[29].sendAt, afterId: ids[29] });
    const secondPath = path(target) + "?pending=true&" + new URLSearchParams(first.next).toString();
    expect((await dashboard("POST", path(target) + "/" + ids[0] + "/cancel", {})).json()).toEqual({
      status: "cancelled",
    });
    const second = (await dashboard("GET", secondPath)).json();
    expect(second.announcements.map((row: { id: string }) => row.id)).toEqual([ids[30]]);
    expect(second.next).toBeNull();
    expect((await dashboard("POST", path(target) + "/" + ids[30] + "/cancel", {})).json()).toEqual({
      status: "cancelled",
    });
    expect((await dashboard("GET", secondPath)).json()).toEqual({ announcements: [], next: null });
    expect((await dashboard("GET", path(target))).json().announcements).toHaveLength(2);
  });

  it.each([
    "pending=other",
    "pending=true&afterAt=bad&afterId=bad",
    "pending=true&afterId=" + randomUUID(),
    "afterAt=2026-11-01T00:00:00Z&afterId=" + randomUUID(),
  ])("rejects malformed list cursors: %s", async (query) => {
    expect((await dashboard("GET", path() + "?" + query)).statusCode).toBe(400);
  });

  it.each(ANNOUNCEMENT_FIELDS)(
    "filters every issue on %s with its field and issue",
    async (field) => {
      for (const [text, issue] of [
        ["", "required"],
        ["x".repeat(501), "too_long"],
        ["example.com", "looks_like_address"],
        ["0555555555", "looks_like_phone"],
        ["bad\u0007", "control_characters"],
      ]) {
        const refused = await dashboard("POST", path(), { ...GOOD, [field]: text });
        expect(codeOf(refused)).toEqual([422, "invalid_announcement"]);
        expect(refused.json().details).toEqual({ field, issue });
        expect(refused.body).not.toContain(text === "" ? "never match this" : text);
      }
    },
  );

  it("rejects extra channel fields, absent key, bad time, rate limits and a closed event", async () => {
    expect(codeOf(await dashboard("POST", path(), { ...GOOD, channel: "sms" }))).toEqual([
      422,
      "invalid_announcement",
    ]);
    const missing = await test.app.inject({
      method: "POST",
      url: path(),
      headers: withSession(cookie),
      payload: GOOD,
    });
    expect(codeOf(missing)).toEqual([400, "idempotency_key_required"]);
    expect(
      codeOf(await dashboard("POST", path(), { ...GOOD, sendAt: new Date().toISOString() })),
    ).toEqual([422, "invalid_announcement"]);
    for (let index = 0; index < 2; index += 1)
      expect((await dashboard("POST", path(), GOOD)).statusCode).toBe(201);
    const capped = await dashboard("POST", path(), GOOD);
    expect(codeOf(capped)).toEqual([429, "announcement_limit"]);
    expect(capped.json().details).toEqual({ window: "hour" });
    const ended = await fixture.newEvent({ phase: "ended" });
    expect(codeOf(await dashboard("POST", path(ended), GOOD))).toEqual([
      409,
      "announcement_event_closed",
    ]);
    const empty = await fixture.newEvent({ phase: "live" });
    expect(codeOf(await dashboard("POST", path(empty), GOOD))).toEqual([
      409,
      "announcement_nobody",
    ]);
  });

  it("writes nothing and reports unavailable when its kind cannot be written", async () => {
    const fresh = await fixture.newEvent({ phase: "live" });
    await fixture.join(fresh, await fixture.newPlayer());
    await fixture.withoutKind("announcement", async () => {
      expect(codeOf(await dashboard("POST", path(fresh), GOOD))).toEqual([
        503,
        "announcement_unavailable",
      ]);
      expect(await fixture.count("announcement WHERE event_id = $1", [fresh])).toBe(0);
    });
  });

  it("reauthorizes a revoked editor scope before replaying cached send and cancel replies", async () => {
    const fresh = await fixture.newEvent({ phase: "live" });
    const key = randomUUID();
    const body = { ...GOOD, sendAt: new Date(Date.now() + 600_000).toISOString() };
    const made = await dashboard("POST", path(fresh), body, editorCookie, key);
    expect(made.statusCode).toBe(201);
    const cancelKey = randomUUID();
    const cancelled = path(fresh) + "/" + made.json().id + "/cancel";
    expect((await dashboard("POST", cancelled, {}, editorCookie, cancelKey)).statusCode).toBe(200);
    await fixture.owner(
      "UPDATE organizer_member SET event_scope = $1 WHERE staff_user_id = (SELECT id FROM staff_user WHERE email = 'editor@announcement.test')",
      [[fixture.ids.eventA]],
    );
    expect((await dashboard("POST", path(fresh), body, editorCookie, key)).statusCode).toBe(404);
    expect((await dashboard("POST", cancelled, {}, editorCookie, cancelKey)).statusCode).toBe(404);
    const cursor = new URLSearchParams({
      pending: "true",
      afterAt: body.sendAt,
      afterId: made.json().id,
    });
    expect(
      (await dashboard("GET", path(fresh) + "?" + cursor, undefined, editorCookie)).statusCode,
    ).toBe(404);
  });

  it("refuses foreign, event-limited, viewer, player and public seats on every door", async () => {
    for (const session of [otherCookie, limitedCookie, viewerCookie]) {
      for (const suffix of [
        "",
        "/preview",
        "?pending=true",
        "?pending=true&afterAt=2026-11-01T00:00:00Z&afterId=" + randomUUID(),
      ])
        expect((await dashboard("GET", path() + suffix, undefined, session)).statusCode).toBe(404);
      expect((await dashboard("POST", path(), GOOD, session)).statusCode).toBe(404);
      expect(
        (await dashboard("POST", path() + "/" + randomUUID() + "/cancel", {}, session)).statusCode,
      ).toBe(404);
    }
    for (const headers of [{}, { authorization: "Bearer " + token }]) {
      expect((await test.app.inject({ method: "GET", url: path(), headers })).statusCode).toBe(401);
    }
    const other = await fixture.newEvent({ phase: "live" });
    const stranger = await test.app.inject({
      method: "GET",
      url: "/v1/events/" + other + "/announcements",
      headers: { authorization: "Bearer " + token },
    });
    expect(codeOf(stranger)).toEqual([403, "not_enrolled"]);
  });
});

it("the announcements module contains no email, SMS or invitation sender", () => {
  for (const file of readdirSync("apps/api/src/announcements")) {
    expect(readFileSync("apps/api/src/announcements/" + file, "utf8")).not.toMatch(
      /sms|smtp|gmail|msegat|invitation|outbound|sendEmail/i,
    );
  }
});
