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

type Sponsor = {
  id: string;
  nameEn: string | null;
  tier: string;
  tags: { kind: string; targetId: string }[];
};

describe.skipIf(TEST_DATABASE_URL === undefined)("sponsors over HTTP", () => {
  let fixture: PushFixture;
  let test: TestApp;
  let cookie: string;
  let editorCookie: string;
  let otherCookie: string;
  let limitedCookie: string;
  let viewerCookie: string;
  let event: string;
  let token: string;

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
      const email = name + "@sponsor.test";
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
    await createStaff(fixture.db.owner, { email: "viewer@sponsor.test" });
    viewerCookie = await signInFully(test, "viewer@sponsor.test");
    event = await fixture.newEvent({ phase: "live" });
    const player = await fixture.newPlayer();
    await fixture.join(event, player);
    token = await bearer(player);
  });
  afterAll(async () => {
    await test.close();
    await fixture.close();
  });

  const base = (id = event) => "/v1/organizers/" + fixture.ids.orgA + "/events/" + id;
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
  const add = async (nameEn: string, over: object = {}, session = cookie) => {
    const made = await team(
      "POST",
      base() + "/sponsors",
      { nameEn, tier: "gold", ...over },
      session,
    );
    expect(made.statusCode).toBe(201);
    return made.json<Sponsor>();
  };
  const quest = async (ev = event): Promise<string> =>
    (
      await fixture.owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, visible, type_config)
         SELECT $1, id, 'scan_qr', 'Station', 40, 1, true, '{}' FROM category WHERE event_id = $1 LIMIT 1
         RETURNING id`,
        [ev],
      )
    )[0]?.id ?? "";

  it("adds, edits, tags and deletes sponsors, for an owner and an editor", async () => {
    const acme = await add("Acme", { booth: "B14" });
    const second = await add("Beta", { tier: "platinum" }, editorCookie);
    const renamed = await team("PUT", base() + "/sponsors/" + acme.id, {
      nameEn: "Acme Ltd",
      nameAr: "أكمي",
      tier: "silver",
    });
    expect(renamed.json()).toMatchObject({ id: acme.id, nameEn: "Acme Ltd", tier: "silver" });
    const station = await quest();
    const tagged = await team(
      "PUT",
      base() + "/sponsor-tags",
      { kind: "quest", targetId: station, sponsorId: acme.id },
      editorCookie,
    );
    expect(tagged.json<{ sponsors: Sponsor[] }>().sponsors.map((row) => row.id)).toEqual([
      second.id,
      acme.id,
    ]);
    const listed = await team("GET", base() + "/sponsors");
    expect(listed.headers["cache-control"]).toContain("no-store");
    expect(
      listed.json<{ sponsors: Sponsor[] }>().sponsors.find((row) => row.id === acme.id)?.tags,
    ).toEqual([{ kind: "quest", targetId: station }]);
    expect((await team("DELETE", base() + "/sponsors/" + acme.id)).json()).toEqual({
      tagsLost: 1,
    });
    expect(codeOf(await team("DELETE", base() + "/sponsors/" + acme.id))).toEqual([
      404,
      "not_found",
    ]);
  });

  it("names the first bad field, and refuses a field a sponsor must not have", async () => {
    const nameless = await team("POST", base() + "/sponsors", { nameEn: "", tier: "gold" });
    expect(codeOf(nameless)).toEqual([422, "invalid_sponsor"]);
    expect(nameless.json().details).toEqual({ issue: "name" });
    const noTier = await team("POST", base() + "/sponsors", { nameEn: "No tier" });
    expect(noTier.json().details).toEqual({ issue: "tier" });
    for (const extra of [
      { email: "a@b.sa" },
      { phone: "+966500000000" },
      { website: "https://a.sa" },
    ]) {
      expect(
        codeOf(
          await team("POST", base() + "/sponsors", { nameEn: "Extra", tier: "gold", ...extra }),
        ),
      ).toEqual([422, "invalid_sponsor"]);
    }
    const badKind = await team("PUT", base() + "/sponsor-tags", {
      kind: "souvenir",
      targetId: randomUUID(),
      sponsorId: null,
    });
    expect(badKind.json().details).toEqual({ issue: "kind" });
    expect(
      codeOf(
        await team("PUT", base() + "/sponsor-tags", {
          kind: "quest",
          targetId: randomUUID(),
          sponsorId: null,
        }),
      ),
    ).toEqual([404, "not_found"]);
  });

  it("shows the player the sponsors and the tags on what they may see, and nothing about any player", async () => {
    const solo = await fixture.newEvent({ phase: "live" });
    const who = await fixture.newPlayer();
    await fixture.join(solo, who);
    const soloToken = await bearer(who);
    const put = (path: string, payload: object) => team("POST", base(solo) + path, payload);
    const made = (
      await put("/sponsors", { nameEn: "Acme", nameAr: "أكمي", tier: "gold", booth: "B1" })
    ).json<Sponsor>();
    const shown = await quest(solo);
    const hidden = await quest(solo);
    await fixture.owner("UPDATE quest SET visible = false WHERE id = $1", [hidden]);
    for (const id of [shown, hidden]) {
      await team("PUT", base(solo) + "/sponsor-tags", {
        kind: "quest",
        targetId: id,
        sponsorId: made.id,
      });
    }
    const answer = await asPlayer("/v1/events/" + solo + "/sponsors", soloToken);
    expect(answer.statusCode).toBe(200);
    expect(answer.headers["cache-control"]).toContain("no-store");
    expect(answer.json()).toEqual({
      sponsors: [{ id: made.id, name: { ar: "أكمي", en: "Acme" }, tier: "gold", booth: "B1" }],
      tags: [{ kind: "quest", targetId: shown, sponsorId: made.id }],
    });
    expect(answer.body).not.toContain(hidden);
    expect(answer.body).not.toMatch(/player|enrollment|email|phone/i);
  });

  it("answers a stranger and a signed-out caller, and sends no team data to a player", async () => {
    const other = await fixture.newEvent({ phase: "live" });
    expect(codeOf(await asPlayer("/v1/events/" + other + "/sponsors"))).toEqual([
      403,
      "not_enrolled",
    ]);
    expect(
      (await test.app.inject({ method: "GET", url: "/v1/events/" + event + "/sponsors" }))
        .statusCode,
    ).toBe(401);
    expect((await asPlayer("/v1/events/" + event + "/sponsors")).statusCode).toBe(200);
    const sponsor = await add("Doors");
    const doors: ["GET" | "POST" | "PUT" | "DELETE", string, object | undefined][] = [
      ["GET", base() + "/sponsors", undefined],
      ["POST", base() + "/sponsors", { nameEn: "X", tier: "gold" }],
      ["PUT", base() + "/sponsors/" + sponsor.id, { nameEn: "X", tier: "gold" }],
      ["DELETE", base() + "/sponsors/" + sponsor.id, undefined],
      ["PUT", base() + "/sponsor-tags", { kind: "quest", targetId: randomUUID(), sponsorId: null }],
    ];
    for (const session of [otherCookie, limitedCookie, viewerCookie]) {
      for (const [method, url, payload] of doors) {
        expect((await team(method, url, payload, session)).statusCode, method + " " + url).toBe(
          404,
        );
      }
    }
    for (const headers of [{}, { authorization: "Bearer " + token }]) {
      expect(
        (await test.app.inject({ method: "GET", url: base() + "/sponsors", headers })).statusCode,
      ).toBe(401);
    }
  });

  it("reauthorizes a revoked editor scope before replaying a stored write", async () => {
    const fresh = await fixture.newEvent({ phase: "live" });
    const key = randomUUID();
    const payload = { nameEn: "Replay", tier: "gold" };
    const made = await team("POST", base(fresh) + "/sponsors", payload, editorCookie, key);
    expect(made.statusCode).toBe(201);
    await fixture.owner(
      "UPDATE organizer_member SET event_scope = $1 WHERE staff_user_id = (SELECT id FROM staff_user WHERE email = 'editor@sponsor.test')",
      [[fixture.ids.eventA]],
    );
    expect(
      (await team("POST", base(fresh) + "/sponsors", payload, editorCookie, key)).statusCode,
    ).toBe(404);
  });

  it("has no sponsor sign-in, report or share route: sponsors are reached only by the team and the players", () => {
    const urls = test.app.routeInventory
      .filter((route) => route.method !== "HEAD" && /sponsor/i.test(route.url))
      .map((route) => route.method + " " + route.url);
    expect(urls.toSorted()).toEqual([
      "DELETE /v1/organizers/:organizerId/events/:eventId/sponsors/:sponsorId",
      "GET /v1/events/:eventId/sponsors",
      "GET /v1/organizers/:organizerId/events/:eventId/sponsors",
      "POST /v1/organizers/:organizerId/events/:eventId/sponsors",
      "PUT /v1/organizers/:organizerId/events/:eventId/sponsor-tags",
      "PUT /v1/organizers/:organizerId/events/:eventId/sponsors/:sponsorId",
    ]);
    const roles = test.app.routeInventory.map((route) => route.access);
    expect(roles).not.toContain("sponsor");
  });
});

it("the sponsors module sends no email, SMS or invitation and reads no player", () => {
  for (const file of readdirSync("apps/api/src/sponsors")) {
    expect(readFileSync("apps/api/src/sponsors/" + file, "utf8")).not.toMatch(
      /sms|smtp|gmail|msegat|invitation|outbound|sendEmail|geolocation|latitude|longitude|enrollment|quest_completion|ledger/i,
    );
  }
});
