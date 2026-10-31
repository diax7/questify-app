import { randomUUID } from "node:crypto";
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

/**
 * Live points edits over HTTP (T-604, FR-411, FR-412, FR-413): new points in a live event with real completions must
 * say future or past (409 apply_required), "also past" needs a key and replays it, the impact read gives the screen
 * its numbers, and a played quest's delete must say keep or remove (409 points_choice_required).
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("live points edits over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let organizer = "";
  let cookie = "";
  let counter = 0;

  const owner = async <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const call = (
    method: "GET" | "PATCH" | "DELETE",
    url: string,
    payload?: object,
    headers: Record<string, string> = {},
  ): Promise<LightMyRequestResponse> =>
    test.app.inject({
      method,
      url: `/v1/organizers/${organizer}${url}`,
      headers: withSession(cookie, headers),
      ...(payload === undefined ? {} : { payload }),
    });

  /** A live event with one quest of `type` at 100 points that `players` players completed. */
  const played = async (players: number, type = "enter_code") => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Live Fest', 'live', now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
      [organizer, `LIV${counter}`],
    );
    const [quest] = await owner<{ id: string }>(
      `WITH c AS (INSERT INTO category (event_id, name_en) VALUES ($1, 'General') RETURNING id)
       INSERT INTO quest (event_id, category_id, type, title_en, points, type_config, visible)
       SELECT $1, c.id, $2, 'Stage', 100, $3, true FROM c RETURNING id`,
      [
        event?.id,
        type,
        JSON.stringify(
          type === "quiz"
            ? {
                questions: [
                  {
                    id: "q1",
                    text: { en: "?" },
                    choices: [
                      { id: "r", text: { en: "R" } },
                      { id: "w", text: { en: "W" } },
                    ],
                    right: "r",
                  },
                ],
              }
            : { code: "ABC" },
        ),
      ],
    );
    for (let i = 0; i < players; i += 1) {
      counter += 1;
      const [player] = await owner<{ id: string }>(
        "INSERT INTO player (username) VALUES ($1) RETURNING id",
        [`live_${counter}`],
      );
      const [enrolled] = await owner<{ id: string }>(
        "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3) RETURNING id",
        [organizer, event?.id, player?.id],
      );
      const [done] = await owner<{ id: string }>(
        `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method, idempotency_key)
         VALUES ($1, $2, $3, $4, 1, 'code', $5) RETURNING id`,
        [organizer, event?.id, enrolled?.id, quest?.id, randomUUID()],
      );
      await owner(
        `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, completion_id,
                                   quest_id, actor)
         VALUES ($1, $2, $3, 'quest', 100, 100, $4, $5, 'player')`,
        [organizer, event?.id, enrolled?.id, done?.id, quest?.id],
      );
    }
    return { event: event?.id ?? "", quest: quest?.id ?? "" };
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
    organizer =
      (
        await owner<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ('live-edits', 'live-edits') RETURNING id",
        )
      )[0]?.id ?? "";
    const staff = await createStaff(db.owner, { email: "owner@live-edits.test" });
    await owner(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [organizer, staff],
    );
    cookie = await signInFully(test, "owner@live-edits.test");
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  it("asks future or past for new points on a played quest, and runs also past with a key, once", async () => {
    const { event, quest } = await played(3);
    const path = `/events/${event}/quests/${quest}`;
    const asked = await call("PATCH", path, { points: 150, confirm: true });
    expect([asked.statusCode, asked.json().code]).toEqual([409, "apply_required"]);
    const keyless = await call("PATCH", path, { points: 150, confirm: true, apply: "past" });
    expect([keyless.statusCode, keyless.json().code]).toEqual([400, "idempotency_key_required"]);
    const key = { "idempotency-key": randomUUID() };
    const ran = await call("PATCH", path, { points: 150, confirm: true, apply: "past" }, key);
    expect(ran.statusCode).toBe(200);
    expect(ran.json()).toMatchObject({
      quest: { points: 150 },
      change: { completions: 3, players: 3, raised: 3, lowered: 0, clamped: 0, replayed: false },
    });
    const again = await call("PATCH", path, { points: 150, confirm: true, apply: "past" }, key);
    expect(again.json()).toMatchObject({ change: { completions: 3, replayed: true } });
    const reused = await call("PATCH", path, { points: 170, confirm: true, apply: "past" }, key);
    expect([reused.statusCode, reused.json().code]).toEqual([422, "idempotency_key_reused"]);
    const future = await call("PATCH", path, { points: 120, confirm: true, apply: "future" });
    expect(future.json()).not.toHaveProperty("change");
    const [standing] = await owner<{ score: string }>(
      "SELECT max(score) AS score FROM enrollment WHERE event_id = $1",
      [event],
    );
    expect(standing?.score).toBe("150");
  });

  it("refuses also past for a type that pays its own amounts, and needs no choice for an unplayed quest", async () => {
    const quiz = await played(1, "quiz");
    const refused = await call(
      "PATCH",
      `/events/${quiz.event}/quests/${quiz.quest}`,
      { points: 5, confirm: true, apply: "past" },
      { "idempotency-key": randomUUID() },
    );
    expect([refused.statusCode, refused.json()]).toMatchObject([
      422,
      { code: "invalid_quest", details: { field: "apply" } },
    ]);
    const fresh = await played(0);
    const edited = await call("PATCH", `/events/${fresh.event}/quests/${fresh.quest}`, {
      points: 5,
      confirm: true,
    });
    expect(edited.statusCode).toBe(200);
  });

  it("answers the impact of new points with real numbers", async () => {
    const { event, quest } = await played(2);
    const impact = await call("GET", `/events/${event}/quests/${quest}/impact?points=60`);
    expect(impact.json()).toEqual({
      eligible: true,
      completions: 2,
      players: 2,
      raise: 0,
      lower: 2,
      clamped: 0,
      prizesHanded: 0,
    });
    expect(
      (await call("GET", `/events/${event}/quests/${randomUUID()}/impact?points=60`)).statusCode,
    ).toBe(404);
    expect(
      (await call("GET", `/events/${event}/quests/${quest}/impact?points=-1`)).statusCode,
    ).toBe(400);
  });

  it("asks keep or remove before deleting a played quest, then hides it from the builder", async () => {
    const { event, quest } = await played(2);
    const path = `/events/${event}/quests/${quest}`;
    const asked = await call("DELETE", path, { confirm: true });
    expect([asked.statusCode, asked.json().code]).toEqual([409, "points_choice_required"]);
    expect((await call("DELETE", path, { confirm: true, points: "remove" })).statusCode).toBe(204);
    const [row] = await owner<{ total: string }>(
      "SELECT sum(score) AS total FROM enrollment WHERE event_id = $1",
      [event],
    );
    expect(row?.total).toBe("0");
    const builder = await call("GET", `/events/${event}/quests`);
    expect(JSON.stringify(builder.json())).not.toContain(quest);
    expect((await call("DELETE", path, { confirm: true, points: "keep" })).statusCode).toBe(404);
  });
});
