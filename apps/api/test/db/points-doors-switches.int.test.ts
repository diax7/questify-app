import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSettingsService } from "#src/settings/service";
import { eventFeatureOn } from "#src/settings/feature-guard";
import { TEST_DATABASE_URL } from "#test/support/test-db";
import { pushFixture, type PushFixture } from "#test/support/push";

/** A call's SQLSTATE and detail ("RS403:feature_off"), or "none". */
const refusal = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "none",
    (error: { code?: string; detail?: string }) =>
      error.detail === undefined || error.detail === ""
        ? `${error.code}`
        : `${error.code}:${error.detail}`,
  );

const OPTIONS = [
  { id: "a", text: { en: "Robots" } },
  { id: "b", text: { en: "Space" } },
];

/**
 * The event's switches inside the points doors (T-602c, migration 0094; plan
 * docs/plans/2026-10-31-t-505b-t-602c-points-doors.md, ADR-383): the shop switch refuses a new reservation and the polls
 * switch a live poll's vote and reads, in the database, with `feature_off`; a retry of a request that already succeeded
 * answers as before; a prize already held is handed over, cancelled or expires as before; a plain vote quest stays open;
 * a non-member learns nothing; and the database's rule agrees with the API's composed configuration.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("switches in the points doors (database)", () => {
  let f: PushFixture;
  beforeAll(async () => {
    f = await pushFixture();
  });
  afterAll(async () => {
    await f.close();
  });

  const setSwitch = (event: string, key: string, on: boolean) =>
    f.owner(
      `UPDATE event SET config = jsonb_set(config, '{features}', coalesce(config -> 'features', '{}')
         || jsonb_build_object($2::text, $3::boolean)) WHERE id = $1`,
      [event, key, on],
    );
  const setPlatform = (key: string, on: boolean | null) =>
    on === null
      ? f.owner("DELETE FROM platform_setting WHERE key = 'features'")
      : f.owner(
          `INSERT INTO platform_setting (key, value) VALUES ('features', jsonb_build_object($1::text,
             jsonb_build_object('enabled', $2::boolean)))
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [key, on],
        );
  /** A member holding 500 points, written as a staff award. */
  const funded = async (event: string) => {
    const player = await f.newPlayer();
    const enrollment = await f.join(event, player, "code");
    await f.owner(
      `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor,
                                 staff_user_id)
       SELECT organizer_id, event_id, id, 'award', 500, 500, 'staff', $2 FROM enrollment WHERE id = $1`,
      [enrollment, f.ownerA],
    );
    return { player, enrollment };
  };
  const balanceOf = async (enrollment: string) =>
    (
      await f.owner<{ balance: string }>("SELECT balance FROM enrollment WHERE id = $1", [
        enrollment,
      ])
    )[0]?.balance;
  const newReward = async (event: string) =>
    (
      await f.owner<{ id: string }>(
        `INSERT INTO reward (event_id, kind, name_en, price, stock_total)
         VALUES ($1, 'item', 'Mug', 100, 5) RETURNING id`,
        [event],
      )
    )[0]?.id ?? "";
  const reserve = (player: string, reward: string, key = randomUUID()) =>
    f.run<{ redemption_id: string; status: string; replayed: boolean }>(
      { playerId: player },
      "SELECT redemption_id, status, replayed FROM reserve_reward($1, $2)",
      [reward, key],
    );

  const newVote = async (event: string, live: boolean) => {
    const config = live
      ? { options: OPTIONS, live: { choices: "one", results: "after_vote", minutes: 5 } }
      : { options: OPTIONS };
    const [quest] = await f.owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config, visible)
       SELECT e.id, c.id, 'vote', 'Pick', 10, $2, true FROM event e JOIN category c ON c.event_id = e.id
       WHERE e.id = $1 LIMIT 1 RETURNING id`,
      [event, JSON.stringify(config)],
    );
    if (live) {
      await f.owner(
        "UPDATE quest SET opens_at = now() - interval '1 minute', closes_at = now() + interval '5 minutes' WHERE id = $1",
        [quest?.id],
      );
    }
    return quest?.id ?? "";
  };
  const vote = (player: string, quest: string, key = randomUUID()) =>
    f.run<{ completion_id: string; replayed: boolean }>(
      { playerId: player },
      "SELECT completion_id, replayed FROM vote_quest($1, '{a}', $2)",
      [quest, key],
    );

  describe("the shop switch", () => {
    it("refuses a new reservation, replays an earlier one, and leaves a held prize to the desk", async () => {
      const event = await f.newEvent({ phase: "live" });
      const reward = await newReward(event);
      const who = await funded(event);
      const key = randomUUID();
      const [held] = await reserve(who.player, reward, key);
      const [kept] = await reserve(who.player, reward);
      await setSwitch(event, "shop", false);
      expect(await refusal(reserve(who.player, reward))).toBe("RS403:feature_off");
      expect(await balanceOf(who.enrollment)).toBe("300");
      expect(await f.count("redemption WHERE enrollment_id = $1", [who.enrollment])).toBe(2);
      expect((await reserve(who.player, reward, key))[0]).toMatchObject({
        redemption_id: held?.redemption_id,
        replayed: true,
      });
      const [cancelled] = await f.run<{ status: string }>(
        { playerId: who.player },
        "SELECT status FROM cancel_redemption($1)",
        [kept?.redemption_id],
      );
      expect(cancelled?.status).toBe("cancelled");
      const desk = await f.newPlayer();
      await f.owner(
        `INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities)
         SELECT organizer_id, id, $2, '{hand_over}' FROM event WHERE id = $1`,
        [event, desk],
      );
      await f.run({ playerId: who.player }, "SELECT start_collect($1)", [held?.redemption_id]);
      const [given] = await f.run<{ status: string }>(
        { playerId: desk },
        "SELECT * FROM desk_hand_over($1)",
        [held?.redemption_id],
      );
      expect(given?.status).toBe("handed_over");
    });

    it("refuses while the platform's shop switch is off, for every event", async () => {
      const event = await f.newEvent({ phase: "live" });
      const reward = await newReward(event);
      const who = await funded(event);
      await setPlatform("shop", false);
      try {
        expect(await refusal(reserve(who.player, reward))).toBe("RS403:feature_off");
      } finally {
        await setPlatform("shop", null);
      }
      expect((await reserve(who.player, reward))[0]?.status).toBe("reserved");
    });
  });

  describe("the polls switch", () => {
    it("refuses a live poll's new vote and its reads, replays an earlier vote, keeps a plain vote open", async () => {
      const event = await f.newEvent({ phase: "live" });
      const poll = await newVote(event, true);
      const plain = await newVote(event, false);
      const early = await f.newPlayer();
      await f.join(event, early);
      const late = await f.newPlayer();
      await f.join(event, late);
      const key = randomUUID();
      const [first] = await vote(early, poll, key);
      await setSwitch(event, "polls", false);
      try {
        expect(await refusal(vote(late, poll))).toBe("PF403:feature_off");
        expect(await f.count("quest_completion WHERE quest_id = $1", [poll])).toBe(1);
        expect((await vote(early, poll, key))[0]).toMatchObject({
          completion_id: first?.completion_id,
          replayed: true,
        });
        expect((await vote(late, plain))[0]?.replayed).toBe(false);
        for (const sql of [
          "SELECT * FROM member_poll($1)",
          "SELECT * FROM member_vote($1)",
          "SELECT * FROM poll_results($1)",
        ]) {
          expect(await refusal(f.run({ playerId: early }, sql, [poll])), sql).toBe(
            "PF403:feature_off",
          );
        }
        expect(
          await f.run({ playerId: early }, "SELECT option_id FROM member_vote($1)", [plain]),
        ).toHaveLength(2);
        const stranger = await f.newPlayer();
        expect(
          await f.run({ playerId: stranger }, "SELECT * FROM member_poll($1)", [poll]),
        ).toEqual([]);
        expect(
          await f.run({ playerId: stranger }, "SELECT * FROM member_vote($1)", [poll]),
        ).toEqual([]);
        expect(
          await refusal(f.run({ playerId: stranger }, "SELECT * FROM poll_results($1)", [poll])),
        ).toBe("QC404");
      } finally {
        await setSwitch(event, "polls", true);
      }
      expect((await vote(late, poll))[0]?.replayed).toBe(false);
    });

    it("another event's switch changes nothing here", async () => {
      const here = await f.newEvent({ phase: "live" });
      const there = await f.newEvent({ phase: "live" });
      const poll = await newVote(here, true);
      const reward = await newReward(here);
      const who = await funded(here);
      await setSwitch(there, "polls", false);
      await setSwitch(there, "shop", false);
      expect((await vote(who.player, poll))[0]?.replayed).toBe(false);
      expect((await reserve(who.player, reward))[0]?.status).toBe("reserved");
    });
  });

  it("the database's switch agrees with the API's composed configuration in all four states", async () => {
    const settings = createSettingsService({ pool: f.pool, ttlMs: 0 });
    const event = await f.newEvent({ phase: "live" });
    const player = await f.newPlayer();
    await f.join(event, player);
    for (const key of ["shop", "polls"]) {
      for (const [eventOn, platformOn] of [
        [true, true],
        [false, true],
        [true, false],
        [false, false],
      ] as const) {
        await setSwitch(event, key, eventOn);
        await setPlatform(key, platformOn);
        const [row] = await f.owner<{ on: boolean }>(
          "SELECT feature_enabled(e, $2) AS on FROM event e WHERE e.id = $1",
          [event, key],
        );
        const api = await eventFeatureOn(settings, event, player, key);
        expect({ key, eventOn, platformOn, db: row?.on }).toEqual({
          key,
          eventOn,
          platformOn,
          db: api,
        });
      }
    }
    await setPlatform("shop", null);
  });
});
