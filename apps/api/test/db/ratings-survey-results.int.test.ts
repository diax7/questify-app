import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL } from "#test/support/test-db";
import { pushFixture, type PushFixture } from "#test/support/push";

type Summary = {
  total: number;
  questions: { id: string; answered: number; average: number | null; texts: string[] | null }[];
};
type Shared = Summary & { quest: { ar: string; en: string }; event: { ar: string; en: string } };
type Scores = { on: boolean; scores: { questId: string; up: number; down: number }[] };
type Mine = { eventId: string; on: boolean; thumb: string | null } | null;

/** A call's SQLSTATE and detail ("QR409:ratings_off"), or "none". */
const refusal = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "none",
    (error: { code?: string; detail?: string }) =>
      error.detail === undefined || error.detail === ""
        ? `${error.code}`
        : `${error.code}:${error.detail}`,
  );

const text = (en: string) => ({ ar: null, en });
const SURVEY = {
  questions: [
    {
      id: "fav",
      text: text("Favourite?"),
      kind: "choice",
      required: true,
      choices: [
        { id: "ai", text: text("AI") },
        { id: "web", text: text("Web") },
      ],
    },
    { id: "stars", text: text("How was it?"), kind: "rating", required: true },
    { id: "note", text: text("Anything else?"), kind: "text", required: false },
  ],
};
const HASH = "a".repeat(64);

