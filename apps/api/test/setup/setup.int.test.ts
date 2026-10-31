import { randomUUID } from "node:crypto";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

const FRESH = {
  currentStep: 1,
  steps: Array.from({ length: 10 }, () => "open"),
  finished: false,
};

/**
 * Guided setup progress over HTTP (T-605, FR-1754): a never-opened setup starts at step 1; a save is read back as the
 * same step and the same marks (resume); the last save wins; a body that is not ten known states and a step from 1 to
 * 10 is refused and writes nothing; an editor outside their event limit, another organizer's owner and a signed-out
 * caller reach nothing.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("guided setup over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let organizer = "";
  let otherOrganizer = "";
  let ownerCookie = "";
  let strangerCookie = "";
  let counter = 0;

  const owner = async <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const call = (
    method: "GET" | "PUT",
    event: string,
    payload?: unknown,
    options: Readonly<{ cookie?: string; organizerId?: string }> = {},
  ): Promise<LightMyRequestResponse> =>
    test.app.inject({
      method,
      url: `/v1/organizers/${options.organizerId ?? organizer}/events/${event}/setup`,
      headers: withSession(options.cookie ?? ownerCookie),
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const newEvent = async () => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Setup Fest', 'draft', now() + interval '1 day', now() + interval '2 days') RETURNING id`,
      [organizer, `WIZ${counter}`],
    );
    return event?.id ?? "";
  };
  const rowsOf = (event: string) =>
    owner<{ steps: string; current_step: number; finished_at: Date | null }>(
      "SELECT steps, current_step, finished_at FROM event_setup WHERE event_id = $1",
      [event],
    );
  const progress = (currentStep: number, marks: Record<number, string>, finished = false) => ({
    currentStep,
    steps: FRESH.steps.map((state, index) => marks[index + 1] ?? state),
    finished,
  });
  const member = async (email: string, organizerId: string, role: string, scope?: string[]) => {
    const staff = await createStaff(db.owner, { email });
    await owner(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role, event_scope) VALUES ($1, $2, $3, $4)",
      [organizerId, staff, role, scope ?? null],
    );
    return signInFully(test, email);
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
    const [made] = await owner<{ id: string }>(
      "INSERT INTO organizer (name, slug) VALUES ('setup', 'setup') RETURNING id",
    );
    organizer = made?.id ?? "";
    const [other] = await owner<{ id: string }>(
      "INSERT INTO organizer (name, slug) VALUES ('other', 'other-setup') RETURNING id",
    );
    otherOrganizer = other?.id ?? "";
    ownerCookie = await member("owner@setup.test", organizer, "owner");
    strangerCookie = await member("stranger@setup.test", otherOrganizer, "owner");
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  it("starts a never-opened setup at step 1 with nothing decided and writes nothing", async () => {
    const event = await newEvent();
    const read = await call("GET", event);
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({ setup: { ...FRESH, updatedAt: null } });
    expect(await rowsOf(event)).toHaveLength(0);
  });

  it("returns the saved step and marks on the next read, so setup resumes", async () => {
    const event = await newEvent();
    const saved = progress(6, { 1: "done", 2: "skipped", 3: "done", 4: "skipped", 5: "done" });
    const put = await call("PUT", event, saved);
    expect(put.statusCode, put.body).toBe(200);
    const read = (await call("GET", event)).json<{ setup: Record<string, unknown> }>().setup;
    expect(read).toMatchObject(saved);
    expect(read["updatedAt"]).toEqual(expect.any(String));
    expect(await rowsOf(event)).toMatchObject([{ steps: "dsdsdnnnnn", current_step: 6 }]);
  });

  it("answers the same state to the same save twice", async () => {
    const event = await newEvent();
    const saved = progress(3, { 1: "done", 2: "done" });
    const first = (await call("PUT", event, saved)).json<{ setup: object }>().setup;
    const second = (await call("PUT", event, saved)).json<{ setup: object }>().setup;
    expect(first).toMatchObject(saved);
    expect(second).toMatchObject(saved);
    expect(await rowsOf(event)).toHaveLength(1);
  });

  it("keeps the last save when two are made", async () => {
    const event = await newEvent();
    await call("PUT", event, progress(4, { 1: "done" }));
    await call("PUT", event, progress(2, { 2: "skipped" }));
    const read = (await call("GET", event)).json<{ setup: object }>().setup;
    expect(read).toMatchObject(progress(2, { 2: "skipped" }));
  });

  it("keeps the first finish time while finished and clears it on a re-run", async () => {
    const event = await newEvent();
    await call("PUT", event, progress(10, { 10: "done" }, true));
    const [first] = await rowsOf(event);
    expect(first?.finished_at).toBeInstanceOf(Date);
    await call("PUT", event, progress(10, { 10: "done", 1: "done" }, true));
    const [again] = await rowsOf(event);
    expect(again?.finished_at?.getTime()).toBe(first?.finished_at?.getTime());
    const rerun = (await call("PUT", event, progress(1, { 10: "done" }, false))).json<{
      setup: { finished: boolean; currentStep: number };
    }>().setup;
    expect(rerun).toMatchObject({ finished: false, currentStep: 1 });
    const [cleared] = await rowsOf(event);
    expect(cleared?.finished_at).toBeNull();
  });

  it.each([
    ["too few steps", { ...FRESH, steps: ["open"] }],
    ["too many steps", { ...FRESH, steps: [...FRESH.steps, "open"] }],
    ["an unknown state", { ...FRESH, steps: [...FRESH.steps.slice(1), "maybe"] }],
    ["step 0", { ...FRESH, currentStep: 0 }],
    ["step 11", { ...FRESH, currentStep: 11 }],
    ["a fraction", { ...FRESH, currentStep: 1.5 }],
    ["an extra field", { ...FRESH, note: "x" }],
    ["a missing field", { currentStep: 1, steps: FRESH.steps }],
    ["finished as text", { ...FRESH, finished: "yes" }],
    ["no body", undefined],
  ])("refuses %s and writes nothing", async (_name, body) => {
    const event = await newEvent();
    const put = await call("PUT", event, body);
    expect(put.statusCode, put.body).toBe(400);
    expect(await rowsOf(event)).toHaveLength(0);
  });

  it("answers not found for an event that does not exist and bad request for a bad id", async () => {
    expect((await call("GET", randomUUID())).statusCode).toBe(404);
    expect((await call("PUT", randomUUID(), FRESH)).statusCode).toBe(404);
    expect((await call("GET", "not-an-id")).statusCode).toBe(400);
  });

  it("shows an organizer's event to nobody outside that organizer", async () => {
    const event = await newEvent();
    await call("PUT", event, progress(5, { 1: "done" }));
    expect((await call("GET", event, undefined, { cookie: strangerCookie })).statusCode).toBe(404);
    expect((await call("PUT", event, FRESH, { cookie: strangerCookie })).statusCode).toBe(404);
    const ownPath = { cookie: strangerCookie, organizerId: otherOrganizer };
    expect((await call("GET", event, undefined, ownPath)).statusCode).toBe(404);
    expect((await call("PUT", event, FRESH, ownPath)).statusCode).toBe(404);
    expect(await rowsOf(event)).toMatchObject([{ steps: "dnnnnnnnnn", current_step: 5 }]);
  });

  it("lets an editor inside their event limit run setup and keeps one outside it out", async () => {
    const inside = await newEvent();
    const outside = await newEvent();
    const editor = await member("editor@setup.test", organizer, "editor", [inside]);
    const saved = await call("PUT", inside, progress(2, { 1: "done" }), { cookie: editor });
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await call("GET", inside, undefined, { cookie: editor })).statusCode).toBe(200);
    expect((await call("GET", outside, undefined, { cookie: editor })).statusCode).toBe(404);
    expect((await call("PUT", outside, FRESH, { cookie: editor })).statusCode).toBe(404);
    expect(await rowsOf(outside)).toHaveLength(0);
  });

  it("refuses a caller who is not signed in", async () => {
    const event = await newEvent();
    const url = `/v1/organizers/${organizer}/events/${event}/setup`;
    expect((await test.app.inject({ method: "GET", url })).statusCode).toBe(401);
    const signedOut = { method: "PUT", url, payload: FRESH, headers: withSession("") } as const;
    expect((await test.app.inject(signedOut)).statusCode).toBe(401);
    const noOrigin = { method: "PUT", url, payload: FRESH } as const;
    expect((await test.app.inject(noOrigin)).statusCode).toBe(403);
    expect(await rowsOf(event)).toHaveLength(0);
  });
});
