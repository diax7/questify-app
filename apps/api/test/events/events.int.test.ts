import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_TERMS } from "@questify/shared";
import { createEvents } from "#src/events/events";
import { startLifecycleTick } from "#src/events/tick";
import {
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type EventView = {
  id: string;
  joinCode: string;
  name: { ar: string | null; en: string | null };
  timezone: string;
  startsAt: string;
  endsAt: string;
  status: string;
  statusNow: string;
};

const DRAFT = {
  name: { ar: "ملتقى نجد", en: "Najd Meetup" },
  timezone: "Asia/Riyadh",
  startsAt: "2030-11-01T09:00",
  endsAt: "2030-11-01T17:00",
};

const termsUrl = (org: string, event: string) => `/v1/organizers/${org}/events/${event}/terms`;

const ownerOf = (org: string) => ({
  organizerId: org,
  staffUserId: "",
  organizer: { id: org, role: "owner" as const, eventScope: null },
});

describe.skipIf(TEST_DATABASE_URL === undefined)("the event builder (T-102)", () => {
  let db: TestDatabase;
  let test: TestApp;
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const owner = <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
    db.owner.query<T>(sql, values).then((result) => result.rows);

  /** A signed-in member of the organizer; an editor may be limited to chosen events. */
  const memberOf = async (
    org: string,
    role: "owner" | "editor",
    eventScope: string[] | null = null,
  ): Promise<string> => {
    counter += 1;
    const email = `${role}${counter}@events.test`;
    const id = await createStaff(db.owner, { email });
    await owner(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role, event_scope) VALUES ($1, $2, $3, $4)",
      [org, id, role, eventScope],
    );
    return signInFully(test, email);
  };

  const newOrganizer = async (): Promise<{ id: string; cookie: string }> => {
    counter += 1;
    const [row] = await owner<{ id: string }>(
      "INSERT INTO organizer (name, slug) VALUES ('Najd Events', $1) RETURNING id",
      [`events-${counter}`],
    );
    const id = row?.id ?? "";
    return { id, cookie: await memberOf(id, "owner") };
  };

  const call = (
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    url: string,
    cookie: string,
    payload?: object,
    headers: Record<string, string> = {},
  ): Promise<LightMyRequestResponse> =>
    test.app.inject({
      method,
      url,
      headers: withSession(cookie, headers),
      ...(payload === undefined ? {} : { payload }),
    });

  const create = (
    org: string,
    cookie: string,
    payload: object = DRAFT,
    key = `k-${Math.random()}`,
  ) => call("POST", `/v1/organizers/${org}/events`, cookie, payload, { "idempotency-key": key });

  const created = async (
    org: string,
    cookie: string,
    payload: object = DRAFT,
  ): Promise<EventView> => {
    const response = await create(org, cookie, payload);
    expect(response.statusCode).toBe(201);
    return response.json<{ event: EventView }>().event;
  };

  const save = (org: string, event: string, cookie: string, payload: object) =>
    call("PUT", termsUrl(org, event), cookie, payload);

  /** Moves an event out of draft the way Questify's activation will (T-210): through the owner connection. */
  const setStatus = (id: string, status: string, startsAt: string, endsAt: string) =>
    owner(
      `UPDATE event SET status = $2, starts_at = now() + $3::interval, ends_at = now() + $4::interval WHERE id = $1`,
      [id, status, startsAt, endsAt],
    );

  const auditOf = (id: string, action: string) =>
    owner<{ before: Record<string, unknown> | null; after: Record<string, unknown> | null }>(
      "SELECT before, after FROM audit_log WHERE event_id = $1 AND action = $2 ORDER BY id",
      [id, action],
    );

  describe("creating", () => {
    it("makes a draft with a join code, reads the times in the event's zone, and audits it", async () => {
      const org = await newOrganizer();
      const event = await created(org.id, org.cookie);
      expect(event).toMatchObject({
        status: "draft",
        statusNow: "draft",
        timezone: "Asia/Riyadh",
        startsAt: "2030-11-01T06:00:00.000Z",
        endsAt: "2030-11-01T14:00:00.000Z",
      });
      expect(event.joinCode).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{6}$/);
      const [entry] = await auditOf(event.id, "event.create");
      expect(entry?.after).toMatchObject({ nameEn: "Najd Meetup", timezone: "Asia/Riyadh" });
    });

    it("replays the first answer to a retried request instead of making a second event", async () => {
      const org = await newOrganizer();
      const first = await create(org.id, org.cookie, DRAFT, "double-click");
      const again = await create(org.id, org.cookie, DRAFT, "double-click");
      expect(again.headers["idempotent-replayed"]).toBe("true");
      expect(again.json()).toEqual(first.json());
      expect(await owner("SELECT 1 FROM event WHERE organizer_id = $1", [org.id])).toHaveLength(1);
    });

    it("needs an Idempotency-Key", async () => {
      const org = await newOrganizer();
      const response = await call("POST", `/v1/organizers/${org.id}/events`, org.cookie, DRAFT);
      expect(response.json()).toMatchObject({ code: "idempotency_key_required" });
    });

    it.each([
      ["a status", { ...DRAFT, status: "live" }],
      ["a join code", { ...DRAFT, joinCode: "AAAAAA" }],
      ["no start", { name: DRAFT.name, endsAt: DRAFT.endsAt }],
      ["a time with an offset", { ...DRAFT, startsAt: "2030-11-01T09:00+03:00" }],
      ["an hour out of range", { ...DRAFT, dayStartHour: 24 }],
    ])("refuses a body with %s", async (_name, payload) => {
      const org = await newOrganizer();
      const response = await create(org.id, org.cookie, payload);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_request" });
    });

    it.each([
      ["name", { ...DRAFT, name: { ar: " ", en: "" } }],
      ["timezone", { ...DRAFT, timezone: "asia/riyadh" }],
      ["startsAt", { ...DRAFT, startsAt: "2030-02-30T09:00" }],
      ["endsAt", { ...DRAFT, endsAt: "2030-11-01T09:00" }],
      ["joinMethods", { ...DRAFT, access: "private", joinMethods: ["public_list"] }],
      ["joinMethods", { ...DRAFT, joinMethods: [] }],
    ])("answers 422 naming the field %s", async (field, payload) => {
      const org = await newOrganizer();
      const response = await create(org.id, org.cookie, payload);
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({
        code: "invalid_event",
        details: { field },
      });
    });

    it("refuses an editor limited to chosen events, and lets an unlimited editor create", async () => {
      const org = await newOrganizer();
      const mine = await created(org.id, org.cookie);
      const limited = await memberOf(org.id, "editor", [mine.id]);
      const refused = await create(org.id, limited);
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ code: "scope_limited" });
      await created(org.id, await memberOf(org.id, "editor"));
    });
  });

  describe("reading", () => {
    it("lists the organizer's events newest first, and only the chosen ones for a limited editor", async () => {
      const org = await newOrganizer();
      const older = await created(org.id, org.cookie);
      const newer = await created(org.id, org.cookie);
      const all = await call("GET", `/v1/organizers/${org.id}/events`, org.cookie);
      expect(all.json<{ events: EventView[] }>().events.map((event) => event.id)).toEqual([
        newer.id,
        older.id,
      ]);
      const limited = await memberOf(org.id, "editor", [older.id]);
      const seen = await call("GET", `/v1/organizers/${org.id}/events`, limited);
      expect(seen.json<{ events: EventView[] }>().events.map((event) => event.id)).toEqual([
        older.id,
      ]);
      expect(
        (await call("GET", `/v1/organizers/${org.id}/events/${newer.id}`, limited)).statusCode,
      ).toBe(404);
    });

    it("never shows another organizer's event, through either organizer's address", async () => {
      const mine = await newOrganizer();
      const theirs = await newOrganizer();
      const event = await created(theirs.id, theirs.cookie);
      expect(
        (await call("GET", `/v1/organizers/${mine.id}/events/${event.id}`, mine.cookie)).statusCode,
      ).toBe(404);
      expect(
        (await call("GET", `/v1/organizers/${theirs.id}/events`, mine.cookie)).statusCode,
      ).toBe(404);
    });

    it("shows the status at this moment before the tick catches up", async () => {
      const org = await newOrganizer();
      const event = await created(org.id, org.cookie);
      await setStatus(event.id, "scheduled", "-1 minute", "1 hour");
      const response = await call("GET", `/v1/organizers/${org.id}/events/${event.id}`, org.cookie);
      expect(response.json<{ event: EventView }>().event).toMatchObject({
        status: "scheduled",
        statusNow: "live",
      });
    });
  });

  describe("editing", () => {
    it("audits only the fields that changed", async () => {
      const org = await newOrganizer();
      const event = await created(org.id, org.cookie);
      const response = await call(
        "PATCH",
        `/v1/organizers/${org.id}/events/${event.id}`,
        org.cookie,
        {
          name: { ar: "ملتقى نجد", en: "Najd Summit" },
        },
      );
      expect(response.statusCode).toBe(200);
      const [entry] = await auditOf(event.id, "event.update");
      expect(entry).toEqual({
        before: { nameEn: "Najd Meetup" },
        after: { nameEn: "Najd Summit" },
      });
    });

    it("keeps the instants when only the zone changes, and writes no audit for no change", async () => {
      const org = await newOrganizer();
      const event = await created(org.id, org.cookie);
      const moved = await call("PATCH", `/v1/organizers/${org.id}/events/${event.id}`, org.cookie, {
        timezone: "Asia/Dubai",
      });
      expect(moved.json<{ event: EventView }>().event).toMatchObject({
        timezone: "Asia/Dubai",
        startsAt: event.startsAt,
      });
      await call("PATCH", `/v1/organizers/${org.id}/events/${event.id}`, org.cookie, {});
      expect(await auditOf(event.id, "event.update")).toHaveLength(1);
    });

    it("lets a live event end later, but never moves its start or shortens it", async () => {
      const org = await newOrganizer();
      const event = await created(org.id, org.cookie);
      await setStatus(event.id, "live", "-1 hour", "2 days");
      const url = `/v1/organizers/${org.id}/events/${event.id}`;
      const later = await call("PATCH", url, org.cookie, { endsAt: "2099-01-01T00:00" });
      expect(later.statusCode).toBe(200);
      for (const payload of [
        { startsAt: "2099-01-01T00:00", endsAt: "2099-02-01T00:00" },
        { endsAt: "2098-01-01T00:00" },
      ]) {
        const locked = await call("PATCH", url, org.cookie, payload);
        expect(locked.statusCode).toBe(409);
        expect(locked.json()).toMatchObject({ code: "event_times_locked" });
      }
    });

    it("audits a change of venue", async () => {
      const org = await newOrganizer();
      const event = await created(org.id, org.cookie);
      await call("PATCH", `/v1/organizers/${org.id}/events/${event.id}`, org.cookie, {
        venue: { en: "Riyadh Front" },
      });
      const [entry] = await auditOf(event.id, "event.update");
      expect(entry).toEqual({ before: { venueEn: null }, after: { venueEn: "Riyadh Front" } });
      const shown = await call("GET", `/v1/organizers/${org.id}/events/${event.id}`, org.cookie);
      expect(shown.json<{ event: { venue: object } }>().event.venue).toEqual({
        ar: null,
        en: "Riyadh Front",
      });
    });

    it.each([
      [
        "a scheduled event's start into the past",
        "scheduled",
        ["1 day", "2 days"],
        { startsAt: "2020-01-01T09:00" },
      ],
      ["an ended event's end", "ended", ["-2 days", "-1 day"], { endsAt: "2099-01-01T00:00" }],
    ])("refuses moving %s", async (_name, status, [from, to], payload) => {
      const org = await newOrganizer();
      const event = await created(org.id, org.cookie);
      await setStatus(event.id, status, from ?? "", to ?? "");
      const response = await call(
        "PATCH",
        `/v1/organizers/${org.id}/events/${event.id}`,
        org.cookie,
        payload,
      );
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "event_times_locked" });
    });

    it.each([
      ["endsAt", {}, { endsAt: "2030-11-01T08:00" }],
      ["joinMethods", { joinMethods: ["code", "public_list"] }, { access: "private" }],
    ])("judges an edit with what is stored: 422 naming %s", async (field, setup, payload) => {
      const org = await newOrganizer();
      const event = await created(org.id, org.cookie, { ...DRAFT, ...setup });
      const response = await call(
        "PATCH",
        `/v1/organizers/${org.id}/events/${event.id}`,
        org.cookie,
        payload,
      );
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ code: "invalid_event", details: { field } });
    });

    it("still renames an event ended early, whose end has microseconds", async () => {
      const org = await newOrganizer();
      const event = await created(org.id, org.cookie);
      await setStatus(event.id, "live", "-1 hour", "1 day");
      const url = `/v1/organizers/${org.id}/events/${event.id}`;
      expect((await call("POST", `${url}/end`, org.cookie, { confirm: true })).statusCode).toBe(
        204,
      );
      const renamed = await call("PATCH", url, org.cookie, { name: { en: "Najd Meetup 2030" } });
      expect(renamed.statusCode).toBe(200);
    });

    it("answers 404 for an event outside the caller's reach", async () => {
      const org = await newOrganizer();
      const other = await newOrganizer();
      const event = await created(other.id, other.cookie);
      const response = await call(
        "PATCH",
        `/v1/organizers/${org.id}/events/${event.id}`,
        org.cookie,
        {
          name: { en: "Taken" },
        },
      );
      expect(response.statusCode).toBe(404);
    });
  });

  describe("deleting", () => {
    it("deletes a draft and audits it with its names", async () => {
      const org = await newOrganizer();
      const event = await created(org.id, org.cookie);
      const response = await call(
        "DELETE",
        `/v1/organizers/${org.id}/events/${event.id}`,
        org.cookie,
      );
      expect(response.statusCode).toBe(204);
      expect(await owner("SELECT 1 FROM event WHERE id = $1", [event.id])).toEqual([]);
      const [entry] = await owner<{ before: Record<string, unknown> }>(
        "SELECT before FROM audit_log WHERE target_id = $1 AND action = 'event.delete'",
        [event.id],
      );
      expect(entry?.before).toMatchObject({ nameAr: "ملتقى نجد", nameEn: "Najd Meetup" });
    });

    it("keeps an activated event", async () => {
      const org = await newOrganizer();
      const event = await created(org.id, org.cookie);
      await setStatus(event.id, "scheduled", "1 day", "2 days");
      const response = await call(
        "DELETE",
        `/v1/organizers/${org.id}/events/${event.id}`,
        org.cookie,
      );
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "event_not_draft" });
    });

    it("answers 404 for an event that is not there", async () => {
      const org = await newOrganizer();
      const response = await call(
        "DELETE",
        `/v1/organizers/${org.id}/events/00000000-0000-4000-8000-000000000000`,
        org.cookie,
      );
      expect(response.statusCode).toBe(404);
    });
  });

  describe("ending early", () => {
    it("is the owner's, after a confirmation, and only for a live event", async () => {
      const org = await newOrganizer();
      const event = await created(org.id, org.cookie);
      const url = `/v1/organizers/${org.id}/events/${event.id}/end`;
      const editor = await memberOf(org.id, "editor");
      expect((await call("POST", url, editor, { confirm: true })).json()).toMatchObject({
        code: "owner_only",
      });
      const draft = await call("POST", url, org.cookie, { confirm: true });
      expect(draft.json()).toMatchObject({ code: "event_not_live" });
      await setStatus(event.id, "live", "-1 hour", "1 day");
      expect((await call("POST", url, org.cookie, {})).statusCode).toBe(400);
      expect((await call("POST", url, org.cookie, { confirm: true })).statusCode).toBe(204);
      const [row] = await owner<{ status: string }>("SELECT status FROM event WHERE id = $1", [
        event.id,
      ]);
      expect(row?.status).toBe("ended");
      expect(await auditOf(event.id, "event.end")).toHaveLength(1);
    });

    it("answers 404 for another organizer's event", async () => {
      const org = await newOrganizer();
      const other = await newOrganizer();
      const event = await created(other.id, other.cookie);
      await setStatus(event.id, "live", "-1 hour", "1 day");
      const response = await call(
        "POST",
        `/v1/organizers/${org.id}/events/${event.id}/end`,
        org.cookie,
        { confirm: true },
      );
      expect(response.statusCode).toBe(404);
    });
  });

  describe("the event's words (T-117)", () => {
    const GEMS = { ar: { one: "جوهرة", many: "جواهر" }, en: { one: "gem", many: "gems" } };
    const STUDENTS = { ar: { one: "طالب", many: "طلاب" }, en: { one: "student", many: "students" } };

    it("saves the words trimmed, shows them on the event read and in the app's configuration, and audits a change", async () => {
      const org = await newOrganizer();
      const event = await created(org.id, org.cookie);
      const body = {
        currency: { icon: "gem", ar: { one: " جوهرة ", many: "جواهر" }, en: GEMS.en },
        player: STUDENTS,
      };
      const saved = await save(org.id, event.id, org.cookie, body);
      expect(saved.statusCode).toBe(200);
      const terms = { ...DEFAULT_TERMS, currency: { icon: "gem", ...GEMS }, player: STUDENTS };
      expect(saved.json()).toStrictEqual({ terms });
      const read = await call("GET", `/v1/organizers/${org.id}/events/${event.id}`, org.cookie);
      expect(read.json<{ event: { terms: unknown } }>().event.terms).toStrictEqual(terms);
      const list = await call("GET", `/v1/organizers/${org.id}/events`, org.cookie);
      expect(list.json<{ events: object[] }>().events[0]).not.toHaveProperty("terms");

      await owner("UPDATE event SET access = 'public' WHERE id = $1", [event.id]);
      await setStatus(event.id, "live", "-1 hour", "1 day");
      const config = await test.app.inject({ method: "GET", url: `/v1/config?event=${event.id}` });
      expect(config.json<{ terms: unknown }>().terms).toStrictEqual(terms);
      const platform = await test.app.inject({ method: "GET", url: "/v1/config" });
      expect(platform.json<{ terms: unknown }>().terms).toStrictEqual(DEFAULT_TERMS);

      expect(await auditOf(event.id, "event.terms.update")).toStrictEqual([
        {
          before: { terms: {} },
          after: { terms: { currency: { icon: "gem", ...GEMS }, player: STUDENTS } },
        },
      ]);
      expect((await save(org.id, event.id, org.cookie, body)).statusCode).toBe(200);
      expect(await auditOf(event.id, "event.terms.update")).toHaveLength(1);
    });

    it("saves the quest and category words, and the app's configuration carries them", async () => {
      const org = await newOrganizer();
      const event = await created(org.id, org.cookie);
      const quest = {
        ar: { one: "مغامرة", many: "مغامرات" },
        en: { one: "mission", many: "missions" },
      };
      const category = {
        ar: { one: "مرحلة", many: "مراحل" },
        en: { one: "stage", many: "stages" },
      };
      const saved = await save(org.id, event.id, org.cookie, { quest, category });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toStrictEqual({ terms: { ...DEFAULT_TERMS, quest, category } });
      await owner("UPDATE event SET access = 'public' WHERE id = $1", [event.id]);
      await setStatus(event.id, "live", "-1 hour", "1 day");
      const config = await test.app.inject({ method: "GET", url: `/v1/config?event=${event.id}` });
      expect(config.json<{ terms: unknown }>().terms).toStrictEqual({
        ...DEFAULT_TERMS,
        quest,
        category,
      });
      const platform = await test.app.inject({ method: "GET", url: "/v1/config" });
      expect(platform.json<{ terms: unknown }>().terms).toStrictEqual(DEFAULT_TERMS);
    });

    it("replaces the whole set: a word left out returns to the default, and the icon saves on its own", async () => {
      const org = await newOrganizer();
      const event = await created(org.id, org.cookie);
      await save(org.id, event.id, org.cookie, { player: STUDENTS });
      const saved = await save(org.id, event.id, org.cookie, { currency: { icon: "leaf" } });
      expect(saved.json()).toStrictEqual({
        terms: { ...DEFAULT_TERMS, currency: { ...DEFAULT_TERMS.currency, icon: "leaf" } },
      });
      const [row] = await owner<{ config: unknown; config_version: number }>(
        "SELECT config, config_version FROM event WHERE id = $1",
        [event.id],
      );
      expect(row).toStrictEqual({
        config: { terms: { currency: { icon: "leaf" } } },
        config_version: 3,
      });
    });

    it("keeps the event's switches, and works after the event ends but not once it is archived", async () => {
      const org = await newOrganizer();
      const event = await created(org.id, org.cookie);
      await call("PUT", `/v1/organizers/${org.id}/events/${event.id}/ranking`, org.cookie, {
        enabled: false,
      });
      await setStatus(event.id, "ended", "-2 days", "-1 day");
      expect((await save(org.id, event.id, org.cookie, { player: STUDENTS })).statusCode).toBe(200);
      const [row] = await owner<{ config: unknown }>("SELECT config FROM event WHERE id = $1", [
        event.id,
      ]);
      expect(row?.config).toStrictEqual({
        features: { ranking: false },
        terms: { player: STUDENTS },
      });
      await owner("UPDATE event SET status = 'archived' WHERE id = $1", [event.id]);
      const archived = await save(org.id, event.id, org.cookie, {});
      expect(archived.statusCode).toBe(409);
      expect(archived.json()).toMatchObject({ code: "event_archived" });
    });

    it("lets an editor within their events save, and answers 404 outside the caller's reach", async () => {
      const org = await newOrganizer();
      const mine = await created(org.id, org.cookie);
      const elsewhere = await created(org.id, org.cookie);
      const limited = await memberOf(org.id, "editor", [mine.id]);
      expect((await save(org.id, mine.id, limited, { player: STUDENTS })).statusCode).toBe(200);
      expect((await save(org.id, elsewhere.id, limited, { player: STUDENTS })).statusCode).toBe(
        404,
      );
      const other = await newOrganizer();
      expect((await save(org.id, mine.id, other.cookie, {})).statusCode).toBe(404);
      expect((await save(other.id, mine.id, other.cookie, {})).statusCode).toBe(404);
      expect(
        (await save(org.id, "00000000-0000-4000-8000-000000000000", org.cookie, {})).statusCode,
      ).toBe(404);
      expect((await auditOf(elsewhere.id, "event.terms.update")).length).toBe(0);
    });

    it.each([
      [{ player: { ar: STUDENTS.ar, en: { one: "student" } } }, "player.en.many"],
      [{ currency: { ar: GEMS.ar } }, "currency.en"],
      [{ currency: { icon: "trophy" } }, "currency.icon"],
      [{ player: { ...STUDENTS, en: { one: "student1", many: "students" } } }, "player.en.one"],
      [{ prize: GEMS }, ""],
      [{ quest: { ar: GEMS.ar, en: { one: "mission", many: "mission {1}" } } }, "quest.en.many"],
      [{ category: { en: GEMS.en } }, "category.ar"],
    ])("names the field it refuses (%j)", async (payload, field) => {
      const org = await newOrganizer();
      const event = await created(org.id, org.cookie);
      const refused = await save(org.id, event.id, org.cookie, payload);
      expect(refused.statusCode).toBe(422);
      expect(refused.json()).toMatchObject({ code: "invalid_terms", details: { field } });
      expect(await auditOf(event.id, "event.terms.update")).toHaveLength(0);
    });
  });

  describe("join codes", () => {
    const caller = { address: "127.0.0.1", userAgent: null, log: () => undefined };
    it("skips a code that is taken and tries another, and gives up after five", async () => {
      const org = await newOrganizer();
      const [staff] = await owner<{ staff_user_id: string }>(
        "SELECT staff_user_id FROM organizer_member WHERE organizer_id = $1",
        [org.id],
      );
      const actor = { ...ownerOf(org.id), staffUserId: staff?.staff_user_id ?? "" };
      const taken = (await created(org.id, org.cookie)).joinCode;
      const codes = [taken, taken, "FRESH2"];
      const retrying = createEvents({ pool: test.pool, joinCodes: () => codes.shift() ?? taken });
      const made = await retrying.create(actor, { ...DRAFT, name: { en: "Second" } }, caller);
      expect(made).toMatchObject({ kind: "created", event: { joinCode: "FRESH2" } });

      let tries = 0;
      const stuck = createEvents({
        pool: test.pool,
        joinCodes: () => {
          tries += 1;
          return taken;
        },
      });
      await expect(stuck.create(actor, DRAFT, caller)).rejects.toThrow(/No free join code after 5/);
      expect(tries).toBe(5);
    });
  });

  describe("the lifecycle tick", () => {
    it("moves a due event on its own and stops cleanly", async () => {
      const org = await newOrganizer();
      const event = await created(org.id, org.cookie);
      await setStatus(event.id, "scheduled", "-1 minute", "1 day");
      const logged: Record<string, unknown>[] = [];
      const tick = startLifecycleTick({
        pool: test.pool,
        intervalMs: 10,
        log: (_level, fields) => logged.push(fields),
      });
      await expect
        .poll(
          async () =>
            (
              await owner<{ status: string }>("SELECT status FROM event WHERE id = $1", [event.id])
            )[0]?.status,
        )
        .toBe("live");
      await tick.stop();
      expect(logged).toContainEqual(expect.objectContaining({ event: "event.lifecycle_moved" }));
    });
  });
});
