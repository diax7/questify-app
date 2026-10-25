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
type Live = {
  polls: { questId: string; closesAt: string }[];
  closed: { questId: string }[];
  community: null;
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
const OPTIONS = [
  { id: "a", text: text("Robots") },
  { id: "b", text: text("Space") },
  { id: "c", text: text("Oceans") },
];
const PLAIN = { options: OPTIONS };
const poll = (
  choices: "one" | "several" = "one",
  results: "after_vote" | "at_close" | "never" = "after_vote",
  minutes = 5,
) => ({ options: OPTIONS, live: { choices, results, minutes } });

/**
 * Live polls in the database (T-306, migration 0052, ADR-220): Send and Close, the guard on the window, one or several
 * choices paid once, the results policy, the live state, live polls left out of the category rules, the rehearsal
 * wipe and erasure, and the closed doors.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("live polls (database)", () => {
  let db: TestDatabase;
  let pool: Pool;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let ownerA = "";
  let ownerB = "";
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new Pool({ connectionString: db.appUrl, max: 8 });
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

  const newEvent = async (status = "live", endsIn = "1 day"): Promise<string> => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Poll Fest', $3, now() - interval '1 hour', now() + $4::interval) RETURNING id`,
      [ids.orgA, `LPL${counter}`, status, endsIn],
    );
    return event?.id ?? "";
  };
  const newCategory = async (event: string, rules: Row = {}): Promise<string> => {
    const [category] = await owner<{ id: string }>(
      "INSERT INTO category (event_id, name_en) VALUES ($1, 'Polls') RETURNING id",
      [event],
    );
    for (const [column, value] of Object.entries(rules)) {
      await owner(`UPDATE category SET ${column} = $2 WHERE id = $1`, [category?.id, value]);
    }
    return category?.id ?? "";
  };
  /** A vote quest in `category`: a draft live poll (hidden, no window) when the config has `live`. */
  const newVote = async (event: string, category: string, config: object, points = 10) => {
    const live = "live" in config;
    const [quest] = await owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config, visible)
       VALUES ($1, $2, 'vote', 'Pick', $3, $4, $5) RETURNING id`,
      [event, category, points, JSON.stringify(config), !live],
    );
    return quest?.id ?? "";
  };
  const member = async (event: string, via = "code") => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`lp_player_${counter}`],
    );
    const [made] = await owner<{ id: string }>(
      "INSERT INTO enrollment (organizer_id, event_id, player_id, joined_via) VALUES ($1, $2, $3, $4) RETURNING id",
      [ids.orgA, event, player?.id, via],
    );
    return { player: player?.id ?? "", enrollment: made?.id ?? "" };
  };
  const vote = async (player: string, quest: string, options: string[], key = randomUUID()) =>
    (
      await query<{ points: string; score: string; replayed: boolean; completion_id: string }>(
        as(player),
        "SELECT * FROM vote_quest($1, $2, $3)",
        [quest, options, key],
      )
    )[0];
  const send = async (event: string, quest: string, team = teamA()) =>
    (
      await query<{ opens_at: Date; closes_at: Date; replayed: boolean }>(
        team,
        "SELECT * FROM send_poll($1, $2, $3)",
        [event, quest, randomUUID()],
      )
    )[0];
  const close = async (event: string, quest: string) =>
    (
      await query<{ closes_at: Date; replayed: boolean }>(
        teamA(),
        "SELECT * FROM close_poll($1, $2, $3)",
        [event, quest, randomUUID()],
      )
    )[0];
  const live = async (player: string, event: string) =>
    (await query<{ s: Live }>(as(player), "SELECT live_state($1) AS s", [event]))[0]?.s as Live;
  const results = async (player: string, quest: string) =>
    query<{ option_id: string; votes: string; voters: string }>(
      as(player),
      "SELECT * FROM poll_results($1)",
      [quest],
    );
  const listed = async (player: string, event: string) =>
    (
      await query<{ quest_id: string; lock: string | null }>(
        as(player),
        "SELECT quest_id, lock FROM member_event_quests($1)",
        [event],
      )
    ).map((row) => row.quest_id);
  /** Moves a sent poll's close into the past, as if its minutes ran out. */
  const expire = async (quest: string, ago = "1 minute") =>
    owner(
      "UPDATE quest SET opens_at = now() - interval '1 day', closes_at = now() - $2::interval WHERE id = $1",
      [quest, ago],
    );

  const voters = async (event: string, quest: string) => {
    for (const options of [["a", "b"], ["a"], ["b", "c"]]) {
      await vote((await member(event)).player, quest, options);
    }
  };

  const bonusOf = async (enrollment: string) =>
    owner<{ score_delta: string }>(
      "SELECT score_delta FROM ledger_entry WHERE enrollment_id = $1 AND kind = 'bonus'",
      [enrollment],
    );

  describe("Send and Close", () => {
    it("sends a draft poll for its minutes, answers a second send, and refuses a send once closed", async () => {
      const event = await newEvent();
      const quest = await newVote(event, await newCategory(event), poll("one", "after_vote", 7));
      const sent = await send(event, quest);
      expect(sent?.replayed).toBe(false);
      const minutes = ((sent?.closes_at.getTime() ?? 0) - (sent?.opens_at.getTime() ?? 0)) / 60_000;
      expect(minutes).toBe(7);
      expect(await send(event, quest)).toEqual({ ...sent, replayed: true });
      const [row] = await owner<{ visible: boolean; poll_sent_at: Date | null }>(
        "SELECT visible, poll_sent_at FROM quest WHERE id = $1",
        [quest],
      );
      expect(row?.visible).toBe(true);
      expect(row?.poll_sent_at).not.toBeNull();
      const closed = await close(event, quest);
      expect(closed?.replayed).toBe(false);
      expect((await close(event, quest))?.replayed).toBe(true);
      expect(await refusal(send(event, quest))).toBe("PS409:already_sent");
      expect(
        await owner("SELECT action FROM audit_log WHERE target_id = $1 ORDER BY id", [quest]),
      ).toEqual([{ action: "quest.poll_send" }, { action: "quest.poll_close" }]);
    });

    it("caps the close at the event's end", async () => {
      const event = await newEvent("live", "2 minutes");
      const quest = await newVote(event, await newCategory(event), poll("one", "after_vote", 60));
      const sent = await send(event, quest);
      const [ev] = await owner<{ ends_at: Date }>("SELECT ends_at FROM event WHERE id = $1", [
        event,
      ]);
      expect(sent?.closes_at.getTime()).toBeLessThanOrEqual(ev?.ends_at.getTime() ?? 0);
      expect((ev?.ends_at.getTime() ?? 0) - (sent?.closes_at.getTime() ?? 0)).toBeLessThan(1000);
    });

    it("refuses a close before the send, a plain vote, an ended event and another organizer", async () => {
      const event = await newEvent();
      const category = await newCategory(event);
      const quest = await newVote(event, category, poll());
      expect(await refusal(close(event, quest))).toBe("PS409:not_sent");
      expect(await refusal(send(event, await newVote(event, category, PLAIN)))).toBe("PN422");
      expect(await refusal(send(event, quest, teamB()))).toBe("AN404");
      expect(await refusal(send(event, randomUUID()))).toBe("AN404");
      const ended = await newEvent("ended");
      expect(
        await refusal(send(ended, await newVote(ended, await newCategory(ended), poll()))),
      ).toBe("PE409:event_not_live");
      const draft = await newEvent("draft");
      expect(
        await refusal(send(draft, await newVote(draft, await newCategory(draft), poll()))),
      ).toBe("PE409:event_not_live");
    });

    it("sends during a rehearsal, and the go-live wipe puts the poll back to draft", async () => {
      const event = await newEvent("draft");
      await owner(
        "INSERT INTO event_rehearsal (event_id, organizer_id, code) VALUES ($1, $2, 'LPLV-REHR')",
        [event, ids.orgA],
      );
      const quest = await newVote(event, await newCategory(event), poll("several"));
      await send(event, quest);
      const { player } = await member(event, "rehearsal");
      await vote(player, quest, ["a", "b"]);
      const [wiped] = await owner<{ counts: Row }>(
        "SELECT wipe_rehearsal($1, 'go_live', $2) AS counts",
        [event, randomUUID()],
      );
      expect(wiped?.counts).toMatchObject({ votes: 1, completions: 1 });
      expect(
        await owner("SELECT visible, opens_at, closes_at, poll_sent_at FROM quest WHERE id = $1", [
          quest,
        ]),
      ).toEqual([{ visible: false, opens_at: null, closes_at: null, poll_sent_at: null }]);
    });
  });

  describe("go-live with a rehearsal poll still open (CTO code review 1)", () => {
    it("never shows it to a real player or pays them, and the wipe resets it to draft", async () => {
      const event = await newEvent("draft");
      await owner(
        "INSERT INTO event_rehearsal (event_id, organizer_id, code) VALUES ($1, $2, 'GPGK-WXYZ')",
        [event, ids.orgA],
      );
      const quest = await newVote(event, await newCategory(event), poll("one", "at_close", 60));
      await send(event, quest);
      await owner("UPDATE event SET status = 'live' WHERE id = $1", [event]);
      const { player, enrollment } = await member(event);
      expect(await live(player, event)).toEqual({
        polls: [],
        closed: [],
        community: null,
        flash: [],
        boosts: [],
        firstBonus: [],
      });
      expect(await query(as(player), "SELECT * FROM member_poll($1)", [quest])).toEqual([]);
      expect(await refusal(vote(player, quest, ["a"]))).toBe("QN403:hidden");
      expect(
        await owner("SELECT count(*)::int AS n FROM quest_completion WHERE enrollment_id = $1", [
          enrollment,
        ]),
      ).toEqual([{ n: 0 }]);
      // The refused vote rolled its wipe back; the tick's wipe leaves the poll a draft to send for real.
      await owner("SELECT ensure_rehearsal_wiped($1)", [event]);
      expect(await owner("SELECT visible, poll_sent_at FROM quest WHERE id = $1", [quest])).toEqual(
        [{ visible: false, poll_sent_at: null }],
      );
    });
  });

  describe("the guard on the API's seat", () => {
    it("refuses a live poll made visible, a window, `live` added to a visible vote, and a sent poll's window", async () => {
      const event = await newEvent();
      const category = await newCategory(event);
      const insert = (visible: string) =>
        query(
          teamA(),
          `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config${visible === "" ? "" : ", visible"})
           VALUES ($1, $2, 'vote', 'Pick', 5, $3${visible === "" ? "" : `, ${visible}`}) RETURNING id`,
          [event, category, JSON.stringify(poll())],
        );
      expect(await refusal(insert(""))).toBe("PL409:window");
      const [draft] = (await insert("false")) as { id: string }[];
      expect(
        await refusal(
          query(teamA(), "UPDATE quest SET closes_at = now() + interval '1 hour' WHERE id = $1", [
            draft?.id,
          ]),
        ),
      ).toBe("PL409:window");
      const plain = await newVote(event, category, PLAIN);
      expect(
        await refusal(
          query(teamA(), "UPDATE quest SET type_config = $2 WHERE id = $1", [
            plain,
            JSON.stringify(poll()),
          ]),
        ),
      ).toBe("PL409:live");
      await send(event, draft?.id ?? "");
      expect(
        await refusal(
          query(teamA(), "UPDATE quest SET visible = false WHERE id = $1", [draft?.id]),
        ),
      ).toBe("PL409:window");
      const [read] = await query<{ opens_at: Date; closes_at: Date }>(
        teamA(),
        "SELECT opens_at, closes_at FROM quest WHERE id = $1",
        [draft?.id],
      );
      // The builder writes the window back as it read it: milliseconds round-trip exactly.
      await query(
        teamA(),
        "UPDATE quest SET title_en = 'Renamed', opens_at = $2, closes_at = $3, visible = true WHERE id = $1",
        [draft?.id, read?.opens_at, read?.closes_at],
      );
    });

    it("keeps `live`, its choices and minutes once sent, and `live` once voted, for every seat", async () => {
      const event = await newEvent();
      const category = await newCategory(event);
      const quest = await newVote(event, category, poll("one", "after_vote", 5));
      await send(event, quest);
      const change = (config: object) =>
        owner("UPDATE quest SET type_config = $2 WHERE id = $1", [quest, JSON.stringify(config)]);
      expect(await refusal(change(PLAIN))).toBe("PL409:live");
      expect(await refusal(change(poll("several")))).toBe("PL409:choices");
      expect(await refusal(change(poll("one", "after_vote", 9)))).toBe("PL409:minutes");
      expect(await refusal(change({ ...poll(), options: OPTIONS.slice(0, 2) }))).toBe("QL409");
      await change(poll("one", "at_close", 5));
      await change({
        ...poll("one", "at_close", 5),
        options: [{ id: "a", text: text("Robotics") }, ...OPTIONS.slice(1)],
      });
      const plain = await newVote(event, category, PLAIN);
      await vote((await member(event)).player, plain, ["a"]);
      await owner("UPDATE quest SET visible = false WHERE id = $1", [plain]);
      expect(
        await refusal(
          owner("UPDATE quest SET type_config = $2 WHERE id = $1", [plain, JSON.stringify(poll())]),
        ),
      ).toBe("PL409:live");
    });

    it("holds the live block's shape in the database", async () => {
      const event = await newEvent();
      const category = await newCategory(event);
      for (const block of [
        { choices: "many", results: "never", minutes: 5 },
        { choices: "one", results: "later", minutes: 5 },
        { choices: "one", results: "never", minutes: 0 },
        { choices: "one", results: "never", minutes: 1441 },
        { choices: "one", results: "never", minutes: 2.5 },
        { choices: "one", results: "never" },
        { results: "never", minutes: 5 },
      ]) {
        await expect(
          newVote(event, category, { options: OPTIONS, live: block }),
          JSON.stringify(block),
        ).rejects.toMatchObject({ code: "23514" });
      }
      await expect(
        owner("UPDATE quest SET poll_sent_at = now() WHERE id = $1", [
          await newVote(event, category, PLAIN),
        ]),
      ).rejects.toMatchObject({ code: "23514" });
    });
  });

  describe("voting", () => {
    it("hides a draft poll and refuses a vote on it, and refuses one after it closed", async () => {
      const event = await newEvent();
      const quest = await newVote(event, await newCategory(event), poll());
      const { player } = await member(event);
      expect(await listed(player, event)).toEqual([]);
      expect(await refusal(vote(player, quest, ["a"]))).toBe("QN403:hidden");
      await send(event, quest);
      expect(await listed(player, event)).toEqual([quest]);
      await close(event, quest);
      expect(await refusal(vote(player, quest, ["a"]))).toBe("QN403:ended");
    });

    it("takes one choice on a one-choice poll and on a plain vote", async () => {
      const event = await newEvent();
      const category = await newCategory(event);
      const quest = await newVote(event, category, poll("one"));
      await send(event, quest);
      const { player } = await member(event);
      expect(await refusal(vote(player, quest, ["a", "b"]))).toBe("VC422:too_many_choices");
      expect(await refusal(vote(player, await newVote(event, category, PLAIN), ["a", "b"]))).toBe(
        "VC422:too_many_choices",
      );
      expect(await vote(player, quest, ["b"])).toMatchObject({ points: "10", replayed: false });
    });

    it("takes several choices as one completion and one payment, and replays the same set", async () => {
      const event = await newEvent();
      const quest = await newVote(event, await newCategory(event), poll("several"), 15);
      await send(event, quest);
      const { player, enrollment } = await member(event);
      const key = randomUUID();
      const first = await vote(player, quest, ["c", "a"], key);
      expect(first).toMatchObject({ points: "15", score: "15", replayed: false });
      expect(await vote(player, quest, ["a", "c"], key)).toEqual({ ...first, replayed: true });
      expect(await refusal(vote(player, quest, ["a"], key))).toBe("QK422");
      expect(await refusal(vote(player, quest, ["b"]))).toBe("QD409:1");
      expect(
        await owner("SELECT count(*)::int AS n FROM quest_completion WHERE enrollment_id = $1", [
          enrollment,
        ]),
      ).toEqual([{ n: 1 }]);
      expect(
        await query(as(player), "SELECT option_id, mine FROM member_vote($1)", [quest]),
      ).toEqual([
        { option_id: "a", mine: true },
        { option_id: "b", mine: false },
        { option_id: "c", mine: true },
      ]);
    });

    it("refuses an empty, unknown or repeated option", async () => {
      const event = await newEvent();
      const quest = await newVote(event, await newCategory(event), poll("several"));
      await send(event, quest);
      const { player } = await member(event);
      for (const options of [[], ["a", "zz"], ["a", "a"]]) {
        expect(await refusal(vote(player, quest, options)), JSON.stringify(options)).toBe("VO422");
      }
    });

    it("pays a 0-point poll as a completion with Questify XP", async () => {
      const event = await newEvent();
      const quest = await newVote(event, await newCategory(event), poll(), 0);
      await send(event, quest);
      const { player } = await member(event);
      expect(await vote(player, quest, ["a"])).toMatchObject({ points: "0", score: "0" });
      expect(
        await owner(
          "SELECT count(*)::int AS n FROM xp_entry WHERE player_id = $1 AND quest_id = $2",
          [player, quest],
        ),
      ).toEqual([{ n: 1 }]);
    });

    it("pays once when one player votes on two connections at once, and both of two players", async () => {
      const event = await newEvent();
      const quest = await newVote(event, await newCategory(event), poll("several"));
      await send(event, quest);
      for (let round = 0; round < 10; round += 1) {
        const one = await member(event);
        const two = await member(event);
        const outcomes = await Promise.all([
          refusal(vote(one.player, quest, ["a", "b"])),
          refusal(vote(one.player, quest, ["c"])),
          refusal(vote(two.player, quest, ["a"])),
        ]);
        expect(outcomes.filter((outcome) => outcome === "none")).toHaveLength(2);
        expect(outcomes[2]).toBe("none");
        expect(
          await owner("SELECT count(*)::int AS n FROM quest_completion WHERE enrollment_id = $1", [
            one.enrollment,
          ]),
        ).toEqual([{ n: 1 }]);
      }
    });
  });

  describe("results", () => {
    it("shows results after voting, and counts shares out of voters", async () => {
      const event = await newEvent();
      const quest = await newVote(event, await newCategory(event), poll("several", "after_vote"));
      await send(event, quest);
      await voters(event, quest);
      const { player } = await member(event);
      expect(await refusal(results(player, quest))).toBe("PR403:after_vote");
      await vote(player, quest, ["c"]);
      expect(await results(player, quest)).toEqual([
        { option_id: "a", votes: "2", voters: "4" },
        { option_id: "b", votes: "2", voters: "4" },
        { option_id: "c", votes: "2", voters: "4" },
      ]);
      expect(
        await query(teamA(), "SELECT option_id, votes, voters FROM quest_vote_counts($1, $2)", [
          event,
          quest,
        ]),
      ).toEqual([
        { option_id: "a", votes: "2", voters: "4" },
        { option_id: "b", votes: "2", voters: "4" },
        { option_id: "c", votes: "2", voters: "4" },
      ]);
    });

    it("shows at_close results only once closed, and never results never", async () => {
      const event = await newEvent();
      const category = await newCategory(event);
      const atClose = await newVote(event, category, poll("one", "at_close"));
      const never = await newVote(event, category, poll("one", "never"));
      await send(event, atClose);
      await send(event, never);
      const { player } = await member(event);
      await vote(player, atClose, ["a"]);
      await vote(player, never, ["a"]);
      expect(await refusal(results(player, atClose))).toBe("PR403:at_close");
      expect(await refusal(results(player, never))).toBe("PR403:never");
      await close(event, atClose);
      await close(event, never);
      expect(await results(player, atClose)).toHaveLength(3);
      expect(await refusal(results(player, never))).toBe("PR403:never");
    });

    it("answers not found to a player outside the audience, a stranger and a plain vote", async () => {
      const event = await newEvent();
      const quest = await newVote(
        event,
        await newCategory(event, { audience_kind: "tag", audience_values: ["vip"] }),
        poll("one", "at_close"),
      );
      await send(event, quest);
      await close(event, quest);
      const { player } = await member(event);
      expect(await refusal(results(player, quest))).toBe("QC404");
      expect(await refusal(results(randomUUID(), quest))).toBe("QC404");
      const plain = await newVote(event, await newCategory(event), PLAIN);
      expect(await refusal(results(player, plain))).toBe("QC404");
    });
  });

  describe("the live state", () => {
    it("lists open polls not yet voted, drops voted ones, and lists at_close ones for 15 minutes after", async () => {
      const event = await newEvent();
      const category = await newCategory(event);
      const first = await newVote(event, category, poll("one", "at_close"));
      const second = await newVote(event, category, poll());
      const draft = await newVote(event, category, poll());
      await send(event, first);
      await send(event, second);
      const { player } = await member(event);
      const state = await live(player, event);
      expect(state.polls.map((p) => p.questId)).toEqual([first, second]);
      expect(state.community).toBeNull();
      expect(state.polls.map((p) => p.questId)).not.toContain(draft);
      await vote(player, second, ["a"]);
      expect((await live(player, event)).polls.map((p) => p.questId)).toEqual([first]);
      await expire(first, "10 minutes");
      expect(await live(player, event)).toMatchObject({ polls: [], closed: [{ questId: first }] });
      await expire(first, "16 minutes");
      expect((await live(player, event)).closed).toEqual([]);
    });

    it("hides polls from players outside the audience, in a hidden or locked category, and operators off play", async () => {
      const event = await newEvent();
      const vip = await newVote(
        event,
        await newCategory(event, { audience_kind: "tag", audience_values: ["vip"] }),
        poll(),
      );
      const hidden = await newVote(event, await newCategory(event, { hidden: true }), poll());
      const first = await newCategory(event);
      await newVote(event, first, PLAIN);
      const locked = await newVote(
        event,
        await newCategory(event, { unlock_after: first }),
        poll(),
      );
      const later = await newVote(
        event,
        await newCategory(event, { opens_at: new Date(Date.now() + 3_600_000) }),
        poll(),
      );
      for (const quest of [vip, hidden, locked, later]) {
        await send(event, quest);
      }
      const { player } = await member(event);
      expect((await live(player, event)).polls).toEqual([]);
      expect(await listed(player, event)).not.toContain(vip);
      expect(await refusal(vote(player, locked, ["a"]))).toBe("QN403:category_locked");
      expect(await refusal(vote(player, later, ["a"]))).toBe("QN403:category_not_started");
      const open = await newVote(event, await newCategory(event), poll());
      await send(event, open);
      expect((await live(player, event)).polls.map((p) => p.questId)).toEqual([open]);
      const operator = await member(event);
      await owner(
        "INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities, can_play) VALUES ($1, $2, $3, '{review}', false)",
        [ids.orgA, event, operator.player],
      );
      expect((await live(operator.player, event)).polls).toEqual([]);
    });

    it("answers a stranger and a player of another event with the same empty state", async () => {
      const event = await newEvent();
      const quest = await newVote(event, await newCategory(event), poll());
      await send(event, quest);
      const other = await member(await newEvent());
      const empty = {
        polls: [],
        closed: [],
        community: null,
        flash: [],
        boosts: [],
        firstBonus: [],
      };
      expect(await live(other.player, event)).toEqual(empty);
      expect(await live(randomUUID(), event)).toEqual(empty);
      expect(
        (await query<{ open: boolean }>({}, "SELECT event_has_live($1) AS open", [event]))[0]?.open,
      ).toBe(true);
    });
  });

  describe("live polls stay out of the category rules", () => {
    it("pays the bonus and opens the next category past a closed poll the player missed", async () => {
      const event = await newEvent();
      const first = await newCategory(event, { completion_bonus: 50 });
      const plain = await newVote(event, first, PLAIN);
      const missed = await newVote(event, first, poll());
      await send(event, missed);
      await close(event, missed);
      const next = await newCategory(event, { unlock_after: first });
      const after = await newVote(event, next, PLAIN);
      const { player, enrollment } = await member(event);
      await vote(player, plain, ["a"]);
      expect(await bonusOf(enrollment)).toEqual([{ score_delta: "50" }]);
      expect(await vote(player, after, ["a"])).toMatchObject({ replayed: false });
    });

    it("pays no bonus for a category of only live polls, and opens the category after it at once", async () => {
      const event = await newEvent();
      const polls = await newCategory(event, { completion_bonus: 50 });
      const quest = await newVote(event, polls, poll());
      await send(event, quest);
      const next = await newCategory(event, { unlock_after: polls });
      const after = await newVote(event, next, PLAIN);
      const { player, enrollment } = await member(event);
      expect(await vote(player, after, ["a"])).toMatchObject({ replayed: false });
      await vote(player, quest, ["a"]);
      expect(await bonusOf(enrollment)).toEqual([]);
    });

    it("never blocks an in-order category with a poll, nor a poll behind an unfinished quest", async () => {
      const event = await newEvent();
      const ordered = await newCategory(event, { order_mode: "in_order" });
      const plainFirst = await newVote(event, ordered, PLAIN);
      const middle = await newVote(event, ordered, poll());
      const last = await newVote(event, ordered, PLAIN);
      await owner("UPDATE quest SET position = 1 WHERE id = $1", [plainFirst]);
      await owner("UPDATE quest SET position = 2 WHERE id = $1", [middle]);
      await owner("UPDATE quest SET position = 3 WHERE id = $1", [last]);
      await send(event, middle);
      const { player } = await member(event);
      const locks = await query<{ quest_id: string; lock: string | null }>(
        as(player),
        "SELECT quest_id, lock FROM member_event_quests($1)",
        [event],
      );
      expect(locks.find((row) => row.quest_id === middle)?.lock).toBeNull();
      expect((await live(player, event)).polls.map((p) => p.questId)).toEqual([middle]);
      await vote(player, middle, ["a"]);
      await vote(player, plainFirst, ["a"]);
      expect(await vote(player, last, ["a"])).toMatchObject({ replayed: false });
    });

    it("keeps live polls out of refreshing categories, both ways", async () => {
      const event = await newEvent();
      const polls = await newCategory(event);
      await newVote(event, polls, poll());
      expect(
        await refusal(owner("UPDATE category SET refresh = 'daily' WHERE id = $1", [polls])),
      ).toBe("QT422:refresh");
      const daily = await newCategory(event);
      await owner("UPDATE category SET refresh = 'daily' WHERE id = $1", [daily]);
      expect(await refusal(newVote(event, daily, poll()))).toBe("QT422:refresh");
    });
  });

  describe("erasure and closed doors", () => {
    it("deletes a deleted account's several-choice vote", async () => {
      const event = await newEvent();
      const quest = await newVote(event, await newCategory(event), poll("several"));
      await send(event, quest);
      const { player, enrollment } = await member(event);
      await vote(player, quest, ["a", "b"]);
      await owner("SELECT erase_rows($1, $2, NULL)", [player, [enrollment]]);
      expect(
        await owner("SELECT 1 FROM quest_vote WHERE enrollment_id = $1", [enrollment]),
      ).toEqual([]);
    });

    it("keeps the internal helpers away from the API role", async () => {
      for (const sql of [
        "SELECT is_live_poll('vote', '{}')",
        "SELECT polls_shown(NULL::event)",
        "SELECT team_poll(gen_random_uuid(), gen_random_uuid())",
        "SELECT quest_live_poll_guard()",
      ]) {
        await expect(db.app.query(sql), sql).rejects.toThrow(/permission denied/);
      }
    });
  });
});
