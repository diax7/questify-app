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

type Category = { id: string; name: { ar: string | null; en: string | null }; position: number };
type Quest = {
  id: string;
  categoryId: string;
  type: string;
  points: number;
  position: number;
  opensAt: string | null;
  closesAt: string | null;
  visible: boolean;
  config: Record<string, unknown>;
};
type Builder = { categories: (Category & { quests: Quest[] })[] };

const EVENT = {
  name: { en: "Najd Meetup" },
  timezone: "Asia/Riyadh",
  startsAt: "2030-11-01T09:00",
  endsAt: "2030-11-01T17:00",
};

const key = () => ({ "idempotency-key": `k-${Math.random()}` });

describe.skipIf(TEST_DATABASE_URL === undefined)("the quest builder (T-103)", () => {
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

  const memberOf = async (org: string, role: "owner" | "editor", scope: string[] | null = null) => {
    counter += 1;
    const email = `${role}${counter}@quests.test`;
    const id = await createStaff(db.owner, { email });
    await owner(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role, event_scope) VALUES ($1, $2, $3, $4)",
      [org, id, role, scope],
    );
    return signInFully(test, email);
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

  /** A new organizer with a signed-in owner and one draft event, and the paths under that event. */
  const newEvent = async () => {
    counter += 1;
    const [org] = await owner<{ id: string }>(
      "INSERT INTO organizer (name, slug) VALUES ('Najd Events', $1) RETURNING id",
      [`quests-${counter}`],
    );
    const orgId = org?.id ?? "";
    const cookie = await memberOf(orgId, "owner");
    const made = await call("POST", `/v1/organizers/${orgId}/events`, cookie, EVENT, key());
    const eventId = made.json<{ event: { id: string } }>().event.id;
    const base = `/v1/organizers/${orgId}/events/${eventId}`;
    const builder = async () => (await call("GET", `${base}/quests`, cookie)).json<Builder>();
    const general = (await builder()).categories[0]?.id ?? "";
    return { orgId, eventId, cookie, base, builder, general };
  };
  type Setup = Awaited<ReturnType<typeof newEvent>>;

  const addCategory = async (s: Setup, en: string): Promise<Category> => {
    const response = await call("POST", `${s.base}/categories`, s.cookie, { name: { en } }, key());
    expect(response.statusCode).toBe(201);
    return response.json<{ category: Category }>().category;
  };
  const addQuest = async (s: Setup, extra: object = {}): Promise<Quest> => {
    const response = await call(
      "POST",
      `${s.base}/quests`,
      s.cookie,
      {
        categoryId: s.general,
        type: "scan_qr",
        title: { en: "Find the stage" },
        points: 10,
        ...extra,
      },
      key(),
    );
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ quest: Quest }>().quest;
  };
  const setStatus = (eventId: string, status: string, starts: string, ends: string) =>
    owner(
      "UPDATE event SET status = $2, starts_at = now() + $3::interval, ends_at = now() + $4::interval WHERE id = $1",
      [eventId, status, starts, ends],
    );
  const auditOf = (target: string, action: string) =>
    owner<{ before: Record<string, unknown> | null; after: Record<string, unknown> | null }>(
      "SELECT before, after FROM audit_log WHERE target_id = $1 AND action = $2 ORDER BY id",
      [target, action],
    );

  describe("reading", () => {
    it("shows a new event's General category with no quests", async () => {
      const s = await newEvent();
      expect(await s.builder()).toEqual({
        categories: [
          { id: s.general, name: { ar: "عام", en: "General" }, position: 0, quests: [] },
        ],
      });
    });
  });

  describe("categories", () => {
    it("adds at the end, renames with an audit of the change, and reorders by the full list", async () => {
      const s = await newEvent();
      const stage = await addCategory(s, "Stage");
      expect(stage.position).toBe(1);
      const renamed = await call("PATCH", `${s.base}/categories/${stage.id}`, s.cookie, {
        name: { ar: "المسرح", en: "Stage" },
      });
      expect(renamed.json()).toMatchObject({ category: { name: { ar: "المسرح", en: "Stage" } } });
      expect(await auditOf(stage.id, "category.update")).toEqual([
        { before: { nameAr: null }, after: { nameAr: "المسرح" } },
      ]);
      const order = await call("PUT", `${s.base}/categories/order`, s.cookie, {
        ids: [stage.id, s.general],
      });
      expect(order.statusCode).toBe(204);
      expect((await s.builder()).categories.map((category) => category.id)).toEqual([
        stage.id,
        s.general,
      ]);
      const [reordered] = await auditOf(s.eventId, "category.reorder");
      expect(reordered?.after).toEqual({ order: [stage.id, s.general] });
    });

    it("refuses an order that is not exactly the current set", async () => {
      const s = await newEvent();
      await addCategory(s, "Stage");
      for (const ids of [[s.general], [s.general, s.general], [s.general, crypto.randomUUID()]]) {
        const response = await call("PUT", `${s.base}/categories/order`, s.cookie, { ids });
        expect(response.json()).toMatchObject({ code: "order_stale" });
      }
    });

    it("takes a name in Arabic alone, refuses a rename to nothing, and audits no rename that changes nothing", async () => {
      const s = await newEvent();
      const response = await call(
        "POST",
        `${s.base}/categories`,
        s.cookie,
        { name: { ar: "المسرح" } },
        key(),
      );
      const stage = response.json<{ category: Category }>().category;
      expect(stage.name).toEqual({ ar: "المسرح", en: null });
      const blank = await call("PATCH", `${s.base}/categories/${stage.id}`, s.cookie, {
        name: { ar: "", en: " " },
      });
      expect(blank.json()).toMatchObject({ code: "invalid_category", details: { field: "name" } });
      await call("PATCH", `${s.base}/categories/${stage.id}`, s.cookie, { name: { ar: "المسرح" } });
      expect(await auditOf(stage.id, "category.update")).toEqual([]);
      const english = await call("PATCH", `${s.base}/categories/${stage.id}`, s.cookie, {
        name: { en: "Stage" },
      });
      expect(english.json()).toMatchObject({ category: { name: { ar: null, en: "Stage" } } });
    });

    it("deletes an empty category whatever choice comes with it", async () => {
      const s = await newEvent();
      const one = await addCategory(s, "One");
      const two = await addCategory(s, "Two");
      for (const [category, choice] of [
        [one, { quests: "delete" }],
        [two, { quests: "move", to: crypto.randomUUID() }],
      ] as const) {
        const response = await call(
          "DELETE",
          `${s.base}/categories/${category.id}`,
          s.cookie,
          choice,
        );
        expect(response.statusCode).toBe(204);
      }
      expect((await s.builder()).categories.map((category) => category.id)).toEqual([s.general]);
    });

    it("refuses a category with no name", async () => {
      const s = await newEvent();
      const response = await call(
        "POST",
        `${s.base}/categories`,
        s.cookie,
        { name: { en: " " } },
        key(),
      );
      expect(response.json()).toMatchObject({
        code: "invalid_category",
        details: { field: "name" },
      });
    });

    it("keeps the last category", async () => {
      const s = await newEvent();
      const response = await call("DELETE", `${s.base}/categories/${s.general}`, s.cookie);
      expect(response.json()).toMatchObject({ code: "last_category" });
    });

    it("asks what to do with the quests of a category that holds some", async () => {
      const s = await newEvent();
      await addCategory(s, "Stage");
      await addQuest(s);
      const response = await call("DELETE", `${s.base}/categories/${s.general}`, s.cookie);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "category_not_empty", details: { quests: 1 } });
    });

    it("moves the quests to the end of another category, in their order", async () => {
      const s = await newEvent();
      const stage = await addCategory(s, "Stage");
      const already = await addQuest(s, { categoryId: stage.id });
      const first = await addQuest(s);
      const second = await addQuest(s);
      const response = await call("DELETE", `${s.base}/categories/${s.general}`, s.cookie, {
        quests: "move",
        to: stage.id,
      });
      expect(response.statusCode).toBe(204);
      const [only] = (await s.builder()).categories;
      expect(only?.quests.map((quest) => quest.id)).toEqual([already.id, first.id, second.id]);
      const [entry] = await auditOf(s.general, "category.delete");
      expect(entry?.after).toEqual({ quests: 2, movedTo: stage.id });
    });

    it("deletes the quests with their category, recorded in one entry", async () => {
      const s = await newEvent();
      await addCategory(s, "Stage");
      const quest = await addQuest(s);
      await call("DELETE", `${s.base}/categories/${s.general}`, s.cookie, { quests: "delete" });
      expect(await owner("SELECT 1 FROM quest WHERE id = $1", [quest.id])).toEqual([]);
      const [entry] = await auditOf(s.general, "category.delete");
      expect(entry?.after).toEqual({ quests: 1, deletedQuests: [quest.id] });
    });

    it("refuses moving the quests into the category itself or into another event", async () => {
      const s = await newEvent();
      const other = await newEvent();
      await addCategory(s, "Stage");
      await addQuest(s);
      for (const to of [s.general, other.general, crypto.randomUUID()]) {
        const response = await call("DELETE", `${s.base}/categories/${s.general}`, s.cookie, {
          quests: "move",
          to,
        });
        expect(response.json()).toMatchObject({
          code: "invalid_category",
          details: { field: "to" },
        });
      }
      expect((await s.builder()).categories[0]?.quests).toHaveLength(1);
    });

    it("stops at 30 categories, even when they arrive at once", async () => {
      const s = await newEvent();
      const responses = await Promise.all(
        Array.from({ length: 31 }, (_, n) =>
          call("POST", `${s.base}/categories`, s.cookie, { name: { en: `C${n}` } }, key()),
        ),
      );
      expect(responses.filter((response) => response.statusCode === 201)).toHaveLength(29);
      const refused = responses.filter((response) => response.statusCode !== 201);
      expect(refused.map((response) => response.json())).toEqual(
        Array.from({ length: 2 }, () =>
          expect.objectContaining({ code: "limit_reached", details: { limit: 30 } }),
        ),
      );
    });
  });

  describe("quests", () => {
    it("adds a quest at the end of its category, with the defaults, and audits it", async () => {
      const s = await newEvent();
      await addQuest(s);
      const quest = await addQuest(s, { description: { ar: "ابحث عن المسرح" } });
      expect(quest).toMatchObject({ position: 1, visible: true, opensAt: null, config: {} });
      expect((await auditOf(quest.id, "quest.create"))[0]?.after).toMatchObject({
        type: "scan_qr",
        descriptionAr: "ابحث عن المسرح",
        repeatCap: 1,
      });
    });

    it("replays a retried create instead of adding the quest twice", async () => {
      const s = await newEvent();
      const body = { categoryId: s.general, type: "scan_qr", title: { en: "Once" }, points: 1 };
      const headers = { "idempotency-key": "double-click" };
      const first = await call("POST", `${s.base}/quests`, s.cookie, body, headers);
      const again = await call("POST", `${s.base}/quests`, s.cookie, body, headers);
      expect(again.headers["idempotent-replayed"]).toBe("true");
      expect(again.json()).toEqual(first.json());
      expect(await owner("SELECT 1 FROM quest WHERE event_id = $1", [s.eventId])).toHaveLength(1);
    });

    it("reads the window in the event's zone", async () => {
      const s = await newEvent();
      const quest = await addQuest(s, {
        opensAt: "2030-11-01T10:00",
        closesAt: "2030-11-01T12:00",
      });
      expect(quest).toMatchObject({
        opensAt: "2030-11-01T07:00:00.000Z",
        closesAt: "2030-11-01T09:00:00.000Z",
      });
    });

    it("upper-cases an entry code, shows it to members, and masks it in the audit", async () => {
      const s = await newEvent();
      const quest = await addQuest(s, { type: "enter_code", config: { code: "najd2030" } });
      expect(quest.config).toEqual({ code: "NAJD2030" });
      const [entry] = await auditOf(quest.id, "quest.create");
      expect(entry?.after).toMatchObject({ config: {}, entryCode: "set" });
      expect(JSON.stringify(entry)).not.toContain("NAJD2030");
    });

    it("records that an entry code changed, never the code", async () => {
      const s = await newEvent();
      const quest = await addQuest(s, { type: "enter_code", config: { code: "NAJD2030" } });
      await call("PATCH", `${s.base}/quests/${quest.id}`, s.cookie, {
        config: { code: "TABUK31" },
      });
      const [entry] = await auditOf(quest.id, "quest.update");
      expect(entry).toEqual({ before: { codeChanged: false }, after: { codeChanged: true } });
    });

    it.each([
      ["type", { type: "submission" }],
      ["type", { type: "constructor" }],
      ["config", { type: "enter_code", config: { code: "ab" } }],
      ["config", { config: { code: "NAJD2030" } }],
      ["title", { title: { ar: " ", en: "" } }],
      ["opensAt", { opensAt: "2030-02-30T10:00" }],
      ["closesAt", { opensAt: "2030-11-01T12:00", closesAt: "2030-11-01T12:00" }],
    ])("answers 422 naming %s", async (field, extra) => {
      const s = await newEvent();
      const response = await call(
        "POST",
        `${s.base}/quests`,
        s.cookie,
        { categoryId: s.general, type: "scan_qr", title: { en: "Find" }, points: 10, ...extra },
        key(),
      );
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ code: "invalid_quest", details: { field } });
    });

    it("refuses a category of another event", async () => {
      const s = await newEvent();
      const other = await newEvent();
      const response = await call(
        "POST",
        `${s.base}/quests`,
        s.cookie,
        { categoryId: other.general, type: "scan_qr", title: { en: "x" }, points: 1 },
        key(),
      );
      expect(response.json()).toMatchObject({
        code: "invalid_quest",
        details: { field: "categoryId" },
      });
    });

    it("refuses a body with a field the builder never writes", async () => {
      const s = await newEvent();
      const quest = await addQuest(s);
      const response = await call("PATCH", `${s.base}/quests/${quest.id}`, s.cookie, {
        type: "enter_code",
      });
      expect(response.json()).toMatchObject({ code: "invalid_request" });
    });

    it("edits only what is sent, checks the config against the stored type, and clears a time with null", async () => {
      const s = await newEvent();
      const quest = await addQuest(s, {
        type: "enter_code",
        config: { code: "NAJD2030" },
        opensAt: "2030-11-01T10:00",
      });
      const url = `${s.base}/quests/${quest.id}`;
      const edited = await call("PATCH", url, s.cookie, {
        points: 25,
        repeatCap: 3,
        visible: false,
        opensAt: null,
      });
      expect(edited.json()).toMatchObject({
        quest: { points: 25, opensAt: null, visible: false, config: { code: "NAJD2030" } },
      });
      expect((await call("PATCH", url, s.cookie, { config: {} })).json()).toMatchObject({
        details: { field: "config" },
      });
      expect((await auditOf(quest.id, "quest.update"))[0]?.after).toEqual({
        points: 25,
        repeatCap: 3,
        visible: false,
        opensAt: null,
      });
    });

    it("moves a quest to the end of another category and reorders a category's quests", async () => {
      const s = await newEvent();
      const stage = await addCategory(s, "Stage");
      const there = await addQuest(s, { categoryId: stage.id });
      const one = await addQuest(s);
      const two = await addQuest(s);
      const moved = await call("PATCH", `${s.base}/quests/${one.id}`, s.cookie, {
        categoryId: stage.id,
      });
      expect(moved.json()).toMatchObject({ quest: { categoryId: stage.id, position: 1 } });
      const order = await call("PUT", `${s.base}/categories/${stage.id}/quests/order`, s.cookie, {
        ids: [one.id, there.id],
      });
      expect(order.statusCode).toBe(204);
      const categories = (await s.builder()).categories;
      expect(categories.map((category) => category.quests.map((quest) => quest.id))).toEqual([
        [two.id],
        [one.id, there.id],
      ]);
    });

    it("refuses moving a quest into another event's category, and a stale quest order", async () => {
      const s = await newEvent();
      const other = await newEvent();
      const quest = await addQuest(s);
      const moved = await call("PATCH", `${s.base}/quests/${quest.id}`, s.cookie, {
        categoryId: other.general,
      });
      expect(moved.json()).toMatchObject({
        code: "invalid_quest",
        details: { field: "categoryId" },
      });
      const stale = await call("PUT", `${s.base}/categories/${s.general}/quests/order`, s.cookie, {
        ids: [],
      });
      expect(stale.json()).toMatchObject({ code: "order_stale" });
    });

    it("writes no audit entry for an edit that changes nothing", async () => {
      const s = await newEvent();
      const quest = await addQuest(s);
      await call("PATCH", `${s.base}/quests/${quest.id}`, s.cookie, { points: quest.points });
      expect(await auditOf(quest.id, "quest.update")).toEqual([]);
    });

    it("deletes a quest and audits what it was", async () => {
      const s = await newEvent();
      const quest = await addQuest(s);
      expect((await call("DELETE", `${s.base}/quests/${quest.id}`, s.cookie)).statusCode).toBe(204);
      expect((await auditOf(quest.id, "quest.delete"))[0]?.before).toMatchObject({ points: 10 });
    });

    it("stops at 300 quests in an event", async () => {
      const s = await newEvent();
      await owner(
        "INSERT INTO quest (event_id, category_id, type, title_en, points, position) SELECT $1, $2, 'scan_qr', 'q' || n, 1, n FROM generate_series(1, 299) n",
        [s.eventId, s.general],
      );
      await addQuest(s);
      const refused = await call(
        "POST",
        `${s.base}/quests`,
        s.cookie,
        { categoryId: s.general, type: "scan_qr", title: { en: "One more" }, points: 1 },
        key(),
      );
      expect(refused.json()).toMatchObject({ code: "limit_reached", details: { limit: 300 } });
    });
  });

  describe("the event in the path", () => {
    it("never reaches a category or quest of another event", async () => {
      const s = await newEvent();
      const other = await newEvent();
      const theirs = await addQuest(other);
      for (const [method, path, payload] of [
        ["PATCH", `/quests/${theirs.id}`, { points: 1 }],
        ["DELETE", `/quests/${theirs.id}`, undefined],
        ["PATCH", `/categories/${other.general}`, { name: { en: "x" } }],
        ["DELETE", `/categories/${other.general}`, undefined],
        ["PUT", `/categories/${other.general}/quests/order`, { ids: [theirs.id] }],
      ] as const) {
        const response = await call(method, `${s.base}${path}`, s.cookie, payload);
        expect(response.statusCode, `${method} ${path}`).toBe(404);
      }
    });

    it("never edits a live event's quest through a draft event's path, even for a member of both", async () => {
      const s = await newEvent();
      const [live] = await owner<{ id: string }>(
        "INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at) VALUES ($1, 'LIVEQB1', 'Live', 'live', now() - interval '1 hour', now() + interval '1 day') RETURNING id",
        [s.orgId],
      );
      const [general] = await owner<{ id: string }>("SELECT id FROM category WHERE event_id = $1", [
        live?.id,
      ]);
      const [quest] = await owner<{ id: string }>(
        "INSERT INTO quest (event_id, category_id, type, title_en, points) VALUES ($1, $2, 'scan_qr', 'Live one', 5) RETURNING id",
        [live?.id, general?.id],
      );
      const response = await call("PATCH", `${s.base}/quests/${quest?.id}`, s.cookie, {
        points: 500,
      });
      expect(response.statusCode).toBe(404);
      expect(await owner("SELECT points FROM quest WHERE id = $1", [quest?.id])).toEqual([
        { points: 5 },
      ]);
    });

    it("answers 404 for a change to another organizer's event", async () => {
      const s = await newEvent();
      const other = await newEvent();
      const into = `/v1/organizers/${s.orgId}/events/${other.eventId}`;
      for (const [path, payload] of [
        ["/categories", { name: { en: "x" } }],
        ["/quests", { categoryId: other.general, type: "scan_qr", title: { en: "x" }, points: 1 }],
      ] as const) {
        expect((await call("POST", `${into}${path}`, s.cookie, payload, key())).statusCode).toBe(
          404,
        );
      }
    });

    it("answers 404 for an event outside a limited editor's limit", async () => {
      const s = await newEvent();
      const other = await call("POST", `/v1/organizers/${s.orgId}/events`, s.cookie, EVENT, key());
      const otherId = other.json<{ event: { id: string } }>().event.id;
      const limited = await memberOf(s.orgId, "editor", [otherId]);
      expect((await call("GET", `${s.base}/quests`, limited)).statusCode).toBe(404);
      expect(
        (await call("GET", `/v1/organizers/${s.orgId}/events/${otherId}/quests`, limited))
          .statusCode,
      ).toBe(200);
    });
  });

  describe("a live event (FR-1007)", () => {
    it("needs a confirmation for edits, reorders and deletes, but not to add", async () => {
      const s = await newEvent();
      const quest = await addQuest(s);
      await setStatus(s.eventId, "live", "-1 hour", "1 day");
      await addQuest(s);
      await addCategory(s, "Late addition");
      const asks = [
        ["PATCH", `/quests/${quest.id}`, { points: 20 }],
        ["DELETE", `/quests/${quest.id}`, {}],
        ["PATCH", `/categories/${s.general}`, { name: { en: "Main" } }],
        ["PUT", `/categories/order`, { ids: [] }],
        ["DELETE", `/categories/${s.general}`, {}],
        ["PUT", `/categories/${s.general}/quests/order`, { ids: [] }],
      ] as const;
      for (const [method, path, payload] of asks) {
        const response = await call(method, `${s.base}${path}`, s.cookie, payload);
        expect(response.json(), `${method} ${path}`).toMatchObject({ code: "confirm_required" });
      }
      const confirmed = await call("PATCH", `${s.base}/quests/${quest.id}`, s.cookie, {
        points: 20,
        confirm: true,
      });
      expect(confirmed.json()).toMatchObject({ quest: { points: 20 } });
    });
  });

  describe("an ended event", () => {
    it("still shows its quests but changes nothing", async () => {
      const s = await newEvent();
      const quest = await addQuest(s);
      await setStatus(s.eventId, "ended", "-2 days", "-1 day");
      expect((await s.builder()).categories[0]?.quests).toHaveLength(1);
      for (const [method, path, payload] of [
        [
          "POST",
          "/quests",
          { categoryId: s.general, type: "scan_qr", title: { en: "x" }, points: 1 },
        ],
        ["PATCH", `/quests/${quest.id}`, { points: 1, confirm: true }],
        ["POST", "/categories", { name: { en: "x" } }],
      ] as const) {
        const response = await call(method, `${s.base}${path}`, s.cookie, payload, key());
        expect(response.json(), `${method} ${path}`).toMatchObject({ code: "event_closed" });
      }
    });
  });
});