/**
 * Quest ratings and survey sharing in the database (T-508, migration 0089; plan
 * docs/plans/2026-10-30-t-508-ratings-survey-results.md, ADR-376): a player who completed a quest rates it only while
 * the owner has ratings on, the team reads counts with no player in them, and a survey's results open through a link
 * whose hash is all the database keeps.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("ratings and survey results (database)", () => {
  let f: PushFixture;
  let event: string;
  beforeAll(async () => {
    f = await pushFixture();
    event = await f.newEvent({ phase: "live" });
  });
  afterAll(async () => {
    await f.close();
  });

  const switchRatings = (ev: string, on: boolean | null) =>
    f.owner(
      `UPDATE event SET config = jsonb_set(coalesce(config, '{}'::jsonb), '{features}',
         CASE WHEN $2::boolean IS NULL THEN coalesce(config -> 'features', '{}'::jsonb) - 'questRatings'
              ELSE coalesce(config -> 'features', '{}'::jsonb) || jsonb_build_object('questRatings', $2::boolean) END)
       WHERE id = $1`,
      [ev, on],
    );
  const makeQuest = async (ev = event, type = "scan_qr", config = "{}"): Promise<string> =>
    (
      await f.owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, visible, type_config)
         SELECT $1, id, $2, 'Station', 25, CASE WHEN $2 = 'scan_qr' THEN 3 ELSE 1 END, true, $3::jsonb FROM category WHERE event_id = $1 LIMIT 1
         RETURNING id`,
        [ev, type, config],
      )
    )[0]?.id ?? "";
  const makeMember = async (ev = event) => {
    const player = await f.newPlayer();
    return { player, enrollment: await f.join(ev, player) };
  };
  const complete = async (ev: string, enrollment: string, quest: string, method = "qr") => {
    const [org] = await f.owner<{ organizer_id: string }>(
      "SELECT organizer_id FROM event WHERE id = $1",
      [ev],
    );
    const [row] = await f.owner<{ id: string }>(
      `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method, idempotency_key)
       VALUES ($1, $2, $3, $4, 1, $5, $6) RETURNING id`,
      [org?.organizer_id, ev, enrollment, quest, method, randomUUID()],
    );
    return row?.id ?? "";
  };
  const rate = (player: string, quest: string, thumb: unknown) =>
    f.run<{ r: string }>({ playerId: player }, "SELECT rate_quest($1, $2) AS r", [quest, thumb]);
  const mine = async (player: string, quest: string): Promise<Mine> =>
    (
      await f.run<{ r: Mine }>({ playerId: player }, "SELECT member_quest_rating($1) AS r", [quest])
    )[0]?.r ?? null;
  const scores = async (ev = event, seat = f.team()): Promise<Scores> =>
    (await f.run<{ r: Scores }>(seat, "SELECT quest_rating_scores($1) AS r", [ev]))[0]?.r as Scores;

  const answers = async (quest: string, ev = event) => {
    for (const [index, body] of [
      { fav: "ai", stars: 5, note: "Great talk" },
      { fav: "web", stars: 3 },
      { fav: "ai", stars: 4, note: "Call me on 0501234567" },
    ].entries()) {
      const { enrollment } = await makeMember(ev);
      const completion = await complete(ev, enrollment, quest, "survey");
      const [org] = await f.owner<{ organizer_id: string }>(
        "SELECT organizer_id FROM event WHERE id = $1",
        [ev],
      );
      await f.owner(
        `INSERT INTO survey_response (organizer_id, event_id, enrollment_id, quest_id, answers, completion_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() - make_interval(secs => $7))`,
        [org?.organizer_id, ev, enrollment, quest, JSON.stringify(body), completion, 10 - index],
      );
    }
  };
  const save = (quest: string, hash = HASH, ev = event, seat = f.team()) =>
    f.run(seat, "SELECT survey_share_save($1, $2, $3, $4)", [ev, quest, hash, randomUUID()]);
  const open = async (hash: string): Promise<Shared | null> =>
    (
      await f.run<{ r: Shared | null }>(f.system, "SELECT survey_shared_results($1) AS r", [hash])
    )[0]?.r ?? null;
  const state = async (quest: string, ev = event, seat = f.team()) =>
    (
      await f.run<{ r: { shared: boolean } }>(seat, "SELECT survey_share_state($1, $2) AS r", [
        ev,
        quest,
      ])
    )[0]?.r;
  const revoke = async (quest: string, ev = event) =>
    (
      await f.run<{ r: boolean }>(f.team(), "SELECT survey_share_revoke($1, $2, $3) AS r", [
        ev,
        quest,
        randomUUID(),
      ])
    )[0]?.r;

  describe("ratings", () => {
    it("takes nothing while the owner has ratings off, which is the starting state", async () => {
      const quest = await makeQuest();
      const { player, enrollment } = await makeMember();
      await complete(event, enrollment, quest);
      expect(await mine(player, quest)).toMatchObject({ on: false, thumb: null });
      expect(await refusal(rate(player, quest, "up"))).toBe("QR409:ratings_off");
      expect((await scores()).on).toBe(false);
    });

    it("takes a thumb from a player who completed the quest, lets them change it, and never lets a skip undo it", async () => {
      await switchRatings(event, true);
      const quest = await makeQuest();
      const { player, enrollment } = await makeMember();
      expect(await refusal(rate(player, quest, "up"))).toBe("QR409:not_completed");
      await complete(event, enrollment, quest);
      expect((await rate(player, quest, "up"))[0]?.r).toBe("up");
      expect(await mine(player, quest)).toMatchObject({ on: true, thumb: "up", eventId: event });
      expect((await rate(player, quest, "down"))[0]?.r).toBe("down");
      expect((await rate(player, quest, "skip"))[0]?.r).toBe("down");
      expect((await mine(player, quest))?.thumb).toBe("down");
      expect((await rate(player, quest, "up"))[0]?.r).toBe("up");
    });

    it("remembers a skip so the prompt does not return, and a thumb replaces it", async () => {
      const quest = await makeQuest();
      const { player, enrollment } = await makeMember();
      await complete(event, enrollment, quest);
      expect((await rate(player, quest, "skip"))[0]?.r).toBe("skip");
      expect((await mine(player, quest))?.thumb).toBe("skip");
      expect((await rate(player, quest, "down"))[0]?.r).toBe("down");
    });

    it("refuses a thumb that is not up, down or skip, and answers a stranger and an unknown quest alike", async () => {
      const quest = await makeQuest();
      const { player, enrollment } = await makeMember();
      await complete(event, enrollment, quest);
      for (const bad of ["sideways", "", "UP", null])
        expect(await refusal(rate(player, quest, bad)), String(bad)).toBe("QR422");
      const stranger = await f.newPlayer();
      expect(await refusal(rate(stranger, quest, "up"))).toBe("QR404");
      expect(await refusal(rate(player, randomUUID(), "up"))).toBe("QR404");
      expect(await mine(stranger, quest)).toBeNull();
      expect(await mine(player, randomUUID())).toBeNull();
      expect(await refusal(f.run(f.team(), "SELECT rate_quest($1, 'up')", [quest]))).toBe("QR404");
      const left = await makeMember();
      await complete(event, left.enrollment, quest);
      await f.owner("UPDATE enrollment SET status = 'left' WHERE id = $1", [left.enrollment]);
      expect(await refusal(rate(left.player, quest, "up"))).toBe("QR404");
    });

    it("counts thumbs per quest for the team, skips apart, and names no player", async () => {
      const ev = await f.newEvent({ phase: "live" });
      await switchRatings(ev, true);
      const [liked, mixed, skipped] = [
        await makeQuest(ev),
        await makeQuest(ev),
        await makeQuest(ev),
      ];
      for (const [quest, thumbs] of [
        [liked, ["up", "up", "up"]],
        [mixed, ["up", "down", "down", "skip"]],
        [skipped, ["skip"]],
      ] as const) {
        for (const thumb of thumbs) {
          const { player, enrollment } = await makeMember(ev);
          await complete(ev, enrollment, quest);
          await rate(player, quest, thumb);
        }
      }
      const seen = await scores(ev);
      expect(seen.on).toBe(true);
      expect(seen.scores.find((row) => row.questId === liked)).toEqual({
        questId: liked,
        up: 3,
        down: 0,
      });
      expect(seen.scores.find((row) => row.questId === mixed)).toEqual({
        questId: mixed,
        up: 1,
        down: 2,
      });
      expect(seen.scores.some((row) => row.questId === skipped)).toBe(false);
      expect(Object.keys(seen)).toEqual(["on", "scores"]);
      expect(Object.keys(seen.scores[0] ?? {}).toSorted()).toEqual(["down", "questId", "up"]);
    });

    it("keeps the counts to the owner's own team and event", async () => {
      expect(
        await refusal(
          f.run(f.team(f.ownerA, f.ids.orgB), "SELECT quest_rating_scores($1)", [event]),
        ),
      ).toBe("AN404");
      expect(
        await refusal(
          f.run({ playerId: await f.newPlayer() }, "SELECT quest_rating_scores($1)", [event]),
        ),
      ).toBe("AN404");
      expect(await refusal(f.run(f.team(), "SELECT quest_rating_scores($1)", [randomUUID()]))).toBe(
        "AN404",
      );
    });

    it("drops a rating with its enrollment or its quest, and stops rating once the event is archived", async () => {
      const ev = await f.newEvent({ phase: "live" });
      await switchRatings(ev, true);
      const quest = await makeQuest(ev);
      const gone = await makeQuest(ev);
      const { player, enrollment } = await makeMember(ev);
      await complete(ev, enrollment, quest);
      await complete(ev, enrollment, gone);
      await rate(player, quest, "up");
      await rate(player, gone, "up");
      await f.owner("DELETE FROM quest_completion WHERE quest_id = $1", [gone]);
      await f.owner("DELETE FROM quest WHERE id = $1", [gone]);
      expect(await f.owner("SELECT 1 FROM quest_rating WHERE quest_id = $1", [gone])).toEqual([]);
      expect(await f.owner("SELECT 1 FROM quest_rating WHERE quest_id = $1", [quest])).toHaveLength(
        1,
      );
      await f.owner("UPDATE event SET status = 'archived' WHERE id = $1", [ev]);
      expect(await refusal(rate(player, quest, "down"))).toBe("QR404");
      expect(await mine(player, quest)).toBeNull();
      const second = await f.newEvent({ phase: "live" });
      const kept = await makeQuest(second);
      const member = await makeMember(second);
      await complete(second, member.enrollment, kept);
      await switchRatings(second, true);
      await rate(member.player, kept, "up");
      await f.owner("DELETE FROM quest_completion WHERE enrollment_id = $1", [member.enrollment]);
      await f.owner("DELETE FROM enrollment WHERE id = $1", [member.enrollment]);
      expect(await f.owner("SELECT 1 FROM quest_rating WHERE event_id = $1", [second])).toEqual([]);
    });

    it("reads the switch only from an explicit true", async () => {
      const ev = await f.newEvent({ phase: "live" });
      const quest = await makeQuest(ev);
      const { player, enrollment } = await makeMember(ev);
      await complete(ev, enrollment, quest);
      for (const [value, expected] of [
        [null, "QR409:ratings_off"],
        [false, "QR409:ratings_off"],
        [true, "none"],
      ] as const) {
        await switchRatings(ev, value);
        expect(await refusal(rate(player, quest, "up")), String(value)).toBe(expected);
      }
    });
  });

  describe("the speaker's link", () => {
    it("opens the one quest's results by the hash of its link, with the names of the quest and event and no player", async () => {
      const quest = await makeQuest(event, "survey", JSON.stringify(SURVEY));
      const other = await makeQuest(event, "survey", JSON.stringify(SURVEY));
      await answers(quest);
      await answers(other);
      expect(await state(quest)).toMatchObject({ shared: false });
      await save(quest);
      expect(await state(quest)).toMatchObject({ shared: true });
      expect(await state(other)).toMatchObject({ shared: false });
      const shared = await open(HASH);
      const team = (
        await f.run<{ r: Summary }>(f.team(), "SELECT survey_summary($1, $2) AS r", [event, quest])
      )[0]?.r;
      expect(shared).toMatchObject({ quest: { en: "Station" } });
      expect({ total: shared?.total, questions: shared?.questions }).toEqual(team);
      expect(shared?.total).toBe(3);
      expect(shared?.questions[1]?.average).toBe(4);
      const dump = JSON.stringify(shared);
      expect(dump).not.toMatch(/enrollment|player|completion|organizer/iu);
      expect(Object.keys(shared ?? {}).toSorted()).toEqual(
        ["event", "questions", "quest", "total"].toSorted(),
      );
    });

    it("replaces the link with a new one and stops it at once when the team stops sharing", async () => {
      const quest = await makeQuest(event, "survey", JSON.stringify(SURVEY));
      const [first, second] = ["b".repeat(64), "c".repeat(64)];
      await save(quest, first);
      expect(await open(first ?? "")).not.toBeNull();
      await save(quest, second);
      expect(await open(first ?? "")).toBeNull();
      expect(await open(second ?? "")).not.toBeNull();
      expect(await revoke(quest)).toBe(true);
      expect(await open(second ?? "")).toBeNull();
      expect(await revoke(quest)).toBe(false);
      expect(await open("d".repeat(64))).toBeNull();
    });

    it("refuses a quest that is not a survey of the caller's event, and a foreign team", async () => {
      const plain = await makeQuest();
      const survey = await makeQuest(event, "survey", JSON.stringify(SURVEY));
      for (const sql of [
        "SELECT survey_share_state($1, $2)",
        "SELECT survey_share_save($1, $2, repeat('e', 64), gen_random_uuid())",
        "SELECT survey_share_revoke($1, $2, gen_random_uuid())",
      ]) {
        expect(await refusal(f.run(f.team(), sql, [event, plain])), sql).toBe("AN404");
        expect(await refusal(f.run(f.team(), sql, [event, randomUUID()])), sql).toBe("AN404");
        expect(await refusal(f.run(f.team(f.ownerA, f.ids.orgB), sql, [event, survey])), sql).toBe(
          "AN404",
        );
        expect(
          await refusal(f.run({ playerId: await f.newPlayer() }, sql, [event, survey])),
          sql,
        ).toBe("AN404");
      }
    });

    it("keeps a hash well formed and one link per quest, and takes the link with its quest", async () => {
      const quest = await makeQuest(event, "survey", JSON.stringify(SURVEY));
      expect(await refusal(save(quest, "not-a-hash"))).toMatch(/^23514/u);
      await save(quest, "f".repeat(64));
      expect(await f.owner("SELECT 1 FROM survey_share WHERE quest_id = $1", [quest])).toHaveLength(
        1,
      );
      await f.owner("DELETE FROM quest WHERE id = $1", [quest]);
      expect(await open("f".repeat(64))).toBeNull();
    });

    it("audits making and stopping a link by quest, never by the link", async () => {
      const quest = await makeQuest(event, "survey", JSON.stringify(SURVEY));
      await save(quest, "9".repeat(64));
      await revoke(quest);
      const rows = await f.owner<{ action: string; after: unknown }>(
        "SELECT action, after FROM audit_log WHERE target_id = $1 AND action LIKE 'survey.%' ORDER BY id",
        [quest],
      );
      expect(rows.map((row) => row.action)).toEqual(["survey.share", "survey.unshare"]);
      expect(JSON.stringify(rows)).not.toContain("9999");
    });
  });
});
