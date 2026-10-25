import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  beforeAll(async () => {
    f = await souvenirFixture();
    const staff = await createStaff(f.db.owner, { email: "souvenirs@team.test" });
    await f.db.owner.query("UPDATE organizer_member SET staff_user_id=$2 WHERE staff_user_id=$1", [
      f.staff,
      staff,
    ]);
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
});
