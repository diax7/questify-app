import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext, type RequestContext } from "#src/db/context";
import {
  TEST_DATABASE_URL,
  addMember,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

type Row = Record<string, unknown>;
type Paid = {
  completion_id: string;
  points: string;
  score: string;
  balance: string;
  replayed: boolean;
};
type Summary = {
  total: number;
  questions: {
    id: string;
    kind: string;
    answered: number;
    choices: { id: string; count: number }[] | null;
    average: number | null;
    texts: string[] | null;
  }[];
};

const refusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
    return "none";
  } catch (error) {
    const pg = error as { code?: string; detail?: string };
    return pg.detail === undefined || pg.detail === "" ? `${pg.code}` : `${pg.code}:${pg.detail}`;
  }
};

const text = (en: string) => ({ en });
const as = (player: string): RequestContext => ({ playerId: player });
const SURVEY = {
  questions: [
    {
      id: "fav",
      text: text("Favourite talk?"),
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
const SHARE = { message: { en: "I am at Quest Fest!" }, link: "https://example.com/fest" };

/**
 * Challenge, survey and share quests in the database (T-303, migration 0042, ADR-196 to ADR-199): a challenge paid
 * only by staff, one survey response with its answers checked and its results for the team with names not shown, a
 * share paid once and switched off per event, the structure lock, erasure, the rehearsal wipe and the closed doors.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)(
  "challenge, survey and share quests (database)",
  () => {
    let db: TestDatabase;
    let pool: Pool;
    let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
    let ownerA = "";
    let ownerB = "";
    let counter = 0;

    beforeAll(async () => {
      db = await createTestDatabase();
      pool = new Pool({ connectionString: db.appUrl, max: 6 });
      ids = await seedTwoTenants(db.owner);
      ownerA = await addMember(db.owner, ids.orgA, "owner");
      ownerB = await addMember(db.owner, ids.orgB, "owner");
    });
    afterAll(async () => {
      await pool.end();
      await db.close();
    });

    const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
      (await db.owner.query<T>(sql, values)).rows;
    const query = async <T extends Row>(
      context: RequestContext,
      sql: string,
      values: unknown[] = [],
    ) => {
      const client: PoolClient = await pool.connect();
      try {
        return await withRequestContext(
          client,
          context,
          async () => (await client.query<T>(sql, values)).rows,
        );
      } finally {
        client.release();
      }
    };
    const teamA = (): RequestContext => ({ organizerId: ids.orgA, staffUserId: ownerA });
    const teamB = (): RequestContext => ({ organizerId: ids.orgB, staffUserId: ownerB });

    const newEvent = async (status = "live"): Promise<string> => {
      counter += 1;
      const [event] = await owner<{ id: string }>(
        `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Quest Fest', $3, now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
        [ids.orgA, `CSS${counter}`, status],
      );
      return event?.id ?? "";
    };
    const newQuest = async (event: string, type: string, config: object = {}, points = 10) => {
      const [category] = await owner<{ id: string }>(
        "INSERT INTO category (event_id, name_en) VALUES ($1, 'General') RETURNING id",
        [event],
      );
      const [quest] = await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
       VALUES ($1, $2, $3, 'Play', $4, $5) RETURNING id`,
        [event, category?.id, type, points, JSON.stringify(config)],
      );
      return quest?.id ?? "";
    };
    const member = async (event: string, via = "code") => {
      counter += 1;
      const [player] = await owner<{ id: string }>(
        "INSERT INTO player (username) VALUES ($1) RETURNING id",
        [`css_player_${counter}`],
      );
      const [made] = await owner<{ id: string }>(
        "INSERT INTO enrollment (organizer_id, event_id, player_id, joined_via) VALUES ($1, $2, $3, $4) RETURNING id",
        [ids.orgA, event, player?.id, via],
      );
      return { player: player?.id ?? "", enrollment: made?.id ?? "" };
    };
    const operatorOf = async (event: string, abilities = "{scan_quests}") => {
      const { player } = await member(event);
      await owner(
        "INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities) VALUES ($1, $2, $3, $4)",
        [ids.orgA, event, player, abilities],
      );
      return player;
    };
    const stationScan = async (operator: string, quest: string, scanned: string) =>
      (
        await query<Paid>(as(operator), "SELECT * FROM operator_complete_quest($1, $2, 1, $3)", [
          quest,
          scanned,
          randomUUID(),
        ])
      )[0] as Paid;
    const survey = async (
      player: string,
      quest: string,
      answers: unknown,
      key: string = randomUUID(),
    ) =>
      (
        await query<Paid>(as(player), "SELECT * FROM submit_survey($1, $2, $3)", [
          quest,
          JSON.stringify(answers),
          key,
        ])
      )[0] as Paid;
    const share = async (player: string, quest: string, key: string = randomUUID()) =>
      (await query<Paid>(as(player), "SELECT * FROM share_quest($1, $2)", [quest, key]))[0] as Paid;
    const summary = async (context: RequestContext, event: string, quest: string) =>
      (
        await query<{ summary: Summary }>(context, "SELECT survey_summary($1, $2) AS summary", [
          event,
          quest,
        ])
      )[0]?.summary as Summary;
    const completions = async (enrollment: string) =>
      owner<{ method: string }>("SELECT method FROM quest_completion WHERE enrollment_id = $1", [
        enrollment,
      ]);
    const good = { fav: "ai", stars: 4 };

    describe("challenge quests", () => {
      it("is paid only by an operator's My QR scan, never by the player's own scan or code", async () => {
        const event = await newEvent();
        const quest = await newQuest(event, "challenge", {}, 30);
        const { player, enrollment } = await member(event);
        for (const method of ["qr", "code", "my_qr"]) {
          expect(
            await refusal(
              query(as(player), "SELECT * FROM complete_quest($1, $2, 1, 'X', $3, NULL)", [
                quest,
                method,
                randomUUID(),
              ]),
            ),
          ).toMatch(/^QV422/);
        }
        const operator = await operatorOf(event);
        expect(await stationScan(operator, quest, player)).toMatchObject({ points: "30" });
        expect(await completions(enrollment)).toEqual([{ method: "my_qr" }]);
      });

      it("defaults to My QR and holds that one method in the database", async () => {
        const event = await newEvent();
        const quest = await newQuest(event, "challenge");
        expect(await owner("SELECT verification FROM quest WHERE id = $1", [quest])).toEqual([
          { verification: ["my_qr"] },
        ]);
        for (const methods of [["quest_qr"], ["quest_qr", "my_qr"], []]) {
          await expect(
            owner("UPDATE quest SET verification = $2 WHERE id = $1", [quest, methods]),
          ).rejects.toMatchObject({ code: "23514" });
        }
      });

      it("refuses an operator without scanning or outside their quests, and lists challenges at the station", async () => {
        const event = await newEvent();
        const quest = await newQuest(event, "challenge");
        const scanQuest = await newQuest(event, "scan_qr");
        await owner("UPDATE quest SET verification = '{quest_qr,my_qr}' WHERE id = $1", [
          scanQuest,
        ]);
        const { player } = await member(event);
        const helper = await operatorOf(event, "{review}");
        expect(await refusal(stationScan(helper, quest, player))).toBe("OA403");
        const limited = await operatorOf(event);
        await owner(
          `INSERT INTO staff_assignment_quest (assignment_id, event_id, quest_id)
         SELECT id, event_id, $3 FROM staff_assignment WHERE event_id = $1 AND player_id = $2`,
          [event, limited, scanQuest],
        );
        expect(await refusal(stationScan(limited, quest, player))).toBe("OS403");
        const operator = await operatorOf(event);
        expect(
          await query(as(operator), "SELECT quest_id, type FROM operator_stations($1)", [event]),
        ).toEqual([
          { quest_id: quest, type: "challenge" },
          { quest_id: scanQuest, type: "scan_qr" },
        ]);
      });

      it("is confirmed by the owner's manual award", async () => {
        const event = await newEvent();
        const quest = await newQuest(event, "challenge", {}, 15);
        const { enrollment } = await member(event);
        await query(teamA(), "SELECT * FROM staff_award($1, $2, $3, NULL, 'Did it', $4, $5)", [
          event,
          enrollment,
          quest,
          randomUUID(),
          randomUUID(),
        ]);
        expect(await completions(enrollment)).toEqual([{ method: "manual" }]);
      });
    });

    describe("survey quests", () => {
      it("pays one response, replays its key, refuses other answers under it and a second response", async () => {
        const event = await newEvent();
        const quest = await newQuest(event, "survey", SURVEY, 20);
        const { player, enrollment } = await member(event);
        const key = randomUUID();
        const first = await survey(player, quest, { ...good, note: "  Great!  " }, key);
        expect(first).toMatchObject({ points: "20", score: "20", replayed: false });
        expect(await survey(player, quest, { ...good, note: "Great!" }, key)).toEqual({
          ...first,
          replayed: true,
        });
        expect(await refusal(survey(player, quest, { fav: "web", stars: 4 }, key))).toBe("QK422");
        expect(await refusal(survey(player, quest, good))).toBe("QD409:1");
        expect(await completions(enrollment)).toEqual([{ method: "survey" }]);
        expect(
          await owner("SELECT answers FROM survey_response WHERE enrollment_id = $1", [enrollment]),
        ).toEqual([{ answers: { fav: "ai", stars: 4, note: "Great!" } }]);
        expect(await query(as(player), "SELECT member_survey($1) AS s", [quest])).toEqual([
          { s: { questions: SURVEY.questions, answered: true } },
        ]);
      });

      it("refuses each bad answer by its question id, never echoing the answer", async () => {
        const event = await newEvent();
        const quest = await newQuest(event, "survey", SURVEY);
        const { player } = await member(event);
        const cases: [unknown, string][] = [
          [[], "SA422:shape"],
          [{ ...good, other: "x" }, "SA422:shape"],
          [{ stars: 4 }, "SA422:fav"],
          [{ ...good, fav: "nope" }, "SA422:fav"],
          [{ ...good, fav: 1 }, "SA422:fav"],
          [{ ...good, stars: 0 }, "SA422:stars"],
          [{ ...good, stars: 6 }, "SA422:stars"],
          [{ ...good, stars: 3.5 }, "SA422:stars"],
          [{ ...good, stars: "4" }, "SA422:stars"],
          [{ ...good, note: "x".repeat(501) }, "SA422:note"],
          [{ ...good, note: "secret‮word" }, "SA422:note"],
          [{ ...good, note: 7 }, "SA422:note"],
        ];
        for (const [answers, expected] of cases) {
          expect(await refusal(survey(player, quest, answers)), JSON.stringify(answers)).toBe(
            expected,
          );
        }
        try {
          await survey(player, quest, { ...good, note: "secret‮word" });
        } catch (error) {
          expect(JSON.stringify(error)).not.toContain("secret");
          expect(String((error as Error).message)).not.toContain("secret");
        }
        expect(await refusal(survey(player, await newQuest(event, "share", SHARE), good))).toBe(
          "QT422:survey",
        );
      });

      it("keeps a blank optional answer as unanswered and refuses a blank required one", async () => {
        const event = await newEvent();
        const required = {
          questions: [{ id: "why", text: text("Why?"), kind: "text", required: true }],
        };
        const quest = await newQuest(event, "survey", SURVEY);
        const strict = await newQuest(event, "survey", required);
        const { player, enrollment } = await member(event);
        expect(await refusal(survey(player, strict, { why: " \n " }))).toBe("SA422:why");
        await survey(player, quest, { ...good, note: " \n\t" });
        expect(
          await owner("SELECT answers FROM survey_response WHERE enrollment_id = $1", [enrollment]),
        ).toEqual([{ answers: good }]);
        const other = await member(event);
        await survey(other.player, quest, { ...good, note: null });
      });

      it("refuses every closed door, and a manual award uses the survey up", async () => {
        const event = await newEvent();
        const quest = await newQuest(event, "survey", SURVEY);
        const { player, enrollment } = await member(event);
        expect(await refusal(survey(randomUUID(), quest, good))).toBe("QC404");
        await owner("UPDATE quest SET closes_at = now() - interval '1 minute' WHERE id = $1", [
          quest,
        ]);
        expect(await refusal(survey(player, quest, good))).toBe("QN403:ended");
        await owner("UPDATE quest SET closes_at = NULL WHERE id = $1", [quest]);
        await query(teamA(), "SELECT * FROM staff_award($1, $2, $3, NULL, 'Paper form', $4, $5)", [
          event,
          enrollment,
          quest,
          randomUUID(),
          randomUUID(),
        ]);
        expect(await refusal(survey(player, quest, good))).toBe("QD409:1");
        const banned = await member(event);
        await owner("UPDATE enrollment SET status = 'banned' WHERE id = $1", [banned.enrollment]);
        expect(await refusal(survey(banned.player, quest, good))).toBe("QC403:banned");
        const staffer = await member(event);
        await owner(
          "INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities, can_play) VALUES ($1, $2, $3, '{review}', false)",
          [ids.orgA, event, staffer.player],
        );
        expect(await refusal(survey(staffer.player, quest, good))).toBe("QP403");
      });

      it("takes one of two parallel responses", async () => {
        const event = await newEvent();
        const quest = await newQuest(event, "survey", SURVEY);
        const { player, enrollment } = await member(event);
        const results = await Promise.allSettled([
          survey(player, quest, good),
          survey(player, quest, good),
        ]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(await completions(enrollment)).toHaveLength(1);
        expect(
          await owner("SELECT 1 FROM survey_response WHERE enrollment_id = $1", [enrollment]),
        ).toHaveLength(1);
      });

      it("sums the results for the event's team with names not shown, and no one else", async () => {
        const event = await newEvent();
        const quest = await newQuest(event, "survey", SURVEY);
        const answers = [
          { fav: "ai", stars: 5, note: "Loved it" },
          { fav: "ai", stars: 4 },
          { fav: "web", stars: 2, note: "Too long" },
        ];
        for (const given of answers) {
          await survey((await member(event)).player, quest, given);
        }
        const result = await summary(teamA(), event, quest);
        expect(result.total).toBe(3);
        expect(result.questions[0]).toMatchObject({
          id: "fav",
          answered: 3,
          choices: [
            { id: "ai", count: 2 },
            { id: "web", count: 1 },
          ],
          average: null,
          texts: null,
        });
        expect(result.questions[1]).toMatchObject({ id: "stars", average: 3.67, choices: null });
        expect(result.questions[2]).toMatchObject({
          id: "note",
          answered: 2,
          texts: ["Too long", "Loved it"],
        });
        expect(JSON.stringify(result)).not.toMatch(/css_player|enrollment|player/);
        expect(await refusal(summary(teamB(), event, quest))).toBe("AN404");
        const operator = await operatorOf(event);
        expect(await refusal(summary(as(operator), event, quest))).toBe("AN404");
        expect(await refusal(summary(teamA(), event, await newQuest(event, "share", SHARE)))).toBe(
          "AN404",
        );
      });

      it("keeps the newest 50 text answers", async () => {
        const event = await newEvent();
        const quest = await newQuest(event, "survey", {
          questions: [{ id: "n", text: text("Note"), kind: "text", required: true }],
        });
        for (let i = 1; i <= 52; i += 1) {
          const { enrollment } = await member(event);
          const [completion] = await owner<{ id: string }>(
            `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method, idempotency_key)
           VALUES ($1, $2, $3, $4, 1, 'survey', $5) RETURNING id`,
            [ids.orgA, event, enrollment, quest, randomUUID()],
          );
          await owner(
            `INSERT INTO survey_response (organizer_id, event_id, enrollment_id, quest_id, answers, completion_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, now() - make_interval(secs => $7))`,
            [
              ids.orgA,
              event,
              enrollment,
              quest,
              JSON.stringify({ n: `t${i}` }),
              completion?.id,
              100 - i,
            ],
          );
        }
        const texts = (await summary(teamA(), event, quest)).questions[0]?.texts ?? [];
        expect(texts).toHaveLength(50);
        expect(texts[0]).toBe("t52");
        expect(texts.at(-1)).toBe("t3");
      });

      it("locks the structure after the first response and leaves the text editable", async () => {
        const event = await newEvent();
        const quest = await newQuest(event, "survey", SURVEY);
        const reordered = {
          questions: [SURVEY.questions[1], SURVEY.questions[0], SURVEY.questions[2]],
        };
        await owner("UPDATE quest SET type_config = $2 WHERE id = $1", [
          quest,
          JSON.stringify(reordered),
        ]);
        await owner("UPDATE quest SET type_config = $2 WHERE id = $1", [
          quest,
          JSON.stringify(SURVEY),
        ]);
        await survey((await member(event)).player, quest, good);
        const optional = {
          questions: SURVEY.questions.map((q) => ({ ...q, required: false })),
        };
        const moreChoices = {
          questions: SURVEY.questions.map((q) =>
            q.choices === undefined
              ? q
              : { ...q, choices: [...q.choices, { id: "x", text: text("X") }] },
          ),
        };
        for (const changed of [reordered, optional, moreChoices]) {
          await expect(
            owner("UPDATE quest SET type_config = $2 WHERE id = $1", [
              quest,
              JSON.stringify(changed),
            ]),
          ).rejects.toMatchObject({ code: "QL409" });
        }
        const reworded = {
          questions: SURVEY.questions.map((q) => ({ ...q, text: text("Better wording") })),
        };
        await owner("UPDATE quest SET type_config = $2, points = 40 WHERE id = $1", [
          quest,
          JSON.stringify(reworded),
        ]);
      });

      it("holds one response per player and the shape in the database", async () => {
        const event = await newEvent();
        const quest = await newQuest(event, "survey", SURVEY);
        await expect(
          owner("UPDATE quest SET repeat_cap = 2 WHERE id = $1", [quest]),
        ).rejects.toMatchObject({ code: "23514" });
        await expect(newQuest(event, "survey", { questions: [] })).rejects.toMatchObject({
          code: "23514",
        });
        await expect(newQuest(event, "share", {})).rejects.toMatchObject({ code: "23514" });
      });
    });

    describe("share quests", () => {
      it("pays once, replays its key, and reads the organizer's message", async () => {
        const event = await newEvent();
        const quest = await newQuest(event, "share", SHARE, 5);
        const { player, enrollment } = await member(event);
        expect(await query(as(player), "SELECT * FROM member_share($1)", [quest])).toEqual([
          {
            event_id: event,
            message_ar: null,
            message_en: SHARE.message.en,
            link: SHARE.link,
            done: false,
          },
        ]);
        const key = randomUUID();
        const first = await share(player, quest, key);
        expect(first).toMatchObject({ points: "5", replayed: false });
        expect(await share(player, quest, key)).toEqual({ ...first, replayed: true });
        expect(await refusal(share(player, quest))).toBe("QD409:1");
        expect(await completions(enrollment)).toEqual([{ method: "share" }]);
        expect(await query(as(player), "SELECT done FROM member_share($1)", [quest])).toEqual([
          { done: true },
        ]);
        expect(await refusal(share(player, await newQuest(event, "survey", SURVEY)))).toBe(
          "QT422:share",
        );
      });

      it("is refused and hidden while the event's switch is off", async () => {
        const event = await newEvent();
        const quest = await newQuest(event, "share", SHARE);
        const { player } = await member(event);
        await owner(
          `UPDATE event SET config = jsonb_set(coalesce(config, '{}'), '{features}', '{"shareQuests": false}')
         WHERE id = $1`,
          [event],
        );
        expect(await refusal(share(player, quest))).toBe("QF403");
        expect(await query(as(player), "SELECT * FROM member_share($1)", [quest])).toEqual([]);
        await owner(
          `UPDATE event SET config = jsonb_set(config, '{features}', '{"shareQuests": true}') WHERE id = $1`,
          [event],
        );
        expect(await share(player, quest)).toMatchObject({ replayed: false });
      });
    });

    describe("erasure and rehearsal", () => {
      it("deletes a deleted account's survey responses and keeps the completion", async () => {
        const event = await newEvent();
        const quest = await newQuest(event, "survey", SURVEY);
        const { player, enrollment } = await member(event);
        await survey(player, quest, good);
        await owner("SELECT erase_rows($1, $2, NULL)", [player, [enrollment]]);
        expect(
          await owner("SELECT 1 FROM survey_response WHERE enrollment_id = $1", [enrollment]),
        ).toEqual([]);
        expect(await completions(enrollment)).toEqual([{ method: "survey" }]);
      });

      it("erases a rehearsal account's responses with the rehearsal, and counts them", async () => {
        const event = await newEvent("draft");
        await owner(
          "INSERT INTO event_rehearsal (event_id, organizer_id, code) VALUES ($1, $2, 'CSSH-REHR')",
          [event, ids.orgA],
        );
        const quest = await newQuest(event, "survey", SURVEY);
        const shareQuest = await newQuest(event, "share", SHARE);
        const { player, enrollment } = await member(event, "rehearsal");
        await survey(player, quest, good);
        await share(player, shareQuest);
        const [wiped] = await owner<{ counts: Row }>(
          "SELECT wipe_rehearsal($1, 'go_live', $2) AS counts",
          [event, randomUUID()],
        );
        expect(wiped?.counts).toMatchObject({ surveys: 1, completions: 2 });
        expect(
          await owner("SELECT 1 FROM survey_response WHERE enrollment_id = $1", [enrollment]),
        ).toEqual([]);
      });
    });

    describe("closed doors", () => {
      it("keeps the table and the internal helpers away from the API role", async () => {
        for (const sql of [
          "SELECT * FROM survey_response",
          "SELECT play_quest(gen_random_uuid(), 'survey')",
          "SELECT survey_answer('{}', '1')",
          "SELECT survey_answers('{}', '{}')",
          "SELECT share_quests_on(gen_random_uuid())",
        ]) {
          await expect(db.app.query(sql), sql).rejects.toThrow(/permission denied/);
        }
      });
    });
  },
);
