import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
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

const codeOf = (response: { statusCode: number; json: () => { code?: string } }) => [
  response.statusCode,
  response.json().code,
];

type Pin = { id: string; kind: string; questId: string | null };
type TeamMap = { id: string; nameEn: string | null; position: number; pins: Pin[] };

describe.skipIf(TEST_DATABASE_URL === undefined)("maps over HTTP", () => {
  let fixture: PushFixture;
  let test: TestApp;
  let cookie: string;
  let editorCookie: string;
  let otherCookie: string;
  let limitedCookie: string;
  let viewerCookie: string;
  let event: string;
  let token: string;
  let player: string;

  const bearer = async (id: string): Promise<string> => {
    const value = randomBytes(32).toString("base64url");
    await fixture.owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [id, createHash("sha256").update(value).digest()],
    );
    return value;
  };

  beforeAll(async () => {
    fixture = await pushFixture();
    test = await startApp(fixture.db);
    const staff = async (
      name: string,
      role: string,
      organizer = fixture.ids.orgA,
      limited = false,
    ) => {
      const email = name + "@map.test";
      const id = await createStaff(fixture.db.owner, { email });
      await fixture.owner(
        "INSERT INTO organizer_member (organizer_id, staff_user_id, role, event_scope) VALUES ($1, $2, $3, $4)",
        [organizer, id, role, limited ? [fixture.ids.eventA] : null],
      );
      return signInFully(test, email);
    };
    await fixture.owner("UPDATE organizer_member SET role = 'editor' WHERE organizer_id = $1", [
      fixture.ids.orgA,
    ]);
    cookie = await staff("owner", "owner");
    editorCookie = await staff("editor", "editor");
    otherCookie = await staff("other", "owner", fixture.ids.orgB);
    limitedCookie = await staff("limited", "editor", fixture.ids.orgA, true);
    await createStaff(fixture.db.owner, { email: "viewer@map.test" });
    viewerCookie = await signInFully(test, "viewer@map.test");
    event = await fixture.newEvent({ phase: "live" });
    player = await fixture.newPlayer();
    await fixture.join(event, player);
    token = await bearer(player);
  });
  afterAll(async () => {
    await test.close();
    await fixture.close();
  });

  const base = (id = event) => "/v1/organizers/" + fixture.ids.orgA + "/events/" + id + "/maps";
  const team = (
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    payload?: object,
    session = cookie,
    key = randomUUID(),
  ) =>
    test.app.inject({
      method,
      url,
      headers: withSession(session, { "idempotency-key": key }),
      ...(payload === undefined ? {} : { payload }),
    });
  const asPlayer = (url: string, bearerToken = token) =>
    test.app.inject({ method: "GET", url, headers: { authorization: "Bearer " + bearerToken } });
  const maps = (id = event) => "/v1/events/" + id + "/maps";
  const add = async (nameEn: string, session = cookie) => {
    const made = await team("POST", base(), { nameEn }, session);
    expect(made.statusCode).toBe(201);
    return made.json<TeamMap>();
  };
  const quest = async (over: Record<string, unknown> = {}): Promise<string> =>
    (
      await fixture.owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, title_ar, points, repeat_cap, visible, type_config,
                            opens_at)
         SELECT $1, id, 'scan_qr', $2, 'محطة', 40, 1, $3, '{}', $4 FROM category WHERE event_id = $1 LIMIT 1
         RETURNING id`,
        [event, over["title"] ?? "Station", over["visible"] ?? true, over["opensAt"] ?? null],
      )
    )[0]?.id ?? "";

  it("adds, renames, orders and deletes maps and pins, for an owner and an editor", async () => {
    const floor = await add("Floor 1");
    const second = await add("Floor 2", editorCookie);
    expect(second.position).toBe(2);
    const renamed = await team("PUT", base() + "/" + floor.id, {
      nameEn: "Ground",
      nameAr: "الأرضي",
    });
    expect(renamed.json()).toMatchObject({ id: floor.id, nameEn: "Ground" });
    const ordered = await team(
      "PUT",
      base() + "/order",
      { ids: [second.id, floor.id] },
      editorCookie,
    );
    expect(ordered.json().maps.map((row: TeamMap) => row.id)).toEqual([second.id, floor.id]);
    const pinned = await team("POST", base() + "/" + floor.id + "/pins", {
      kind: "amenity",
      amenity: "prayer",
      x: 250,
      y: 400,
    });
    expect(pinned.statusCode).toBe(201);
    const pinId = pinned.json<TeamMap>().pins[0]?.id ?? "";
    const moved = await team("PUT", base() + "/" + floor.id + "/pins/" + pinId, {
      kind: "amenity",
      amenity: "prayer",
      x: 300,
      y: 400,
    });
    expect(moved.json<TeamMap>().pins[0]).toMatchObject({ x: 300 });
    const listed = await team("GET", base());
    expect(listed.headers["cache-control"]).toContain("no-store");
    expect(listed.json().maps).toHaveLength(2);
    const removed = await team("DELETE", base() + "/" + floor.id + "/pins/" + pinId);
    expect(removed.json<TeamMap>().pins).toEqual([]);
    expect((await team("DELETE", base() + "/" + floor.id)).json()).toEqual({ pinsLost: 0 });
    expect(codeOf(await team("DELETE", base() + "/" + floor.id))).toEqual([404, "not_found"]);
  });

  it("names the first bad field, and answers each conflict in its own words", async () => {
    const map = await add("Rules");
    const bad = await team("POST", base(), { nameEn: "" });
    expect(codeOf(bad)).toEqual([422, "invalid_map"]);
    expect(bad.json().details).toEqual({ issue: "name" });
    const noKind = await team("POST", base() + "/" + map.id + "/pins", {
      kind: "castle",
      x: 1,
      y: 1,
    });
    expect(noKind.json().details).toEqual({ issue: "kind" });
    const offBoard = await team("POST", base() + "/" + map.id + "/pins", {
      kind: "booth",
      nameEn: "B",
      x: 1001,
      y: 1,
    });
    expect(offBoard.json().details).toEqual({ issue: "x" });
    const unnamed = await team("POST", base() + "/" + map.id + "/pins", {
      kind: "booth",
      x: 1,
      y: 1,
    });
    expect(unnamed.json().details).toEqual({ issue: "name" });
    expect(codeOf(await team("POST", base(), { nameEn: "Extra field", price: 10 }))).toEqual([
      422,
      "invalid_map",
    ]);
    const station = await quest();
    const body = { kind: "quest", questId: station, x: 5, y: 5 };
    expect((await team("POST", base() + "/" + map.id + "/pins", body)).statusCode).toBe(201);
    expect(codeOf(await team("POST", base() + "/" + map.id + "/pins", body))).toEqual([
      409,
      "map_quest_pinned",
    ]);
    const missing = await team("PUT", base() + "/order", { ids: [randomUUID()] });
    expect(codeOf(missing)).toEqual([422, "invalid_map"]);
    expect(missing.json().details).toEqual({ issue: "order" });
  });

  it("shows the player each quest pin with their own status and points, and where they last scanned", async () => {
    const solo = await fixture.newEvent({ phase: "live" });
    const soloPlayer = await fixture.newPlayer();
    const soloEnrollment = await fixture.join(solo, soloPlayer);
    const soloToken = await bearer(soloPlayer);
    const put = (path: string, payload: object) => team("POST", base(solo) + path, payload);
    const made = (await put("", { nameEn: "Hall", nameAr: "القاعة" })).json<TeamMap>();
    const station = async (title: string, over: Record<string, unknown> = {}) =>
      (
        await fixture.owner<{ id: string }>(
          `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, visible, type_config,
                              opens_at)
           SELECT $1, id, 'scan_qr', $2, 40, 1, $3, '{}', $4 FROM category WHERE event_id = $1 LIMIT 1
           RETURNING id`,
          [solo, title, over["visible"] ?? true, over["opensAt"] ?? null],
        )
      )[0]?.id ?? "";
    const [done, open, locked, hidden] = [
      await station("Done one"),
      await station("Open one"),
      await station("Locked one", { opensAt: new Date(Date.now() + 3_600_000).toISOString() }),
      await station("Hidden one", { visible: false }),
    ];
    for (const [index, id] of [done, open, locked, hidden].entries()) {
      await put("/" + made.id + "/pins", {
        kind: "quest",
        questId: id,
        x: 100 * (index + 1),
        y: 50,
      });
    }
    await put("/" + made.id + "/pins", { kind: "amenity", amenity: "first_aid", x: 900, y: 900 });
    await fixture.owner(
      `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                     idempotency_key)
       VALUES ($1, $2, $3, $4, 1, 'qr', $5)`,
      [fixture.ids.orgA, solo, soloEnrollment, done, randomUUID()],
    );
    const answer = await asPlayer(maps(solo), soloToken);
    expect(answer.statusCode).toBe(200);
    expect(answer.headers["cache-control"]).toContain("no-store");
    const read = answer.json<{
      maps: {
        name: object;
        pins: {
          kind: string;
          quest: { title: { en: string }; points: number; state: string } | null;
        }[];
      }[];
      here: { pinId: string } | null;
    }>();
    expect(read.maps[0]?.name).toEqual({ ar: "القاعة", en: "Hall" });
    const pins = read.maps[0]?.pins ?? [];
    expect(pins.map((pin) => pin.quest?.title.en ?? pin.kind)).toEqual([
      "Done one",
      "Open one",
      "Locked one",
      "amenity",
    ]);
    expect(pins.map((pin) => pin.quest?.state ?? null)).toEqual(["done", "open", "not_yet", null]);
    expect(pins[0]?.quest?.points).toBe(40);
    expect(JSON.stringify(read)).not.toContain(hidden);
    expect(read.here?.pinId).toBe(
      (await team("GET", base(solo)))
        .json<{ maps: TeamMap[] }>()
        .maps[0]?.pins.find((pin) => pin.questId === done)?.id,
    );
  });

  it("answers a stranger and a signed-out caller, and sends no team data to a player", async () => {
    const other = await fixture.newEvent({ phase: "live" });
    expect(codeOf(await asPlayer(maps(other)))).toEqual([403, "not_enrolled"]);
    expect((await test.app.inject({ method: "GET", url: maps() })).statusCode).toBe(401);
    expect((await asPlayer(maps())).statusCode).toBe(200);
    const map = await add("Doors");
    const doors: ["GET" | "POST" | "PUT" | "DELETE", string, object | undefined][] = [
      ["GET", base(), undefined],
      ["POST", base(), { nameEn: "X" }],
      ["PUT", base() + "/" + map.id, { nameEn: "X" }],
      ["PUT", base() + "/order", { ids: [map.id] }],
      ["DELETE", base() + "/" + map.id, undefined],
      ["POST", base() + "/" + map.id + "/pins", { kind: "amenity", amenity: "food", x: 1, y: 1 }],
      ["DELETE", base() + "/" + map.id + "/pins/" + randomUUID(), undefined],
    ];
    for (const session of [otherCookie, limitedCookie, viewerCookie]) {
      for (const [method, url, payload] of doors) {
        expect((await team(method, url, payload, session)).statusCode, method + " " + url).toBe(
          404,
        );
      }
    }
    for (const headers of [{}, { authorization: "Bearer " + token }]) {
      expect((await test.app.inject({ method: "GET", url: base(), headers })).statusCode).toBe(401);
    }
  });

  it("reauthorizes a revoked editor scope before replaying a stored write", async () => {
    const fresh = await fixture.newEvent({ phase: "live" });
    const key = randomUUID();
    const made = await team("POST", base(fresh), { nameEn: "Replay" }, editorCookie, key);
    expect(made.statusCode).toBe(201);
    await fixture.owner(
      "UPDATE organizer_member SET event_scope = $1 WHERE staff_user_id = (SELECT id FROM staff_user WHERE email = 'editor@map.test')",
      [[fixture.ids.eventA]],
    );
    expect(
      (await team("POST", base(fresh), { nameEn: "Replay" }, editorCookie, key)).statusCode,
    ).toBe(404);
  });
});

it("the maps module sends no email, SMS or invitation, and reads no phone position", () => {
  for (const file of readdirSync("apps/api/src/maps")) {
    expect(readFileSync("apps/api/src/maps/" + file, "utf8")).not.toMatch(
      /sms|smtp|gmail|msegat|invitation|outbound|sendEmail|geolocation|latitude|longitude/i,
    );
  }
});
