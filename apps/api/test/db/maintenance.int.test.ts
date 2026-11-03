import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "#src/db/context";
import { questifyFixture, type QuestifyFixture } from "#test/support/questify";
import { TEST_DATABASE_URL } from "#test/support/test-db";

const refusal = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "none",
    (error: { code?: string }) => `${error.code}`,
  );

const MESSAGE = { ar: "الصيانة جارية.", en: "Under maintenance." };

/**
 * Maintenance mode and the banner in the database (T-703b, migration 0128): only an active platform admin writes the two
 * new `platform_setting` blocks, each holds only its own fields, and `play_event_id` finds the event of a play door for
 * the API's role alone.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("maintenance and banner (database)", () => {
  let f: QuestifyFixture;
  let admin: RequestContext = {};
  let event = "";
  let quest = "";
  let reward = "";
  let session = "";
  let round = "";
  let sale = "";

  beforeAll(async () => {
    f = await questifyFixture();
    const [row] = await f.owner<{ id: string }>(
      "INSERT INTO staff_user (email, password_hash, platform_role) VALUES ('maint@questify.test', 'h', 'admin') RETURNING id",
    );
    admin = { isAdmin: true, staffUserId: row?.id ?? "" };
    event = await f.newEvent({ phase: "live" });
    const [made] = await f.owner<{ id: string }>(
      `WITH c AS (INSERT INTO category (event_id, name_en) VALUES ($1, 'General') RETURNING id)
       INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
       SELECT $1, c.id, 'enter_code', 'Booth', 10, '{"code": "ABC123"}' FROM c RETURNING id`,
      [event],
    );
    quest = made?.id ?? "";
    const [prize] = await f.owner<{ id: string }>(
      "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, 'experience', 'Tour', 40, 8) RETURNING id",
      [event],
    );
    reward = prize?.id ?? "";
    const player = await f.newPlayer();
    const enrollment = await f.join(event, player);
    const [talk] = await f.owner<{ id: string }>(
      `INSERT INTO event_session (organizer_id, event_id, kind, title_en, starts_at, ends_at, access, created_by)
       SELECT organizer_id, id, 'talk', 'Keynote', now(), now() + interval '1 hour', 'open', $2
       FROM event WHERE id = $1 RETURNING id`,
      [event, randomUUID()],
    );
    session = talk?.id ?? "";
    const [played] = await f.owner<{ id: string }>(
      `INSERT INTO game_round (organizer_id, event_id, enrollment_id, quest_id, game, level, seed, params, points,
                               issue_key, engine_version, deadline_at)
       SELECT organizer_id, id, $2, $3, 'memory_match', 'easy', 1, '{}', 0, 'round-1', 1, now() + interval '1 minute'
       FROM event WHERE id = $1 RETURNING id::text AS id`,
      [event, enrollment, quest],
    );
    round = played?.id ?? "";
    const [offered] = await f.owner<{ id: string }>(
      `INSERT INTO desk_sale (organizer_id, event_id, enrollment_id, reward_id, operator_id, price, idempotency_key,
                              offer_until)
       SELECT organizer_id, id, $2, $3, $4, 40, 'sale-1', now() + interval '1 hour'
       FROM event WHERE id = $1 RETURNING id`,
      [event, enrollment, reward, player],
    );
    sale = offered?.id ?? "";
  });
  afterAll(async () => {
    await f.close();
  });

  const write = (seat: RequestContext, key: string, value: unknown) =>
    f.run(
      seat,
      `INSERT INTO platform_setting (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify(value)],
    );

  it("starts with both blocks present and empty, so a first save has a row to lock", async () => {
    expect(
      await f.owner(
        "SELECT key, value FROM platform_setting WHERE key IN ('maintenance', 'banner') ORDER BY key",
      ),
    ).toEqual([
      { key: "banner", value: {} },
      { key: "maintenance", value: { events: {} } },
    ]);
  });

  it("lets only a platform admin write the maintenance and banner blocks", async () => {
    await f.owner("DELETE FROM platform_setting WHERE key IN ('maintenance', 'banner')");
    for (const seat of [f.team(), {}]) {
      for (const key of ["maintenance", "banner"]) {
        expect(await refusal(write(seat, key, {})), key).toBe("42501");
      }
    }
    await write(admin, "maintenance", { global: MESSAGE, events: {} });
    await write(admin, "banner", { message: MESSAGE, startsAt: "a", endsAt: "b" });
    await write(admin, "banner", {});
    expect(
      (await f.owner("SELECT key FROM platform_setting WHERE key IN ('maintenance', 'banner')"))
        .length,
    ).toBe(2);
  });

  it("still refuses a key the generic writer never had, even for an admin", async () => {
    expect(await refusal(write(admin, "xp", { questXp: 1 }))).toBe("42501");
    expect(await refusal(write(admin, "somethingElse", {}))).toBe("42501");
  });

  it("keeps each block to its own fields", async () => {
    expect(await refusal(write(admin, "maintenance", { global: MESSAGE, extra: 1 }))).toBe("23514");
    expect(await refusal(write(admin, "banner", { message: MESSAGE, link: "x" }))).toBe("23514");
  });

  it("finds the event of a quest, a reward, a session, a desk sale, a game round and a join code, and nothing for anything else", async () => {
    const find = async (kind: string, ref: string) =>
      (await f.owner<{ id: string | null }>("SELECT play_event_id($1, $2) AS id", [kind, ref]))[0]
        ?.id;
    expect(await find("quest", quest)).toBe(event);
    expect(await find("reward", reward)).toBe(event);
    expect(await find("session", session)).toBe(event);
    expect(await find("desk_sale", sale)).toBe(event);
    expect(await find("game_round", round)).toBe(event);
    expect(await find("game_round", "999999999")).toBeNull();
    expect(await find("game_round", "0")).toBeNull();
    expect(await find("game_round", `${round}; DROP TABLE game_round`)).toBeNull();
    expect(await find("game_round", quest)).toBeNull();
    expect(await find("session", round)).toBeNull();
    expect(await find("session", randomUUID())).toBeNull();
    expect(await find("desk_sale", "not-a-uuid")).toBeNull();
    const [code] = await f.owner<{ join_code: string }>(
      "SELECT join_code FROM event WHERE id = $1",
      [event],
    );
    expect(await find("join_code", (code?.join_code ?? "").toLowerCase())).toBe(event);
    expect(await find("quest", randomUUID())).toBeNull();
    expect(await find("quest", "not-a-uuid")).toBeNull();
    expect(await find("quest", `${quest}; DROP TABLE quest`)).toBeNull();
    expect(await find("player", quest)).toBeNull();
    expect(await find("join_code", "NOSUCH")).toBeNull();
  });

  it("is callable by the API's role and by nobody else", async () => {
    const [grants] = await f.owner<{ app: boolean; pub: boolean; outsider: boolean }>(
      `SELECT has_function_privilege('questify_app', 'play_event_id(text, text)', 'EXECUTE') AS app,
              has_function_privilege('public', 'play_event_id(text, text)', 'EXECUTE') AS pub,
              has_function_privilege('questify_outsider', 'play_event_id(text, text)', 'EXECUTE') AS outsider`,
    );
    expect(grants).toEqual({ app: true, pub: false, outsider: false });
  });
});
