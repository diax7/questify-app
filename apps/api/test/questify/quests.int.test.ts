import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminCampaignSchema,
  adminQuestSchema,
  adminQuestifySchema,
  questifyQuestsSchema,
  questifySyncSchema,
} from "@questify/shared";
import {
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { questifyFixture, type QuestifyFixture } from "#test/support/questify";
import { TEST_DATABASE_URL } from "#test/support/test-db";

const at = (hours: number) => new Date(Date.now() + hours * 3600 * 1000).toISOString();
const QUEST = {
  metric: "events",
  target: 1,
  title: { ar: "العب", en: "Play" },
  xp: 120,
  position: 1,
  status: "active",
};

/** The T-403b doors over HTTP: the console's campaign and quest writes, their refusals, and the player's list. */
describe.skipIf(TEST_DATABASE_URL === undefined)("questify quests routes (T-403b)", () => {
  let f: QuestifyFixture;
  let test: TestApp;
  let cookie = "";
  beforeAll(async () => {
    f = await questifyFixture();
    test = await startApp(f.db);
    await createStaff(f.db.owner, { email: "quests-admin@questify.test", admin: true });
    cookie = await signInFully(test, "quests-admin@questify.test");
  });
  afterAll(async () => {
    await test.close();
    await f.close();
  });

  const admin = (
    method: "GET" | "POST" | "PUT",
    url: string,
    payload?: object,
    key: string = randomUUID(),
  ) =>
    test.app.inject({
      method,
      url: `/v1/admin/questify${url}`,
      headers: withSession(cookie, { "idempotency-key": key }),
      ...(payload === undefined ? {} : { payload }),
    });
  const tokenOf = async (player: string) => {
    const token = randomBytes(32).toString("base64url");
    await f.owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [player, createHash("sha256").update(token).digest()],
    );
    return token;
  };
  const asPlayer = (token: string, method: "GET" | "POST", url: string) =>
    test.app.inject({ method, url, headers: { authorization: `Bearer ${token}` } });

  it("runs a campaign from the console, pays its quest once and shows it to the player", async () => {
    const created = await admin("POST", "/campaigns", {
      name: { ar: "رمضان", en: " Ramadan " },
      startsAt: at(1),
      endsAt: at(48),
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers["cache-control"]).toBe("no-store");
    const campaign = adminCampaignSchema.parse(created.json().campaign);
    expect(campaign).toMatchObject({ status: "draft", name: { ar: "رمضان", en: "Ramadan" } });
    const made = await admin("POST", "/quests", { ...QUEST, campaignId: campaign.id });
    expect(made.statusCode).toBe(201);
    const quest = adminQuestSchema.parse(made.json().quest);
    const published = await admin("POST", `/campaigns/${campaign.id}/publish`);
    expect(adminCampaignSchema.parse(published.json().campaign).status).toBe("published");
    const list = adminQuestifySchema.parse((await admin("GET", "")).json());
    expect(list.alwaysOn.map((row) => row.metric)).toEqual(["events", "cities"]);
    expect(list.campaigns.find((row) => row.id === campaign.id)?.quests).toEqual([quest]);

    await f.owner(
      "UPDATE questify_campaign SET starts_at = now() - interval '1 hour' WHERE id = $1",
      [campaign.id],
    );
    const late = await admin("POST", "/quests", { ...QUEST, campaignId: campaign.id });
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({
      code: "questify_conflict",
      details: { reason: "started" },
    });
    const player = await f.newPlayer();
    const token = await tokenOf(player);
    await f.play(await f.newEvent(), player);
    const listed = await asPlayer(token, "GET", "/v1/me/questify-quests");
    expect(listed.statusCode).toBe(200);
    expect(listed.headers["cache-control"]).toBe("private, no-store");
    const quests = questifyQuestsSchema.parse(listed.json());
    expect(quests.seasonal).toEqual([
      {
        campaign: {
          id: campaign.id,
          name: { ar: "رمضان", en: "Ramadan" },
          endsAt: expect.any(String),
        },
        quests: [
          {
            id: quest.id,
            title: QUEST.title,
            metric: "events",
            target: 1,
            progress: 1,
            xp: 120,
            gems: 0,
            done: false,
          },
        ],
      },
    ]);
    const synced = questifySyncSchema.parse(
      (await asPlayer(token, "POST", "/v1/me/questify/sync")).json(),
    );
    expect(synced.quests).toEqual([{ id: quest.id, title: QUEST.title, xp: 120 }]);
    expect(synced.levelUp).toMatchObject({ level: 2, items: [{ id: "level-2" }] });
    const again = questifySyncSchema.parse(
      (await asPlayer(token, "POST", "/v1/me/questify/sync")).json(),
    );
    expect(again.quests).toEqual([]);
    const after = questifyQuestsSchema.parse(
      (await asPlayer(token, "GET", "/v1/me/questify-quests")).json(),
    );
    expect(after.seasonal[0]?.quests[0]?.done).toBe(true);
  });

  it("answers the doors' refusals with their reason or field", async () => {
    const campaign = adminCampaignSchema.parse(
      (
        await admin("POST", "/campaigns", {
          name: { ar: "صيف", en: "Summer" },
          startsAt: at(1),
          endsAt: at(9),
        })
      ).json().campaign,
    );
    const quest = adminQuestSchema.parse(
      (await admin("POST", "/quests", { ...QUEST, campaignId: null })).json().quest,
    );
    const frozen = await admin("PUT", `/quests/${quest.id}`, { ...QUEST, target: 2 });
    expect(frozen.statusCode).toBe(409);
    expect(frozen.json()).toMatchObject({
      code: "questify_conflict",
      details: { reason: "frozen" },
    });
    const renamed = await admin("PUT", `/quests/${quest.id}`, { ...QUEST, xp: 80 });
    expect(adminQuestSchema.parse(renamed.json().quest)).toMatchObject({
      xp: 80,
      campaignId: null,
    });
    expect((await admin("POST", `/quests/${quest.id}/retire`)).json().quest.status).toBe("retired");

    await f.owner(
      "UPDATE questify_campaign SET starts_at = now() - interval '1 hour' WHERE id = $1",
      [campaign.id],
    );
    const late = await admin("POST", `/campaigns/${campaign.id}/publish`);
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ details: { reason: "start_passed" } });
    const unknown = await admin("POST", "/quests", { ...QUEST, campaignId: randomUUID() });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json()).toMatchObject({
      code: "invalid_questify",
      details: { field: "campaignId" },
    });
    const backwards = await admin("POST", "/campaigns", {
      name: { ar: "صيف", en: "Summer" },
      startsAt: at(9),
      endsAt: at(1),
    });
    expect(backwards.statusCode).toBe(422);
    expect(backwards.json()).toMatchObject({ details: { field: "endsAt" } });
    for (const url of [`/campaigns/${randomUUID()}/retire`, `/quests/${randomUUID()}/retire`]) {
      expect((await admin("POST", url)).statusCode, url).toBe(404);
    }
    for (const [url, payload] of [
      ["/campaigns", { name: { ar: "صيف", en: "Sum\u202Emer" }, startsAt: at(1), endsAt: at(2) }],
      [
        "/campaigns",
        { name: { ar: "صيف", en: "Summer" }, startsAt: "2026-11-01T10:00", endsAt: at(2) },
      ],
      ["/quests", { ...QUEST, campaignId: null, metric: "gems" }],
      ["/quests", { ...QUEST, campaignId: null, status: "retired" }],
      ["/quests", { ...QUEST }],
      [`/quests/${quest.id}`, { ...QUEST, campaignId: null }],
      [
        "/campaigns/not-a-uuid",
        { name: { ar: "صيف", en: "Summer" }, startsAt: at(1), endsAt: at(2) },
      ],
    ] as const) {
      const method = url.startsWith("/quests/") || url.includes("not-a-uuid") ? "PUT" : "POST";
      expect((await admin(method, url, payload)).statusCode, `${method} ${url}`).toBe(400);
    }
  });

  it("needs an Idempotency-Key on every write and replays the first answer", async () => {
    const body = { name: { ar: "شتاء", en: "Winter" }, startsAt: at(1), endsAt: at(5) };
    const missing = await test.app.inject({
      method: "POST",
      url: "/v1/admin/questify/campaigns",
      headers: withSession(cookie),
      payload: body,
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ code: "idempotency_key_required" });
    const key = randomUUID();
    const first = await admin("POST", "/campaigns", body, key);
    const second = await admin("POST", "/campaigns", body, key);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.json()).toEqual(first.json());
    const [count] = await f.owner<{ n: number }>(
      "SELECT count(*)::integer AS n FROM questify_campaign WHERE name_en = 'Winter'",
    );
    expect(count?.n).toBe(1);
  });

  it("answers a real permission fault, such as a lost EXECUTE grant, as a 500 and not a 404", async () => {
    await f.owner("REVOKE EXECUTE ON FUNCTION questify_admin_list() FROM questify_app");
    try {
      expect((await admin("GET", "")).statusCode).toBe(500);
    } finally {
      await f.owner("GRANT EXECUTE ON FUNCTION questify_admin_list() TO questify_app");
    }
    expect((await admin("GET", "")).statusCode).toBe(200);
  });
});
