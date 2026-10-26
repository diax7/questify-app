import { randomUUID } from "node:crypto";
import { MESSAGES } from "@questify/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SOUVENIR_IN_USE } from "#src/auth/http-errors";
import { souvenirFixture } from "#test/support/souvenirs";
import { TEST_DATABASE_URL } from "#test/support/test-db";
import {
  createStaff,
  signInFully,
  startApp,
  withSession,
  browserHeaders,
  type TestApp,
} from "#test/support/auth-app";

describe.skipIf(TEST_DATABASE_URL === undefined)("souvenir HTTP contracts", () => {
  let f: Awaited<ReturnType<typeof souvenirFixture>>;
  let app: TestApp;
  let cookie: string;
  let base: string;
  let actor: { organizerId: string; staffUserId: string };
  beforeAll(async () => {
    f = await souvenirFixture();
    const staff = await createStaff(f.db.owner, { email: "souvenirs@team.test" });
    await f.db.owner.query("UPDATE organizer_member SET staff_user_id=$2 WHERE staff_user_id=$1", [
      f.staff,
      staff,
    ]);
    actor = { organizerId: f.ids.orgA, staffUserId: staff };
    app = await startApp(f.db);
    cookie = await signInFully(app, "souvenirs@team.test");
    base = `/v1/organizers/${f.ids.orgA}/events/${f.ids.eventA}/souvenirs`;
  });
  afterAll(async () => {
    await app.close();
    await f.close();
  });
  const post = (path: string, payload: unknown, key = randomUUID()) =>
    app.app.inject({
      method: "POST",
      url: path,
      headers: withSession(cookie, { "idempotency-key": key, "content-type": "application/json" }),
      payload: JSON.stringify(payload),
    });
  it("creates once, replays the same response, rejects changed-body key reuse and marks private reads", async () => {
    const key = randomUUID();
    const first = await post(base, f.body, key);
    expect(first.statusCode).toBe(201);
    expect(first.json().rules).toHaveLength(1);
    const replay = await post(base, f.body, key);
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect((await post(base, { ...f.body, audience: "all" }, key)).statusCode).toBe(422);
    const list = await app.app.inject({ url: base, headers: withSession(cookie) });
    expect(list.headers["cache-control"]).toBe("private, no-store");
  });
  it("refuses forged recipients/source, unknown art and missing bilingual names before any write", async () => {
    for (const body of [
      { ...f.body, playerId: f.ids.playerB },
      { ...f.body, source: "level" },
      { ...f.body, visualKey: "https://private.test/art" },
      { ...f.body, name: { en: "Only English" } },
    ]) {
      expect((await post(base, body)).statusCode).toBe(400);
    }
    expect((await f.db.owner.query("SELECT * FROM souvenir_rule")).rows).toHaveLength(1);
  });
  it("refuses control and direction characters in public names over HTTP and in SQL", async () => {
    for (const ar of ["تذكار\u202Eالرحلة", "تذكار\u0000الرحلة"]) {
      expect((await post(base, { ...f.body, name: { ar, en: "Journey" } })).statusCode).toBe(400);
    }
    await expect(
      f.run(actor, "SELECT souvenir_save($1,NULL,$2,$3)", [
        f.ids.eventA,
        { ...f.body, name: { ar: "تذكار\u202Eالرحلة", en: "Journey" } },
        randomUUID(),
      ]),
    ).rejects.toMatchObject({ code: "SV422" });
    // JSON text cannot hold a NUL: SQL raises 22P05, which souvenirRefusal answers as 400 (its unit test).
    await expect(
      f.run(actor, "SELECT souvenir_save($1,NULL,$2,$3)", [
        f.ids.eventA,
        { ...f.body, name: { ar: "تذكار\u0000", en: "Journey" } },
        randomUUID(),
      ]),
    ).rejects.toMatchObject({ code: "22P05" });
    expect((await f.db.owner.query("SELECT * FROM souvenir_rule")).rows).toHaveLength(1);
    const arabic = await post(base, {
      ...f.body,
      name: { ar: "بطل الرحلة 2026", en: "Journey hero" },
    });
    expect(arabic.statusCode).toBe(201);
    const kept = arabic
      .json()
      .rules.find((r: { item: { name: { en: string } } }) => r.item.name.en === "Journey hero");
    expect(kept.item.name.ar).toBe("بطل الرحلة 2026");
    const removed = await app.app.inject({
      method: "DELETE",
      url: `${base}/${kept.id}`,
      headers: withSession(cookie, { "idempotency-key": randomUUID() }),
    });
    expect(removed.statusCode).toBe(200);
  });
  it("refuses deleting a draft event with souvenirs in both languages, then deletes it without them", async () => {
    const draft = (
      await f.db.owner.query(
        "INSERT INTO event(organizer_id,join_code,name_en) VALUES($1,$2,'Draft with souvenirs') RETURNING id",
        [f.ids.orgA, randomUUID().slice(0, 8)],
      )
    ).rows[0].id as string;
    const draftBase = `/v1/organizers/${f.ids.orgA}/events/${draft}`;
    const created = await post(`${draftBase}/souvenirs`, f.body);
    expect(created.statusCode).toBe(201);
    const remove = () =>
      app.app.inject({ method: "DELETE", url: draftBase, headers: withSession(cookie) });
    const refused = await remove();
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      code: "souvenir_data",
      message: MESSAGES["souvenir.eventDeleteError"],
    });
    expect(
      (await f.db.owner.query("SELECT count(*)::int AS n FROM event WHERE id=$1", [draft])).rows[0]
        .n,
    ).toBe(1);
    const rule = created.json().rules[0].id as string;
    const cleared = await app.app.inject({
      method: "DELETE",
      url: `${draftBase}/souvenirs/${rule}`,
      headers: withSession(cookie, { "idempotency-key": randomUUID() }),
    });
    expect(cleared.statusCode).toBe(200);
    expect((await remove()).statusCode).toBe(204);
  });
  it("requires authentication, origin and idempotency key, conceals other tenant/event IDs", async () => {
    expect(
      (
        await app.app.inject({
          method: "POST",
          url: base,
          headers: browserHeaders(),
          payload: f.body,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.app.inject({
          method: "POST",
          url: base,
          headers: withSession(cookie),
          payload: f.body,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.app.inject({
          method: "POST",
          url: base,
          headers: withSession(cookie, {
            origin: "https://wrong.test",
            "idempotency-key": randomUUID(),
          }),
          payload: f.body,
        })
      ).statusCode,
    ).toBe(403);
    const foreign = base.replace(f.ids.eventA, f.ids.eventB);
    expect((await post(foreign, f.body)).statusCode).toBe(404);
    expect((await post(base.replace(f.ids.orgA, f.ids.orgB), f.body)).statusCode).toBe(404);
  });
  it("activates with reviewed targets and processes grants with aggregate status, then refuses edits", async () => {
    const current = await app.app.inject({ url: base, headers: withSession(cookie) });
    const id = current.json().rules[0].id as string;
    expect((await post(`${base}/${id}/activate`, { targetIds: [] })).statusCode).toBe(200);
    const granted = await post(`${base}/process`, {});
    expect(granted.statusCode).toBe(200);
    expect(granted.json()).toMatchObject({ status: "complete", granted: 1, due: 0 });
    expect((await f.owned()).rows).toHaveLength(1);
    // A finished pass is gone; another request runs one more pass and completes again.
    const again = await post(`${base}/process`, {});
    expect(again.json()).toMatchObject({ status: "complete", granted: 0, due: 0, scanning: 0 });
    expect((await f.db.owner.query("SELECT * FROM souvenir_scan")).rows).toEqual([]);
    const edit = await app.app.inject({
      method: "PATCH",
      url: `${base}/${id}`,
      headers: withSession(cookie, { "idempotency-key": randomUUID() }),
      payload: f.body,
    });
    expect(edit.statusCode).toBe(409);
    expect(edit.json().code).toBe("souvenir_locked");
  });
  it("accepts reviewed targets for a full300-quest event without a body-limit refusal", async () => {
    await f.db.owner.query(
      `INSERT INTO quest(event_id,category_id,type,title_en,points,type_config)
      SELECT $1,$2,'enter_code','Bulk '||i,10,'{"code":"ABC"}' FROM generate_series(1,299) i`,
      [f.ids.eventA, f.category],
    );
    const created = await post(base, {
      ...f.body,
      audience: "all",
      name: { ar: "كل الرحلة", en: "Full journey" },
    });
    expect(created.statusCode).toBe(201);
    const rule = created.json().rules.find((r: { audience: string }) => r.audience === "all");
    expect(rule.targetIds).toHaveLength(300);
    expect(
      (await post(`${base}/${rule.id}/activate`, { targetIds: rule.targetIds })).statusCode,
    ).toBe(200);
  });
  it("lets a new draft be edited and deleted without issuing an item", async () => {
    const created = await post(base, { ...f.body, kind: "title", visualKey: null });
    const id = created.json().rules.find((r: { item: { kind: string } }) => r.item.kind === "title")
      .id as string;
    const edit = await app.app.inject({
      method: "PATCH",
      url: `${base}/${id}`,
      headers: withSession(cookie, { "idempotency-key": randomUUID() }),
      payload: {
        ...f.body,
        kind: "title",
        visualKey: null,
        name: { ar: "رفيق الرحلة", en: "Journey companion" },
      },
    });
    expect(edit.statusCode).toBe(200);
    const removed = await app.app.inject({
      method: "DELETE",
      url: `${base}/${id}`,
      headers: withSession(cookie, { "idempotency-key": randomUUID() }),
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().rules.some((r: { id: string }) => r.id === id)).toBe(false);
  });
  it.each(["create", "edit", "delete", "activate", "stop", "process"] as const)(
    "reauthorizes event scope before cached %s replay",
    async (operation) => {
      const email = `cache-${operation}@team.test`;
      const editor = await createStaff(f.db.owner, { email });
      await f.db.owner.query(
        "INSERT INTO organizer_member(organizer_id,staff_user_id,role,event_scope) VALUES($1,$2,'editor',ARRAY[$3::uuid])",
        [f.ids.orgA, editor, f.ids.eventA],
      );
      const editorCookie = await signInFully(app, email);
      const other = (
        await f.db.owner.query(
          "INSERT INTO event(organizer_id,join_code,name_en,starts_at,ends_at) VALUES($1,$2,'Other event',now(),now()+interval '1 day') RETURNING id",
          [f.ids.orgA, randomUUID().slice(0, 8)],
        )
      ).rows[0].id;
      const body = { ...f.body, name: { ar: "تذكار خاص", en: `Cache probe ${operation}` } };
      const created = await post(base, body);
      const rule = created
        .json()
        .rules.find((r: { item: { name: { en: string } } }) => r.item.name.en === body.name.en);
      if (operation === "stop") await post(`${base}/${rule.id}/activate`, { targetIds: [] });
      const method = operation === "edit" ? "PATCH" : operation === "delete" ? "DELETE" : "POST";
      const path =
        operation === "create"
          ? base
          : operation === "process"
            ? `${base}/process`
            : `${base}/${rule.id}${operation === "edit" || operation === "delete" ? "" : `/${operation}`}`;
      const payload =
        operation === "create" || operation === "edit"
          ? body
          : operation === "activate"
            ? { targetIds: [] }
            : {};
      const key = randomUUID();
      const request = () =>
        app.app.inject({
          method,
          url: path,
          headers: withSession(editorCookie, { "idempotency-key": key }),
          payload,
        });
      const first = await request();
      expect(first.statusCode).toBe(operation === "create" ? 201 : 200);
      const replay = await request();
      expect(replay.headers["idempotent-replayed"]).toBe("true");
      expect(replay.body).toBe(first.body);
      await f.db.owner.query(
        "UPDATE organizer_member SET event_scope=ARRAY[$3::uuid] WHERE organizer_id=$1 AND staff_user_id=$2",
        [f.ids.orgA, editor, other],
      );
      expect(
        (await app.app.inject({ url: base, headers: withSession(editorCookie) })).statusCode,
      ).toBe(404);
      const before = (await f.db.owner.query("SELECT count(*) AS n FROM souvenir_command")).rows[0]
        .n;
      const denied = await request();
      expect(denied.statusCode).toBe(404);
      expect(denied.headers["idempotent-replayed"]).toBeUndefined();
      expect(denied.json().code).toBe("not_found");
      expect(denied.body).not.toContain("Cache probe");
      expect((await f.db.owner.query("SELECT count(*) AS n FROM souvenir_command")).rows[0].n).toBe(
        before,
      );
    },
  );

  const builder = (path: string, payload: unknown) =>
    app.app.inject({
      method: "DELETE",
      url: `/v1/organizers/${f.ids.orgA}/events/${f.ids.eventA}${path}`,
      headers: withSession(cookie),
      payload: payload as Record<string, unknown>,
    });
  const refusal = async (path: string, payload: unknown) => {
    const answer = await builder(path, payload);
    return [answer.statusCode, answer.json().code, answer.json().message];
  };
  const exists = async (table: "category" | "quest", id: string) =>
    (await f.db.owner.query(`SELECT 1 FROM ${table} WHERE id=$1`, [id])).rowCount === 1;
  const categoryWithSouvenir = async (name: string) => {
    const category = (
      await f.db.owner.query("INSERT INTO category(event_id,name_en) VALUES($1,$2) RETURNING id", [
        f.ids.eventA,
        name,
      ])
    ).rows[0].id as string;
    const quest = (
      await f.db.owner.query(
        `INSERT INTO quest(event_id,category_id,type,title_en,points,type_config)
        VALUES($1,$2,'enter_code',$3,10,'{"code":"ABC"}') RETURNING id`,
        [f.ids.eventA, category, `${name} quest`],
      )
    ).rows[0].id as string;
    const created = await post(base, {
      ...f.body,
      audience: "category",
      categoryId: category,
      name: { ar: "تذكار الفئة", en: name },
    });
    const rule = created
      .json()
      .rules.find((r: { item: { name: { en: string } } }) => r.item.name.en === name).id as string;
    return { category, quest, rule };
  };

  it("refuses deleting a category a souvenir draft names with 409 souvenir_in_use, then deletes it", async () => {
    const { category, quest, rule } = await categoryWithSouvenir("Draft named");
    const remove = () => builder(`/categories/${category}`, { quests: "delete", confirm: true });
    const refused = await remove();
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      code: "souvenir_in_use",
      message: SOUVENIR_IN_USE.category,
    });
    expect([await exists("category", category), await exists("quest", quest)]).toEqual([
      true,
      true,
    ]);
    const cleared = await app.app.inject({
      method: "DELETE",
      url: `${base}/${rule}`,
      headers: withSession(cookie, { "idempotency-key": randomUUID() }),
    });
    expect(cleared.statusCode).toBe(200);
    expect((await remove()).statusCode).toBe(204);
  });
  it("refuses deleting a quest an activated souvenir requires, alone or with its category", async () => {
    const { category, quest, rule } = await categoryWithSouvenir("Frozen target");
    expect((await post(`${base}/${rule}/activate`, { targetIds: [quest] })).statusCode).toBe(200);
    expect(await refusal(`/quests/${quest}`, { confirm: true })).toEqual([
      409,
      "souvenir_in_use",
      SOUVENIR_IN_USE.quest,
    ]);
    expect(await refusal(`/categories/${category}`, { quests: "delete", confirm: true })).toEqual([
      409,
      "souvenir_in_use",
      SOUVENIR_IN_USE.categoryQuest,
    ]);
    expect(
      await refusal(`/categories/${category}`, { quests: "move", to: f.category, confirm: true }),
    ).toEqual([409, "souvenir_in_use", SOUVENIR_IN_USE.category]);
    expect([await exists("category", category), await exists("quest", quest)]).toEqual([
      true,
      true,
    ]);
  });
});
