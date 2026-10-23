import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Row = Record<string, unknown>;

/** The event team's join requests over HTTP (T-218): list, accept, decline and accept all, for owners and editors. */
describe.skipIf(TEST_DATABASE_URL === undefined)("join requests over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let organizer: string;
  let otherOrganizer: string;
  let ownerCookie: string;
  let editorCookie: string;
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
    const made = async (name: string) =>
      (
        await db.owner.query<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ($1, $1) RETURNING id",
          [name],
        )
      ).rows[0]?.id ?? "";
    organizer = await made("req-org");
    otherOrganizer = await made("req-other");
    const ownerId = await createStaff(db.owner, { email: "owner@req.test" });
    const editorId = await createStaff(db.owner, { email: "editor@req.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'editor')",
      [organizer, ownerId, editorId],
    );
    ownerCookie = await signInFully(test, "owner@req.test");
    editorCookie = await signInFully(test, "editor@req.test");
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  const newEvent = async (org = organizer, limit: number | null = null): Promise<string> => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, access, starts_at, ends_at, player_limit_mode,
                          player_limit)
       VALUES ($1, $2, 'Req Fest', 'live', 'private', now() - interval '1 hour', now() + interval '1 day', $3, $4)
       RETURNING id`,
      [org, `REQ${counter}`, limit === null ? "none" : "hard", limit],
    );
    return event?.id ?? "";
  };

  const newRequest = async (event: string, status = "pending"): Promise<string> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`req_${counter}`],
    );
    const [enrollment] = await owner<{ id: string }>(
      `INSERT INTO enrollment (organizer_id, event_id, player_id, status)
       SELECT organizer_id, id, $2, $3 FROM event WHERE id = $1 RETURNING id`,
      [event, player?.id, status],
    );
    return enrollment?.id ?? "";
  };

  const call = (method: "GET" | "POST", path: string, cookie = ownerCookie, org = organizer) =>
    test.app.inject({
      method,
      url: `/v1/organizers/${org}${path}`,
      headers: withSession(cookie),
    });

  it("lists the requests page by page for the owner and editors, public profile only", async () => {
    const event = await newEvent();
    const first = await newRequest(event);
    const second = await newRequest(event, "declined");
    await newRequest(event, "active");
    for (const cookie of [ownerCookie, editorCookie]) {
      const page = await call("GET", `/events/${event}/join-requests?limit=1`, cookie);
      expect(page.statusCode).toBe(200);
      const body = page.json<{ requests: Row[]; nextCursor: string | null }>();
      expect(body.requests.map((row) => row["enrollmentId"])).toEqual([first]);
      expect(Object.keys(body.requests[0] ?? {}).toSorted()).toEqual(
        ["avatar", "enrollmentId", "requestedAt", "status", "username", "waitlisted"].toSorted(),
      );
      const next = await call(
        "GET",
        `/events/${event}/join-requests?cursor=${body.nextCursor ?? ""}`,
        cookie,
      );
      expect(next.json<{ requests: Row[] }>().requests.map((row) => row["status"])).toEqual([
        "declined",
      ]);
      expect(next.json<{ requests: Row[] }>().requests[0]?.["enrollmentId"]).toBe(second);
    }
    expect((await call("GET", `/events/${event}/join-requests?cursor=nope`)).statusCode).toBe(400);
  });

  it("accepts and declines, answering the same again, and refuses what is not a request", async () => {
    const event = await newEvent();
    const asked = await newRequest(event);
    const declined = await call(
      "POST",
      `/events/${event}/join-requests/${asked}/decline`,
      editorCookie,
    );
    expect([declined.statusCode, declined.json()]).toEqual([200, { status: "declined" }]);
    expect((await call("POST", `/events/${event}/join-requests/${asked}/decline`)).json()).toEqual({
      status: "declined",
    });
    const accepted = await call("POST", `/events/${event}/join-requests/${asked}/accept`);
    expect([accepted.statusCode, accepted.json()]).toEqual([200, { status: "active" }]);
    const refused = await call("POST", `/events/${event}/join-requests/${asked}/decline`);
    expect([refused.statusCode, refused.json().code]).toEqual([409, "not_a_request"]);
    expect(
      await owner("SELECT action FROM audit_log WHERE target_id = $1 ORDER BY id", [asked]),
    ).toEqual([{ action: "event.join_decline" }, { action: "event.join_accept" }]);
  });

  it("answers event_full at the limit and accepts all while seats are free", async () => {
    const event = await newEvent(organizer, 1);
    const requests = [await newRequest(event), await newRequest(event), await newRequest(event)];
    const all = await call("POST", `/events/${event}/join-requests/accept-all`, editorCookie);
    expect([all.statusCode, all.json()]).toEqual([200, { accepted: 1, remaining: 2 }]);
    const full = await call("POST", `/events/${event}/join-requests/${requests[1]}/accept`);
    expect([full.statusCode, full.json().code]).toEqual([409, "event_full"]);
  });

  it("answers event_over once the event has ended", async () => {
    const event = await newEvent();
    const asked = await newRequest(event);
    await owner("UPDATE event SET ends_at = now() - interval '1 minute' WHERE id = $1", [event]);
    for (const path of [`/join-requests/${asked}/accept`, "/join-requests/accept-all"]) {
      const answer = await call("POST", `/events/${event}${path}`);
      expect([answer.statusCode, answer.json().code]).toEqual([409, "event_over"]);
    }
  });

  it("answers 404 for another organizer's event, an unknown request and a bad id", async () => {
    const theirs = await newEvent(otherOrganizer);
    const asked = await newRequest(theirs);
    expect((await call("GET", `/events/${theirs}/join-requests`)).statusCode).toBe(404);
    expect((await call("POST", `/events/${theirs}/join-requests/${asked}/accept`)).statusCode).toBe(
      404,
    );
    expect((await call("POST", `/events/${theirs}/join-requests/accept-all`)).statusCode).toBe(404);
    const mine = await newEvent();
    expect((await call("POST", `/events/${mine}/join-requests/${asked}/accept`)).statusCode).toBe(
      404,
    );
    expect((await call("POST", `/events/${mine}/join-requests/nope/accept`)).statusCode).toBe(400);
    expect(
      (await call("POST", `/events/${mine}/join-requests/accept-all`, ownerCookie, otherOrganizer))
        .statusCode,
    ).toBe(404);
    expect(await owner("SELECT status FROM enrollment WHERE id = $1", [asked])).toEqual([
      { status: "pending" },
    ]);
  });
});
