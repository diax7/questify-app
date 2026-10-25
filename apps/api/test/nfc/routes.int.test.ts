import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTagCodeKey, tagCode } from "#src/quests/qr";
import { createSettingsService, type SettingsService } from "#src/settings/service";
import {
  DASHBOARD_ORIGIN,
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Row = Record<string, unknown>;
type Person = Readonly<{ id: string; token: string }>;
type Prepared = Readonly<{ tagId: string; url: string; ticket: string }>;

const UID = "04a1b2c3d4e5f6";
const codeOf = (response: { statusCode: number; json: () => { code?: string } }) => [
  response.statusCode,
  response.json().code,
];
const tokenOf = (url: string) => url.slice(url.lastIndexOf("/") + 1);

/**
 * NFC tags over HTTP (T-308): prepare, confirm and the operator's page; a tap and its answer; the team's Tags panel,
 * Move, Revoke and Revoke all; every refusal's answer; the ticket (CTO B), a second confirm (CTO C), the platform
 * reason (CTO A), the limits, the switch, and that no token is logged.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("NFC tags over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let settingsPool: Pool;
  let settings: SettingsService;
  let organizer = "";
  let ownerCookie = "";
  let counter = 0;
  const logs: string[] = [];

  beforeAll(async () => {
    db = await createTestDatabase();
    settingsPool = new Pool({ connectionString: db.appUrl, max: 2 });
    settings = createSettingsService({ pool: settingsPool });
    test = await startApp(
      db,
      { level: "debug", stream: { write: (line: string) => void logs.push(line) } },
      {},
      { settings },
    );
    organizer =
      (
        await db.owner.query<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ('nfc-org', 'nfc-org') RETURNING id",
        )
      ).rows[0]?.id ?? "";
    const id = await createStaff(db.owner, { email: "owner@nfc.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [organizer, id],
    );
    ownerCookie = await signInFully(test, "owner@nfc.test");
  });
  afterAll(async () => {
    await test.close();
    await settingsPool.end();
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const newEvent = async (): Promise<string> => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Tag Fest', 'live', now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
      [organizer, `NFCH${counter}`],
    );
    return event?.id ?? "";
  };
  const newQuest = async (event: string, verification = ["quest_qr", "nfc"]) =>
    (
      await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, verification)
         SELECT $1, id, 'scan_qr', 'Gate', 10, 100, $2 FROM category WHERE event_id = $1 LIMIT 1 RETURNING id`,
        [event, verification],
      )
    )[0]?.id ?? "";
  const newPerson = async (event: string, role: "player" | "operator"): Promise<Person> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`nfc_http_${counter}`],
    );
    const id = player?.id ?? "";
    const token = randomBytes(32).toString("base64url");
    await owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [id, createHash("sha256").update(token).digest()],
    );
    await owner(
      role === "player"
        ? "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)"
        : "INSERT INTO staff_assignment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)",
      [organizer, event, id],
    );
    return { id, token };
  };
  const call = (
    method: "GET" | "POST",
    path: string,
    who: Person,
    payload?: object,
    key: string = randomUUID(),
  ) =>
    test.app.inject({
      method,
      url: path,
      headers: { authorization: `Bearer ${who.token}`, "idempotency-key": key },
      ...(payload === undefined ? {} : { payload }),
    });
  const dashboard = (method: "GET" | "POST" | "DELETE", path: string, payload?: object) =>
    test.app.inject({
      method,
      url: `/v1/organizers/${organizer}${path}`,
      headers: withSession(ownerCookie, { "idempotency-key": randomUUID() }),
      ...(payload === undefined ? {} : { payload }),
    });
  const prepare = (op: Person, event: string, quest: string) =>
    call("POST", `/v1/operator/events/${event}/quests/${quest}/nfc-tags/prepare`, op);
  const confirm = (op: Person, event: string, quest: string, body: Row, key?: string) =>
    call("POST", `/v1/operator/events/${event}/quests/${quest}/nfc-tags`, op, body, key);
  /** Prepares and confirms a tag; answers its token. */
  const writeTag = async (op: Person, event: string, quest: string, uid = UID) => {
    const prepared = (await prepare(op, event, quest)).json<Prepared>();
    const made = await confirm(op, event, quest, {
      code: tokenOf(prepared.url),
      ticket: prepared.ticket,
      uid,
      label: "Gate",
      locked: true,
    });
    expect(made.statusCode, made.body).toBe(201);
    return tokenOf(prepared.url);
  };
  const tap = (who: Person, code: string, extra: Row = {}, key?: string) =>
    call("POST", "/v1/taps", who, { code, uid: UID, platform: "android", ...extra }, key);
  const withFeatures = async (features: Row, work: () => Promise<void>) => {
    await owner("INSERT INTO platform_setting (key, value) VALUES ('features', $1)", [
      JSON.stringify(features),
    ]);
    settings.forget();
    try {
      await work();
    } finally {
      await owner("DELETE FROM platform_setting WHERE key = 'features'");
      settings.forget();
    }
  };
  const withNfcOff = (work: () => Promise<void>) =>
    withFeatures({ nfcTags: { enabled: false } }, work);
  const entriesOf = (from: number, event: string) =>
    logs
      .slice(from)
      .map((line) => JSON.parse(line) as Row)
      .filter((entry) => entry["event"] === event);
  const usernameOf = async (who: Person) =>
    (await owner<{ username: string }>("SELECT username FROM player WHERE id = $1", [who.id]))[0]
      ?.username;
  const isoNow = expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);

  it("prepares, confirms, lists the operator's page, and a tap pays as a scan", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const op = await newPerson(event, "operator");
    const prepared = await prepare(op, event, quest);
    expect(prepared.statusCode).toBe(200);
    const body = prepared.json<Prepared>();
    expect(body.url).toMatch(new RegExp(`^${DASHBOARD_ORIGIN}/t/[A-Za-z0-9_-]{50}$`));
    expect(body.ticket).toMatch(/^[A-Za-z0-9_-]{114}$/);
    const made = await confirm(op, event, quest, {
      code: tokenOf(body.url),
      ticket: body.ticket,
      uid: UID.toUpperCase(),
      label: "Gate 1",
      locked: true,
    });
    expect(made.statusCode).toBe(201);
    expect(made.json()).toEqual({ tagId: body.tagId, questId: quest, replaced: null });
    const page = await call("GET", `/v1/operator/events/${event}/nfc-tags`, op);
    expect(page.json()).toMatchObject({
      quests: [{ id: quest, title: { ar: null, en: "Gate" }, tags: 1 }],
      tags: [{ id: body.tagId, questId: quest, label: "Gate 1", locked: true, status: "active" }],
    });

    const who = await newPerson(event, "player");
    const logged = logs.length;
    const paid = await tap(who, tokenOf(body.url));
    expect(paid.statusCode, paid.body).toBe(200);
    expect(paid.json()).toMatchObject({
      points: 10,
      occurrence: 1,
      score: 10,
      replayed: false,
      questId: quest,
      levelUp: null,
      bonus: null,
      boost: null,
    });
    expect(Object.keys(paid.json<Row>()).toSorted()).toEqual(
      [
        "balance",
        "bonus",
        "boost",
        "completionId",
        "firstBonus",
        "item",
        "levelUp",
        "occurrence",
        "points",
        "questId",
        "rank",
        "replayed",
        "score",
      ].toSorted(),
    );
    expect(logs.slice(logged).join("\n")).not.toContain(tokenOf(body.url));
    expect(entriesOf(logged, "nfc.tapped")).toMatchObject([{ questId: quest, replayed: "false" }]);
    const [tapRow] = await owner<{ uid_ok: boolean | null }>(
      "SELECT uid_ok FROM nfc_tap WHERE completion_id = $1",
      [paid.json<{ completionId: string }>().completionId],
    );
    expect(tapRow?.uid_ok).toBe(true);
  });

  it("refuses a confirm without its own ticket, a forged code, and a second confirm of one tag (CTO B, CTO C)", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const other = await newQuest(event);
    const op = await newPerson(event, "operator");
    const peer = await newPerson(event, "operator");
    const prepared = (await prepare(op, event, quest)).json<Prepared>();
    const body = { code: tokenOf(prepared.url), ticket: prepared.ticket, uid: UID, locked: true };
    const fieldOf = (response: Awaited<ReturnType<typeof confirm>>) => [
      response.statusCode,
      response.json<{ code: string; details: Row }>().code,
      response.json<{ details: Row }>().details["field"],
    ];
    expect(fieldOf(await confirm(peer, event, quest, body))).toEqual([
      422,
      "invalid_tag",
      "ticket",
    ]);
    expect(fieldOf(await confirm(op, event, other, body))).toEqual([422, "invalid_tag", "ticket"]);
    const unprepared = tagCode(createTagCodeKey("q".repeat(40)), randomUUID(), 1);
    expect(fieldOf(await confirm(op, event, quest, { ...body, code: unprepared }))).toEqual([
      422,
      "invalid_tag",
      "ticket",
    ]);
    expect(fieldOf(await confirm(op, event, quest, { ...body, code: "x".repeat(50) }))).toEqual([
      422,
      "invalid_tag",
      "code",
    ]);
    expect(fieldOf(await confirm(op, event, quest, { ...body, label: "x".repeat(41) }))).toEqual([
      422,
      "invalid_tag",
      "label",
    ]);
    expect(codeOf(await confirm(op, event, quest, { ...body, uid: "04a1" }))).toEqual([
      400,
      "invalid_request",
    ]);
    expect((await confirm(op, event, quest, body)).statusCode).toBe(201);
    expect(codeOf(await confirm(op, event, quest, body))).toEqual([409, "already_registered"]);
  });

  it("answers the write refusals: not an operator, ability off, no NFC", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const plain = await newQuest(event, ["quest_qr"]);
    const op = await newPerson(event, "operator");
    const stranger = await newPerson(event, "player");
    expect(codeOf(await prepare(stranger, event, quest))).toEqual([403, "not_operator"]);
    expect(codeOf(await prepare(op, event, plain))).toEqual([409, "not_nfc"]);
    expect(codeOf(await prepare(op, event, randomUUID()))).toEqual([404, "not_found"]);
    await owner("UPDATE staff_assignment SET abilities = '{scan_quests}' WHERE player_id = $1", [
      op.id,
    ]);
    expect(codeOf(await prepare(op, event, quest))).toEqual([403, "ability_off"]);
    expect(codeOf(await call("GET", `/v1/operator/events/${event}/nfc-tags`, op))).toEqual([
      403,
      "ability_off",
    ]);
  });

  it("answers a tap's refusals: invalid_proof, unknown_tag, replay, QR-only, platform reason only from an iPhone", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const op = await newPerson(event, "operator");
    const code = await writeTag(op, event, quest);
    const who = await newPerson(event, "player");
    const logged = logs.length;
    expect(codeOf(await tap(who, "x".repeat(50)))).toEqual([422, "invalid_proof"]);
    const forged = `${code.slice(0, 30)}${code[30] === "A" ? "B" : "A"}${code.slice(31)}`;
    expect(codeOf(await tap(who, forged))).toEqual([422, "invalid_proof"]);
    expect(logs.slice(logged).join("\n")).not.toContain(forged);
    const unknown = tagCode(createTagCodeKey("q".repeat(40)), randomUUID(), 1);
    expect(codeOf(await tap(who, unknown))).toEqual([404, "unknown_tag"]);
    // Every tag is written at version 1; a signed token of another version was never issued.
    const otherVersion = tagCode(createTagCodeKey("q".repeat(40)), randomUUID(), 2);
    expect(codeOf(await tap(who, otherVersion))).toEqual([422, "invalid_proof"]);
    expect(entriesOf(logged, "nfc.tap_refused").map((entry) => entry["reason"])).toEqual([
      "not_questify",
      "forged",
      "unknown_tag",
      "forged",
    ]);
    expect(entriesOf(logged, "nfc.tapped")).toEqual([]);

    const key = randomUUID();
    const first = await tap(who, code, {}, key);
    const again = await tap(who, code, {}, key);
    expect(again.json()).toEqual(first.json());

    expect(codeOf(await tap(who, code, { uid: null, uidReason: "platform" }))).toEqual([
      400,
      "invalid_request",
    ]);
    expect(
      codeOf(await tap(who, code, { uid: UID, uidReason: "platform", platform: "ios" })),
    ).toEqual([400, "invalid_request"]);
    const unread = await tap(who, code, { uid: null, uidReason: "platform", platform: "ios" });
    expect(unread.statusCode).toBe(200);
    const [row] = await owner<{ uid_ok: boolean | null }>(
      "SELECT uid_ok FROM nfc_tap WHERE completion_id = $1",
      [unread.json<{ completionId: string }>().completionId],
    );
    expect(row?.uid_ok).toBeNull();

    await owner("UPDATE quest SET verification = '{quest_qr}' WHERE id = $1", [quest]);
    expect(codeOf(await tap(who, code))).toEqual([422, "invalid_code"]);
  });

  it("lists, moves, revokes and revokes all on the Tags panel; a quest with tags is not deleted", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const target = await newQuest(event);
    const op = await newPerson(event, "operator");
    const code = await writeTag(op, event, quest);
    await writeTag(op, event, quest, "04ffeeddccbbaa");
    expect(
      codeOf(await dashboard("DELETE", `/events/${event}/quests/${quest}`, { confirm: true })),
    ).toEqual([409, "tags_in_use"]);
    const who = await newPerson(event, "player");
    await tap(who, code, { uid: "04ffeeddccbbaa" });
    const listed = await dashboard("GET", `/events/${event}/quests/${quest}/nfc-tags`);
    expect(listed.statusCode).toBe(200);
    const tags = listed.json<{ tags: Row[] }>().tags;
    expect(tags).toHaveLength(2);
    const tapped = tags.find((row) => row["taps"] === 1);
    expect(tapped).toMatchObject({
      label: "Gate",
      copies: 1,
      unchecked: 0,
      status: "active",
      locked: true,
      writtenAt: isoNow,
      revokedAt: null,
      writtenBy: await usernameOf(op),
      lastTapAt: isoNow,
    });
    expect(tags.find((row) => row["taps"] === 0)).toMatchObject({ lastTapAt: null });
    const tagId = String(tapped?.["id"]);

    expect(
      (await dashboard("POST", `/events/${event}/nfc-tags/${tagId}/move`, { questId: target }))
        .statusCode,
    ).toBe(204);
    expect(
      codeOf(
        await dashboard("POST", `/events/${event}/nfc-tags/${tagId}/move`, {
          questId: await newQuest(event, ["quest_qr"]),
        }),
      ),
    ).toEqual([409, "not_nfc"]);
    expect((await tap(who, code)).json()).toMatchObject({ questId: target });
    expect((await dashboard("POST", `/events/${event}/nfc-tags/${tagId}/revoke`)).statusCode).toBe(
      204,
    );
    expect(codeOf(await tap(who, code))).toEqual([404, "unknown_tag"]);
    const moved = await dashboard("GET", `/events/${event}/quests/${target}/nfc-tags`);
    expect(moved.json()).toMatchObject({
      tags: [{ id: tagId, status: "revoked", revokedAt: isoNow }],
    });
    expect(codeOf(await dashboard("POST", `/events/${event}/nfc-tags/${tagId}/revoke`))).toEqual([
      404,
      "unknown_tag",
    ]);
    const revoke = `/events/${event}/nfc-tags/${randomUUID()}/revoke`;
    expect(codeOf(await dashboard("POST", revoke, { extra: 1 }))).toEqual([400, "invalid_request"]);
    const revokeAll = `/events/${event}/quests/${quest}/nfc-tags/revoke-all`;
    expect(codeOf(await dashboard("POST", revokeAll, { extra: 1 }))).toEqual([
      400,
      "invalid_request",
    ]);
    const all = await dashboard("POST", revokeAll);
    expect(all.json()).toEqual({ revoked: 1 });
    expect(
      codeOf(await dashboard("GET", `/events/${randomUUID()}/quests/${quest}/nfc-tags`)),
    ).toEqual([404, "not_found"]);
  });

  it("holds 60 prepares a minute per operator", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const op = await newPerson(event, "operator");
    for (let n = 0; n < 60; n += 1) {
      expect((await prepare(op, event, quest)).statusCode).toBe(200);
    }
    const held = await prepare(op, event, quest);
    expect(codeOf(held)).toEqual([429, "too_many_attempts"]);
    const wait = Number(held.headers["retry-after"]);
    expect(wait).toBeGreaterThan(0);
    expect(held.json<{ details: Row }>().details).toEqual({ retryAfterSeconds: wait });
  });

  it("answers feature_off for taps and writes while the platform's switch is off; the panel stays", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const op = await newPerson(event, "operator");
    const code = await writeTag(op, event, quest);
    const who = await newPerson(event, "player");
    const prepared = (await prepare(op, event, quest)).json<Prepared>();
    const written = {
      code: tokenOf(prepared.url),
      ticket: prepared.ticket,
      uid: "04abababab",
      locked: false,
    };
    await withNfcOff(async () => {
      expect(codeOf(await tap(who, code))).toEqual([403, "feature_off"]);
      expect(codeOf(await prepare(op, event, quest))).toEqual([403, "feature_off"]);
      expect(codeOf(await confirm(op, event, quest, written))).toEqual([403, "feature_off"]);
      expect(codeOf(await call("GET", `/v1/operator/events/${event}/nfc-tags`, op))).toEqual([
        403,
        "feature_off",
      ]);
      expect((await dashboard("GET", `/events/${event}/quests/${quest}/nfc-tags`)).statusCode).toBe(
        200,
      );
    });
  });

  it("answers outside_quests, limit_reached, event_closed, a code of another version and a prepare's body", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const other = await newQuest(event);
    const op = await newPerson(event, "operator");
    expect(
      codeOf(
        await call("POST", `/v1/operator/events/${event}/quests/${quest}/nfc-tags/prepare`, op, {
          extra: 1,
        }),
      ),
    ).toEqual([400, "invalid_request"]);

    const prepared = (await prepare(op, event, quest)).json<Prepared>();
    const written = { ticket: prepared.ticket, uid: UID, locked: true };
    const v2 = tagCode(createTagCodeKey("q".repeat(40)), prepared.tagId, 2);
    const refused = await confirm(op, event, quest, { ...written, code: v2 });
    expect([...codeOf(refused), refused.json<{ details: Row }>().details["field"]]).toEqual([
      422,
      "invalid_tag",
      "code",
    ]);
    await owner(
      `INSERT INTO nfc_tag (id, organizer_id, event_id, quest_id, uid, locked)
       SELECT gen_random_uuid(), $1, $2, $3, decode(lpad(to_hex(n), 8, '0'), 'hex'), true
       FROM generate_series(1, 50) n`,
      [organizer, event, quest],
    );
    expect(
      codeOf(await confirm(op, event, quest, { ...written, code: tokenOf(prepared.url) })),
    ).toEqual([409, "limit_reached"]);

    await owner(
      `INSERT INTO staff_assignment_quest (assignment_id, event_id, quest_id)
       SELECT id, event_id, $2 FROM staff_assignment WHERE player_id = $1`,
      [op.id, other],
    );
    expect(codeOf(await prepare(op, event, quest))).toEqual([403, "outside_quests"]);
    await owner("UPDATE event SET ends_at = now() - interval '1 minute' WHERE id = $1", [event]);
    expect(codeOf(await prepare(op, event, other))).toEqual([409, "event_closed"]);
  });

  it("answers a sticker's earlier tag as replaced; the page and the panel show titles, locks and revokes", async () => {
    const event = await newEvent();
    const gate = await newQuest(event);
    const stage = await newQuest(event);
    await owner("UPDATE quest SET title_ar = 'البوابة' WHERE id = $1", [gate]);
    const op = await newPerson(event, "operator");
    await writeTag(op, event, gate);
    const prepared = (await prepare(op, event, stage)).json<Prepared>();
    const made = await confirm(op, event, stage, {
      code: tokenOf(prepared.url),
      ticket: prepared.ticket,
      uid: UID,
      label: "Stage",
      locked: false,
    });
    expect(made.statusCode).toBe(201);
    expect(made.json()).toEqual({
      tagId: prepared.tagId,
      questId: stage,
      replaced: { label: "Gate", questId: gate, quest: { ar: "البوابة", en: "Gate" } },
    });

    const page = await call("GET", `/v1/operator/events/${event}/nfc-tags`, op);
    expect(page.json()).toMatchObject({
      tags: [
        { id: prepared.tagId, quest: { ar: null, en: "Gate" }, locked: false, status: "active" },
        { questId: gate, quest: { ar: "البوابة", en: "Gate" }, locked: true, status: "revoked" },
      ],
    });
    const panel = await dashboard("GET", `/events/${event}/quests/${stage}/nfc-tags`);
    expect(panel.json()).toMatchObject({ tags: [{ label: "Stage", locked: false }] });
  });

  it("keeps a tap's place only while location quests are on, and its device", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const op = await newPerson(event, "operator");
    const code = await writeTag(op, event, quest);
    const who = await newPerson(event, "player");
    const place = { lat: 24.7136, lng: 46.6753, accuracyM: 12, ageS: 5 };
    const device = randomUUID();
    const tapFrom = (position: unknown) =>
      test.app.inject({
        method: "POST",
        url: "/v1/taps",
        headers: {
          authorization: `Bearer ${who.token}`,
          "idempotency-key": randomUUID(),
          "x-device-id": device,
        },
        payload: { code, uid: UID, platform: "android", position },
      });
    const keptOf = async (position: unknown) => {
      const paid = await tapFrom(position);
      expect(paid.statusCode, paid.body).toBe(200);
      const [row] = await owner<{ device_id: string | null; kept: boolean }>(
        `SELECT c.device_id, EXISTS (SELECT 1 FROM completion_position p WHERE p.completion_id = c.id) AS kept
         FROM quest_completion c WHERE c.id = $1`,
        [paid.json<{ completionId: string }>().completionId],
      );
      return row;
    };

    await withFeatures({ locationQuests: { enabled: true } }, async () => {
      expect(await keptOf(place)).toEqual({ device_id: device, kept: true });
      expect(await keptOf({ ...place, lat: "north" })).toEqual({ device_id: device, kept: false });
    });
    expect(await keptOf(place)).toEqual({ device_id: device, kept: false });
  });
});
