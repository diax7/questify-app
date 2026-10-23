import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createStaff,
  freshIp,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Row = Record<string, unknown>;
type Field = { id: string; kind: string; options: { id: string; en: string | null }[] | null };
type Setup = { version: number; fields: Field[] };
type Item = { id: string; audience: Row | null; members: number | null; removed: boolean };
type View = {
  fields: Field[];
  tags: { tag: string; guests: number }[];
  categories: Item[];
  rewards: Item[];
};

/**
 * Targeting over HTTP (T-220, FR-1708): choice fields on the card and the join, guest tags, the "Who sees what" panel,
 * the refusals a player outside the audience meets, and the field save that a rule or an answer holds back.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("targeting over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let organizer: string;
  let otherOrganizer: string;
  let ownerCookie: string;
  let editorCookie: string;
  let otherCookie: string;
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
    organizer = await made("target-org");
    otherOrganizer = await made("target-other");
    const ownerId = await createStaff(db.owner, { email: "owner@target.test" });
    const editorId = await createStaff(db.owner, { email: "editor@target.test" });
    const otherId = await createStaff(db.owner, { email: "owner@elsewhere.test" });
    await db.owner.query(
      `INSERT INTO organizer_member (organizer_id, staff_user_id, role)
       VALUES ($1, $2, 'owner'), ($1, $3, 'editor'), ($4, $5, 'owner')`,
      [organizer, ownerId, editorId, otherOrganizer, otherId],
    );
    ownerCookie = await signInFully(test, "owner@target.test");
    editorCookie = await signInFully(test, "editor@target.test");
    otherCookie = await signInFully(test, "owner@elsewhere.test");
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  const dash = (
    method: "GET" | "PUT" | "POST",
    path: string,
    payload?: object,
    cookie = ownerCookie,
    org = organizer,
  ) =>
    test.app.inject({
      method,
      url: `/v1/organizers/${org}${path}`,
      headers: withSession(cookie),
      ...(payload === undefined ? {} : { payload }),
    });

  /** A live event with a Section choice field, a category with one code quest, and a reward. */
  const newEvent = async () => {
    counter += 1;
    const code = `TGT${counter}`;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at, welcome_points)
       VALUES ($1, $2, 'Target Fest', 'live', now() - interval '1 hour', now() + interval '2 days', 100)
       RETURNING id`,
      [organizer, code],
    );
    const id = event?.id ?? "";
    const saved = await dash("PUT", `/events/${id}/join/fields`, {
      version: 0,
      fields: [
        {
          kind: "custom",
          label: { ar: "القسم", en: "Section" },
          required: true,
          options: [
            { ar: "نساء", en: "Women" },
            { ar: "رجال", en: "Men" },
          ],
        },
      ],
    });
    expect(saved.statusCode).toBe(200);
    const field = saved.json<Setup>().fields[0] as Field;
    const [category] = await owner<{ id: string }>(
      "INSERT INTO category (event_id, name_en) VALUES ($1, 'Ladies') RETURNING id",
      [id],
    );
    const [quest] = await owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
       VALUES ($1, $2, 'enter_code', 'Booth', 10, '{"code": "ABC123"}') RETURNING id`,
      [id, category?.id],
    );
    const [reward] = await owner<{ id: string }>(
      "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, 'experience', 'Spa', 50, 9) RETURNING id",
      [id],
    );
    const option = (en: string) => field.options?.find((entry) => entry.en === en)?.id ?? "";
    return {
      id,
      code,
      field: field.id,
      women: option("Women"),
      men: option("Men"),
      category: category?.id ?? "",
      quest: quest?.id ?? "",
      reward: reward?.id ?? "",
    };
  };
  type Event = Awaited<ReturnType<typeof newEvent>>;

  const newPlayer = async (phone?: string) => {
    counter += 1;
    const [made] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`target_http_${counter}`],
    );
    const id = made?.id ?? "";
    await owner("INSERT INTO player_contact (player_id, phone_e164, email) VALUES ($1, $2, $3)", [
      id,
      phone ?? null,
      phone === undefined ? `th${counter}@example.com` : null,
    ]);
    const token = randomBytes(32).toString("base64url");
    await owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [id, createHash("sha256").update(token).digest()],
    );
    return { id, token };
  };

  const player = (token: string, method: "GET" | "POST", url: string, payload?: object) =>
    test.app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        "x-forwarded-for": freshIp(),
        "idempotency-key": randomUUID(),
      },
      ...(payload === undefined ? {} : { payload }),
    });

  const joined = async (event: Event, option: string, phone?: string) => {
    const made = await newPlayer(phone);
    const answer = await player(made.token, "POST", "/v1/join", {
      via: "code",
      cardVersion: "0.2",
      joinCode: event.code,
      answers: { [event.field]: option },
    });
    expect(answer.statusCode).toBe(200);
    return made;
  };

  const target = (
    event: Event,
    path: "categories" | "rewards",
    item: string,
    rule: object | null,
  ) => dash("PUT", `/events/${event.id}/audience/${path}/${item}`, { rule });

  it("shows a choice field's options on the card and takes only an option id", async () => {
    const event = await newEvent();
    const card = await test.app.inject({ method: "GET", url: `/v1/public/events/${event.code}` });
    expect(
      card.json<{ event: { join: { fields: Field[] } } }>().event.join.fields[0]?.options,
    ).toEqual([
      { id: event.women, ar: "نساء", en: "Women" },
      { id: event.men, ar: "رجال", en: "Men" },
    ]);
    const made = await newPlayer();
    const typed = await player(made.token, "POST", "/v1/join", {
      via: "code",
      cardVersion: "0.2",
      joinCode: event.code,
      answers: { [event.field]: "Women" },
    });
    expect(typed.statusCode).toBe(422);
    expect(typed.json()).toMatchObject({
      code: "invalid_join_answers",
      details: { field: event.field },
    });
  });

  it("sets rules from the panel, counts the reach and refuses a player outside the audience", async () => {
    const event = await newEvent();
    const her = await joined(event, event.women);
    const him = await joined(event, event.men);
    const rule = { kind: "answer", fieldId: event.field, values: [event.women] };
    const set = await target(event, "categories", event.category, rule);
    expect(set.statusCode).toBe(200);
    expect(set.json()).toEqual({
      item: {
        id: event.category,
        name: { ar: null, en: "Ladies" },
        audience: rule,
        members: 1,
        removed: false,
      },
    });
    expect((await target(event, "rewards", event.reward, rule)).statusCode).toBe(200);

    const quests = async (token: string) =>
      (await player(token, "GET", `/v1/events/${event.id}/quests`)).json<{ categories: Row[] }>()
        .categories;
    expect(await quests(her.token)).toHaveLength(1);
    expect(await quests(him.token)).toEqual([]);
    const refused = await player(him.token, "POST", `/v1/quests/${event.quest}/complete`, {
      proof: { type: "code", code: "ABC123" },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({
      code: "quest_not_open",
      details: { reason: "not_for_you" },
    });
    const done = await player(her.token, "POST", `/v1/quests/${event.quest}/complete`, {
      proof: { type: "code", code: "ABC123" },
    });
    expect(done.statusCode).toBe(200);
    expect(
      (await player(him.token, "POST", `/v1/rewards/${event.reward}/reserve`)).statusCode,
    ).toBe(404);

    const view = (
      await dash("GET", `/events/${event.id}/audience`, undefined, editorCookie)
    ).json<View>();
    expect(view.fields).toEqual([
      {
        id: event.field,
        label: { ar: "القسم", en: "Section" },
        options: [
          { id: event.women, ar: "نساء", en: "Women" },
          { id: event.men, ar: "رجال", en: "Men" },
        ],
      },
    ]);
    expect(view.categories.filter((item) => item.audience !== null)).toEqual([
      {
        id: event.category,
        name: { ar: null, en: "Ladies" },
        audience: rule,
        members: 1,
        removed: false,
      },
    ]);
    expect(view.rewards[0]).toMatchObject({ id: event.reward, audience: rule, members: 1 });
    expect((await target(event, "categories", event.category, null)).json()).toMatchObject({
      item: { audience: null, members: null },
    });
  });

  it("refuses a rule that is not valid, another organizer's event and an unknown item", async () => {
    const event = await newEvent();
    const bad = await target(event, "categories", event.category, {
      kind: "answer",
      fieldId: event.field,
      values: ["nope"],
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({ code: "invalid_audience" });
    expect(
      (await target(event, "categories", event.category, { kind: "tag", values: [] })).statusCode,
    ).toBe(400);
    expect((await target(event, "rewards", event.category, null)).statusCode).toBe(404);
    const theirs = await dash(
      "PUT",
      `/events/${event.id}/audience/categories/${event.category}`,
      { rule: null },
      otherCookie,
      otherOrganizer,
    );
    expect(theirs.statusCode).toBe(404);
    expect(
      (await dash("GET", `/events/${event.id}/audience`, undefined, otherCookie, otherOrganizer))
        .statusCode,
    ).toBe(404);
  });

  it("holds back a field save that would drop an option a rule or an answer names", async () => {
    const event = await newEvent();
    await target(event, "rewards", event.reward, {
      kind: "answer",
      fieldId: event.field,
      values: [event.women],
    });
    const setup = (await dash("GET", `/events/${event.id}/join`)).json<Setup>();
    const without = (options: object[]) =>
      dash("PUT", `/events/${event.id}/join/fields`, {
        version: setup.version,
        fields: [
          { id: event.field, kind: "custom", label: { en: "Section" }, required: true, options },
        ],
      });
    const ruled = await without([{ id: event.men, en: "Men" }, { en: "Kids" }]);
    expect(ruled.statusCode).toBe(409);
    expect(ruled.json()).toMatchObject({
      code: "join_field_in_use",
      details: { reason: "rules", categories: [], rewards: [{ ar: null, en: "Spa" }] },
    });
    const deleted = await dash("PUT", `/events/${event.id}/join/fields`, {
      version: setup.version,
      fields: [],
    });
    expect(deleted.json()).toMatchObject({
      code: "join_field_in_use",
      details: { reason: "rules" },
    });

    await target(event, "rewards", event.reward, null);
    await joined(event, event.men);
    const answered = await without([{ id: event.women, en: "Women" }, { en: "Kids" }]);
    expect(answered.json()).toMatchObject({
      code: "join_field_in_use",
      details: { reason: "answers" },
    });
    const relabelled = await without([
      { id: event.women, en: "Ladies" },
      { id: event.men, en: "Men" },
      { en: "Kids" },
    ]);
    expect(relabelled.statusCode).toBe(200);
    expect(relabelled.json<Setup>().fields[0]?.options?.map((option) => option.en)).toEqual([
      "Ladies",
      "Men",
      "Kids",
    ]);
  });

  it("tags an upload, retags listed guests, and targets a reward by tag", async () => {
    const event = await newEvent();
    const first = await dash("POST", `/events/${event.id}/join/guests`, {
      lines: ["0511112222", "0511113333"],
      tag: " VIP ",
    });
    expect(first.json()).toMatchObject({ added: 2, existing: 0, tagged: 0, total: 2 });
    const again = await dash("POST", `/events/${event.id}/join/guests`, {
      lines: ["0511113333", "0511114444"],
      tag: "Speaker",
    });
    expect(again.json()).toMatchObject({ added: 1, existing: 1, tagged: 1, total: 3 });
    expect(
      (
        await dash("POST", `/events/${event.id}/join/guests`, {
          lines: ["0511114444"],
          tag: "x".repeat(31),
        })
      ).statusCode,
    ).toBe(400);
    const guests = (await dash("GET", `/events/${event.id}/join/guests`)).json<{
      guests: { tag: string }[];
    }>();
    expect(guests.guests.map((guest) => guest.tag).toSorted()).toEqual([
      "Speaker",
      "Speaker",
      "VIP",
    ]);
    const audit = await owner<{ after: Row }>(
      "SELECT after FROM audit_log WHERE event_id = $1 AND action = 'event.guests.add' ORDER BY id",
      [event.id],
    );
    expect(JSON.stringify(audit)).not.toMatch(/VIP|Speaker/);

    const vip = await joined(event, event.men, "+966511112222");
    const plain = await joined(event, event.men);
    await target(event, "rewards", event.reward, { kind: "tag", values: ["vip"] });
    const view = (await dash("GET", `/events/${event.id}/audience`)).json<View>();
    expect(view.tags).toEqual([
      { tag: "Speaker", guests: 2 },
      { tag: "VIP", guests: 1 },
    ]);
    expect(view.rewards[0]).toMatchObject({ members: 1 });
    const shop = async (token: string) =>
      (await player(token, "GET", `/v1/events/${event.id}/shop`)).json<{ rewards: Row[] }>()
        .rewards;
    expect(await shop(vip.token)).toHaveLength(1);
    expect(await shop(plain.token)).toEqual([]);
  });
});
