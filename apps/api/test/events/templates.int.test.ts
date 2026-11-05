import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { presetLayout, templateListSchema } from "@questify/shared";
import {
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { createEvents } from "#src/events/events";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type EventView = {
  id: string;
  status: string;
  branding: { accent: string | null };
  layout: { home: { order: string[] } };
  questRatings: boolean;
  miniGames: boolean;
};

const DRAFT = {
  name: { ar: "ملتقى نجد", en: "Najd Meetup" },
  timezone: "Asia/Riyadh",
  startsAt: "2030-11-01T09:00",
  endsAt: "2030-11-01T17:00",
};

/**
 * Event templates through the API (T-601b, FR-1015; plan docs/plans/2026-11-02-t-601b-event-templates.md, ADR-404): the picker's
 * list, a new event started from a template in one transaction, and the guided setup's "Start from" on an empty draft.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("event templates (API)", () => {
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

  const memberOf = async (
    org: string,
    role: "owner" | "editor",
    eventScope: string[] | null = null,
  ): Promise<string> => {
    counter += 1;
    const email = `${role}${counter}@templates.test`;
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
      [`templates-${counter}`],
    );
    const id = row?.id ?? "";
    return { id, cookie: await memberOf(id, "owner") };
  };

  const call = (
    method: "GET" | "POST",
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

  const create = (org: string, cookie: string, payload: object, key = `k-${Math.random()}`) =>
    call("POST", `/v1/organizers/${org}/events`, cookie, payload, { "idempotency-key": key });
  const start = (
    org: string,
    event: string,
    cookie: string,
    payload: object,
    key = `s-${Math.random()}`,
  ) =>
    call("POST", `/v1/organizers/${org}/events/${event}/template`, cookie, payload, {
      "idempotency-key": key,
    });
  const blank = async (org: { id: string; cookie: string }): Promise<string> =>
    (await create(org.id, org.cookie, DRAFT)).json<{ event: EventView }>().event.id;
  const count = async (table: string, event: string): Promise<number> =>
    (
      await owner<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE event_id = $1`, [
        event,
      ])
    )[0]?.n ?? 0;
  const eventsOf = async (org: string): Promise<number> =>
    (
      await owner<{ n: number }>("SELECT count(*)::int AS n FROM event WHERE organizer_id = $1", [
        org,
      ])
    )[0]?.n ?? 0;

  const insertBadTemplate = () =>
    owner(
      `INSERT INTO event_template (key, position, name_ar, name_en, description_ar, description_en, body)
       VALUES ('badly', 96, 'قالب', 'Badly', 'وصف', 'Text',
               '{"config": {}, "categories": [], "rewards": []}'::jsonb)`,
    );
  const deleteBadTemplate = () => owner("DELETE FROM event_template WHERE key = 'badly'");

  describe("the picker's list", () => {
    it("lists the four templates in order with what each sets up, and nothing a player would not see", async () => {
      const org = await newOrganizer();
      const response = await call("GET", `/v1/organizers/${org.id}/event-templates`, org.cookie);
      expect(response.statusCode).toBe(200);
      const { templates } = templateListSchema.parse(response.json());
      expect(templates.map((one) => one.key)).toEqual([
        "conference",
        "festival",
        "campus",
        "corporate",
      ]);
      expect(templates[1]).toMatchObject({
        name: { ar: "مهرجان", en: "Festival" },
        accent: "ember",
      });
      expect(templates.every((one) => one.categories.length >= 3 && one.rewards.length >= 4)).toBe(
        true,
      );
      expect(response.body).not.toContain("typeConfig");
      expect(response.body).not.toContain("descriptionEn");
    });

    it("leaves out a template saved badly and names it in the log, so the others still list", async () => {
      await insertBadTemplate();
      try {
        const org = await newOrganizer();
        const response = await call("GET", `/v1/organizers/${org.id}/event-templates`, org.cookie);
        expect(response.statusCode).toBe(200);
        const { templates } = templateListSchema.parse(response.json());
        expect(templates.map((one) => one.key)).toEqual([
          "conference",
          "festival",
          "campus",
          "corporate",
        ]);

        const lines: Array<Record<string, string>> = [];
        const events = createEvents({
          pool: test.pool,
          log: (level, fields) => lines.push({ level, ...fields }),
        });
        const [member] = await owner<{ staff_user_id: string }>(
          "SELECT staff_user_id FROM organizer_member WHERE organizer_id = $1",
          [org.id],
        );
        const actor = {
          organizerId: org.id,
          staffUserId: member?.staff_user_id ?? "",
          organizer: { id: org.id, role: "owner" as const, eventScope: null },
        };
        expect(await events.templates(actor)).toHaveLength(4);
        expect(lines).toEqual([
          expect.objectContaining({ level: "warn", event: "event_template.invalid", key: "badly" }),
        ]);
      } finally {
        await deleteBadTemplate();
      }
    });

    it("answers a member of any organizer and nobody who is signed out", async () => {
      const first = await newOrganizer();
      const editor = await memberOf(first.id, "editor");
      expect(
        (await call("GET", `/v1/organizers/${first.id}/event-templates`, editor)).statusCode,
      ).toBe(200);
      const other = await newOrganizer();
      expect(
        (await call("GET", `/v1/organizers/${first.id}/event-templates`, other.cookie)).statusCode,
      ).toBe(404);
      const anonymous = await test.app.inject({
        method: "GET",
        url: `/v1/organizers/${first.id}/event-templates`,
      });
      expect(anonymous.statusCode).toBe(401);
    });
  });

  describe("a new event from a template", () => {
    it("makes the draft and fills it in one request, with the template's switches, accent and layout", async () => {
      const org = await newOrganizer();
      const response = await create(org.id, org.cookie, { ...DRAFT, template: "festival" });
      expect(response.statusCode).toBe(201);
      const { event } = response.json<{ event: EventView }>();
      expect(event.status).toBe("draft");
      expect(event.branding.accent).toBe("ember");
      expect(event.layout.home.order.slice(0, 3)).toEqual(
        presetLayout("play_first")?.home.order.slice(0, 3),
      );
      expect(await count("category", event.id)).toBe(4);
      expect(await count("quest", event.id)).toBe(12);
      expect(await count("reward", event.id)).toBe(5);
      expect(await count("enrollment", event.id)).toBe(0);
      const audits = await owner<{ action: string }>(
        "SELECT action FROM audit_log WHERE event_id = $1 ORDER BY id",
        [event.id],
      );
      expect(audits.map((entry) => entry.action)).toEqual(["event.create", "event.template"]);
    });

    it("turns a switch on or off as the template says", async () => {
      const org = await newOrganizer();
      const conference = await create(org.id, org.cookie, { ...DRAFT, template: "conference" });
      expect(conference.json<{ event: EventView }>().event).toMatchObject({
        miniGames: false,
        questRatings: true,
      });
      const plain = await create(org.id, org.cookie, DRAFT);
      expect(plain.json<{ event: EventView }>().event).toMatchObject({
        miniGames: true,
        questRatings: false,
      });
    });

    it("starts blank without a template: the General category and nothing else", async () => {
      const org = await newOrganizer();
      const { event } = (await create(org.id, org.cookie, DRAFT)).json<{ event: EventView }>();
      expect([await count("category", event.id), await count("quest", event.id)]).toEqual([1, 0]);
    });

    it("replays the first answer to a retried request instead of filling a second event", async () => {
      const org = await newOrganizer();
      const payload = { ...DRAFT, template: "campus" };
      const first = await create(org.id, org.cookie, payload, "double-click");
      const again = await create(org.id, org.cookie, payload, "double-click");
      expect(again.headers["idempotent-replayed"]).toBe("true");
      expect(again.json()).toEqual(first.json());
      expect(await eventsOf(org.id)).toBe(1);
    });

    it("refuses a template that is not there, and leaves no event behind", async () => {
      const org = await newOrganizer();
      const response = await create(org.id, org.cookie, { ...DRAFT, template: "wedding" });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({
        code: "invalid_event",
        details: { field: "template" },
      });
      expect(await eventsOf(org.id)).toBe(0);
    });

    it.each(["Wedding", "a", "has space", "1abc", "x".repeat(31), ""])(
      "refuses the key %j before it reaches the database",
      async (key) => {
        const org = await newOrganizer();
        const response = await create(org.id, org.cookie, { ...DRAFT, template: key });
        expect(response.statusCode).toBe(400);
        expect(await eventsOf(org.id)).toBe(0);
      },
    );

    it("starts from a good template while another is saved badly, and stops at the bad one with no event left behind", async () => {
      await insertBadTemplate();
      try {
        const org = await newOrganizer();
        const good = await create(org.id, org.cookie, { ...DRAFT, template: "festival" });
        expect(good.statusCode).toBe(201);
        const bad = await create(org.id, org.cookie, { ...DRAFT, template: "badly" });
        expect(bad.statusCode).toBe(500);
        expect(await eventsOf(org.id)).toBe(1);
      } finally {
        await deleteBadTemplate();
      }
    });

    it("is closed to an editor limited to chosen events, as a plain create is", async () => {
      const org = await newOrganizer();
      const mine = (await create(org.id, org.cookie, DRAFT)).json<{ event: EventView }>().event;
      const limited = await memberOf(org.id, "editor", [mine.id]);
      const refused = await create(org.id, limited, { ...DRAFT, template: "festival" });
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ code: "scope_limited" });
    });
  });

  describe("starting an empty draft from a template (the guided setup)", () => {
    it("fills an empty draft and answers the event as it is now", async () => {
      const org = await newOrganizer();
      const id = await blank(org);
      const response = await start(org.id, id, org.cookie, { template: "corporate" });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ event: EventView }>().event).toMatchObject({
        id,
        branding: { accent: "violet" },
        miniGames: false,
      });
      expect(await count("category", id)).toBe(4);
      expect(
        (
          await owner("SELECT 1 FROM audit_log WHERE event_id = $1 AND action = 'event.template'", [
            id,
          ])
        ).length,
      ).toBe(1);
    });

    it("replays a double click and refuses a second template on the same event", async () => {
      const org = await newOrganizer();
      const id = await blank(org);
      const first = await start(org.id, id, org.cookie, { template: "campus" }, "once");
      const again = await start(org.id, id, org.cookie, { template: "campus" }, "once");
      expect(again.headers["idempotent-replayed"]).toBe("true");
      expect(again.json()).toEqual(first.json());
      const second = await start(org.id, id, org.cookie, { template: "festival" });
      expect(second.statusCode).toBe(409);
      expect(second.json()).toMatchObject({ code: "event_not_empty" });
      expect(await count("category", id)).toBe(4);
    });

    it("never overwrites an organizer's work", async () => {
      const org = await newOrganizer();
      const id = await blank(org);
      await owner(
        "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, 'experience', 'Mine', 10, 1)",
        [id],
      );
      const response = await start(org.id, id, org.cookie, { template: "festival" });
      expect(response.statusCode).toBe(409);
      expect(await count("quest", id)).toBe(0);
      expect(await count("reward", id)).toBe(1);
    });

    it("refuses an unknown template, a stray field and another organizer's event", async () => {
      const org = await newOrganizer();
      const id = await blank(org);
      const unknown = await start(org.id, id, org.cookie, { template: "wedding" });
      expect([unknown.statusCode, unknown.json<{ code: string }>().code]).toEqual([
        422,
        "invalid_event",
      ]);
      expect(
        (await start(org.id, id, org.cookie, { template: "festival", extra: 1 })).statusCode,
      ).toBe(400);
      expect((await start(org.id, id, org.cookie, {})).statusCode).toBe(400);
      const other = await newOrganizer();
      const foreign = await start(other.id, id, other.cookie, { template: "festival" });
      expect(foreign.statusCode).toBe(404);
      const missing = await start(org.id, "00000000-0000-4000-8000-000000000000", org.cookie, {
        template: "festival",
      });
      expect(missing.statusCode).toBe(404);
      expect(await count("quest", id)).toBe(0);
    });

    it("lets an editor limited to this event start it, and hides other events from them", async () => {
      const org = await newOrganizer();
      const mine = await blank(org);
      const other = await blank(org);
      const limited = await memberOf(org.id, "editor", [mine]);
      expect((await start(org.id, mine, limited, { template: "campus" })).statusCode).toBe(200);
      expect((await start(org.id, other, limited, { template: "campus" })).statusCode).toBe(404);
      expect(await count("quest", other)).toBe(0);
    });
  });
});
