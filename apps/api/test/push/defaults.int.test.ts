import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ownPushTopicsSchema, pushTopicsSchema } from "@questify/shared";
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

const ALL_ON = { announcements: true, rank: true, community: true, reminders: true };

const codeOf = (response: { statusCode: number; json: () => { code?: string } }) => [
  response.statusCode,
  response.json().code,
];

/**
 * An event's default notification topics over HTTP (T-510, FR-1836, ADR-379): the owner and an editor read and change
 * them, every other seat is refused, and a player in the event sees the default on their own switches until they choose.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("event topic defaults over HTTP", () => {
  let fixture: PushFixture;
  let test: TestApp;
  let owner: string;
  let editor: string;
  let other: string;

  beforeAll(async () => {
    fixture = await pushFixture();
    test = await startApp(fixture.db);
    const staff = async (name: string, role: string, organizer = fixture.ids.orgA) => {
      const email = name + "@defaults.test";
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

  const path = (event: string) =>
    "/v1/organizers/" + fixture.ids.orgA + "/events/" + event + "/push-defaults";
  const team = (
    method: "GET" | "PUT",
    url: string,
    payload?: object,
    session: string | null = owner,
  ) =>
    test.app.inject({
      method,
      url,
      ...(session === null ? {} : { headers: withSession(session) }),
      ...(payload === undefined ? {} : { payload }),
    });
  const bearer = async (id: string): Promise<string> => {
    const value = randomBytes(32).toString("base64url");
    await fixture.owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [id, createHash("sha256").update(value).digest()],
    );
    return value;
  };

  it("starts with every topic on; the owner and an editor change the ones named, the others kept", async () => {
    const event = await fixture.newEvent({ phase: "live" });
    const first = await team("GET", path(event));
    expect(first.headers["cache-control"]).toBe("private, no-store");
    expect(pushTopicsSchema.parse(first.json())).toEqual(ALL_ON);
    const ownerOff = await team("PUT", path(event), { rank: false });
    expect(ownerOff.headers["cache-control"]).toBe("private, no-store");
    expect(ownerOff.json()).toEqual({ ...ALL_ON, rank: false });
    const editorOff = await team("PUT", path(event), { reminders: false }, editor);
    expect(editorOff.json()).toEqual({ ...ALL_ON, rank: false, reminders: false });
    const back = await team("PUT", path(event), { rank: true });
    expect(back.json()).toEqual({ ...ALL_ON, reminders: false });
    expect((await team("GET", path(event), undefined, editor)).json()).toEqual({
      ...ALL_ON,
      reminders: false,
    });
  });

  it("refuses no sign-in, another organizer, an unknown event and a malformed request", async () => {
    const event = await fixture.newEvent({ phase: "live" });
    expect((await team("GET", path(event), undefined, null)).statusCode).toBe(401);
    // A write without the dashboard's session carries no CSRF token, so it stops there.
    expect((await team("PUT", path(event), { rank: false }, null)).statusCode).toBe(403);
    expect(codeOf(await team("GET", path(event), undefined, other))).toEqual([404, "not_found"]);
    expect(codeOf(await team("PUT", path(event), { rank: false }, other))).toEqual([
      404,
      "not_found",
    ]);
    expect(codeOf(await team("GET", path(randomUUID())))).toEqual([404, "not_found"]);
    expect((await team("GET", path("not-an-event"))).statusCode).toBe(400);
    for (const body of [{}, { offers: false }, { rank: "off" }, { rank: false, extra: 1 }]) {
      expect((await team("PUT", path(event), body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect((await team("GET", path(event))).json()).toEqual(ALL_ON);
  });

  it("refuses a player's token on the team's door", async () => {
    const event = await fixture.newEvent({ phase: "live" });
    const id = await fixture.newPlayer();
    await fixture.join(event, id);
    const token = await bearer(id);
    for (const method of ["GET", "PUT"] as const) {
      const answer = await test.app.inject({
        method,
        url: path(event),
        headers: { authorization: "Bearer " + token },
        ...(method === "PUT" ? { payload: { rank: false } } : {}),
      });
      expect(answer.statusCode, method).toBe(method === "GET" ? 401 : 403);
    }
  });

  it("reaches a player in the event: off until they choose, and their choice stays after a later change", async () => {
    const event = await fixture.newEvent({ phase: "live" });
    const id = await fixture.newPlayer();
    await fixture.join(event, id);
    const token = await bearer(id);
    const mine = (method: "GET" | "PUT", payload?: object) =>
      test.app.inject({
        method,
        url: "/v1/me/push-topics",
        headers: { authorization: "Bearer " + token },
        ...(payload === undefined ? {} : { payload }),
      });
    await team("PUT", path(event), { rank: false, community: false });
    expect(ownPushTopicsSchema.parse((await mine("GET")).json())).toEqual({
      ...ALL_ON,
      rank: false,
      community: false,
      eventOff: ["rank", "community"],
    });
    expect((await mine("PUT", { rank: true })).json()).toEqual({
      ...ALL_ON,
      community: false,
      eventOff: ["community"],
    });
    await team("PUT", path(event), { rank: false });
    expect((await mine("GET")).json()).toEqual({
      ...ALL_ON,
      community: false,
      eventOff: ["community"],
    });
  });
});
