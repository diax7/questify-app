import { randomUUID } from "node:crypto";
import { organizerAlertSwitchesSchema } from "@questify/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  browserHeaders,
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

const ALL_ON = {
  activated: true,
  stock_low: true,
  codes_low: true,
  new_flags: true,
  content_unpublished: true,
  support_access: true,
  size_limit: true,
};

/**
 * The calling member's own alert switches over HTTP (T-503, FR-1727): both members of an organizer read and set their
 * own, nobody sets another member's, a member of another organizer and a signed-out caller are refused, and a bad body
 * changes nothing.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("organizer alert switches over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let organizer = "";
  let otherOrganizer = "";
  let ids: Record<string, string> = {};
  const cookies: Record<string, string> = {};

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db, false, {});
    const made = async (slug: string) =>
      (
        await db.owner.query<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ($1, $1) RETURNING id",
          [slug],
        )
      ).rows[0]?.id ?? "";
    organizer = await made("alerts-org");
    otherOrganizer = await made("alerts-other");
    const seats = [
      ["owner", "owner", organizer],
      ["editor", "editor", organizer],
      ["outsider", "owner", otherOrganizer],
    ] as const;
    for (const [name, role, org] of seats) {
      const id = await createStaff(db.owner, { email: `${name}@alerts.test` });
      ids = { ...ids, [name]: id };
      await db.owner.query(
        "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, $3)",
        [org, id, role],
      );
      cookies[name] = await signInFully(test, `${name}@alerts.test`);
    }
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const call = (
    who: string | undefined,
    method: "GET" | "PUT",
    payload?: unknown,
    org = organizer,
  ) =>
    test.app.inject({
      method,
      url: `/v1/organizers/${org}/alerts/me`,
      headers: who === undefined ? browserHeaders({}) : withSession(cookies[who] ?? "", {}),
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  it("gives each member their own switches, all on to begin with", async () => {
    for (const who of ["owner", "editor"]) {
      const read = await call(who, "GET");
      expect(read.statusCode).toBe(200);
      expect(organizerAlertSwitchesSchema.parse(read.json())).toEqual(ALL_ON);
    }
  });

  it("saves the member's own switches, answers them as stored, and leaves the others alone", async () => {
    const body = { ...ALL_ON, new_flags: false, size_limit: false };
    const set = await call("editor", "PUT", body);
    expect(set.statusCode).toBe(200);
    expect(set.json()).toEqual(body);
    expect((await call("editor", "PUT", body)).json()).toEqual(body);
    expect((await call("editor", "GET")).json()).toEqual(body);
    expect((await call("owner", "GET")).json()).toEqual(ALL_ON);
    const audits = await db.owner.query(
      "SELECT 1 FROM audit_log WHERE organizer_id = $1 AND action = 'organizer.alerts_set' AND actor_id = $2",
      [organizer, ids["editor"]],
    );
    expect(audits.rowCount).toBe(1);
    await call("editor", "PUT", ALL_ON);
  });

  it("takes no member id: another member's switches have no route", async () => {
    const set = await test.app.inject({
      method: "PUT",
      url: `/v1/organizers/${organizer}/alerts/${ids["editor"]}`,
      headers: withSession(cookies["owner"] ?? "", {}),
      payload: { ...ALL_ON, activated: false },
    });
    expect(set.statusCode).toBe(404);
    expect((await call("editor", "GET")).json()).toEqual(ALL_ON);
    // A staff id in the body is an unknown key, not a way to act for someone else.
    const spoof = await call("owner", "PUT", { ...ALL_ON, staffUserId: ids["editor"] });
    expect(spoof.statusCode).toBe(400);
    expect(spoof.json()["code"]).toBe("invalid_request");
  });

  it("refuses a body that is not exactly the seven booleans, and changes nothing", async () => {
    const { activated: _dropped, ...partial } = ALL_ON;
    for (const body of [
      partial,
      { ...ALL_ON, activated: "yes" },
      { ...ALL_ON, extra: true },
      {},
      [true],
    ]) {
      const refused = await call("owner", "PUT", body);
      expect(refused.statusCode, JSON.stringify(body)).toBe(400);
      expect(refused.json()["code"]).toBe("invalid_request");
    }
    expect((await call("owner", "GET")).json()).toEqual(ALL_ON);
  });

  it("answers 404 to a member of another organizer, as for an organizer that does not exist", async () => {
    for (const method of ["GET", "PUT"] as const) {
      const other = await call("outsider", method, method === "PUT" ? ALL_ON : undefined);
      const missing = await call(
        "owner",
        method,
        method === "PUT" ? ALL_ON : undefined,
        randomUUID(),
      );
      expect([other.statusCode, other.json()["code"]]).toEqual([404, "not_found"]);
      expect([missing.statusCode, missing.json()["code"]]).toEqual([404, "not_found"]);
    }
  });

  it("answers 401 to a caller who is not signed in", async () => {
    for (const method of ["GET", "PUT"] as const) {
      const response = await call(undefined, method, method === "PUT" ? ALL_ON : undefined);
      expect(response.statusCode).toBe(401);
    }
  });
});
