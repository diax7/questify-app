import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, TEST_DATABASE_URL } from "#test/support/test-db";
import { questifyFixture, type QuestifyFixture } from "#test/support/questify";

type Feed = { id: string; at: Date; quest_id: string; method: string; username: string };
type Counts = { players: number; online: number; low_stock: number; inbox: number; flags: number };

/** A call's SQLSTATE, or "none". */
const refusal = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "none",
    (error: { code?: string }) => `${error.code}`,
  );

/**
 * The live control room's reads in the database (T-603, migration 0096): the newest completions with only a username
 * and avatar, the counters by the Inbox, stock-low and flag rules, and each quest's completions; for the event's own
 * team only.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("control room (database)", () => {
  let f: QuestifyFixture;
  let event: string;
  beforeAll(async () => {
    f = await questifyFixture();
    event = await f.newEvent({ phase: "live" });
  });
  afterAll(async () => {
    await f.close();
  });

  const quest = async (ev = event, title = "Station"): Promise<string> =>
    (
      await f.owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, visible)
         SELECT $1, id, 'scan_qr', $2, 10, 3, true FROM category WHERE event_id = $1 LIMIT 1 RETURNING id`,
        [ev, title],
      )
    )[0]?.id ?? "";
  const member = async (ev = event) => {
    const player = await f.newPlayer();
    return { player, enrollment: await f.join(ev, player) };
  };
  const complete = async (
    ev: string,
    enrollment: string,
    questId: string,
    occurrence = 1,
    method = "qr",
  ) => {
    const [org] = await f.owner<{ organizer_id: string }>(
      "SELECT organizer_id FROM event WHERE id = $1",
      [ev],
    );
    await f.owner(
      `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [org?.organizer_id, ev, enrollment, questId, occurrence, method, randomUUID()],
    );
  };
  const feed = (ev = event, page = 30, seat = f.team()) =>
    f.run<Feed>(seat, "SELECT * FROM control_feed($1, $2)", [ev, page]);
  const counts = async (ev = event, seat = f.team()) =>
    (await f.run<Counts>(seat, "SELECT * FROM control_counts($1)", [ev]))[0] as Counts;

  describe("the feed", () => {
    it("lists the newest completions first with the username, and no contact detail", async () => {
      const ev = await f.newEvent({ phase: "live" });
      const stage = await quest(ev, "Find the stage");
      const first = await member(ev);
      const second = await member(ev);
      await complete(ev, first.enrollment, stage);
      await complete(ev, second.enrollment, stage, 1, "code");
      const rows = await feed(ev);
      expect(rows.map((row) => row.method)).toEqual(["code", "qr"]);
      expect(rows.map((row) => row.username)).toEqual([
        await f.usernameOf(second.player),
        await f.usernameOf(first.player),
      ]);
      expect(Object.keys(rows[0] ?? {}).toSorted()).toEqual([
        "at",
        "avatar",
        "id",
        "method",
        "quest_id",
        "title_ar",
        "title_en",
        "username",
      ]);
      expect(JSON.stringify(rows)).not.toMatch(/@mail|device|phone/);
    });

    it("stops at the page size, and never goes under one or over a hundred", async () => {
      const ev = await f.newEvent({ phase: "live" });
      const stage = await quest(ev);
      const { enrollment } = await member(ev);
      for (let occurrence = 1; occurrence <= 3; occurrence += 1) {
        await complete(ev, enrollment, stage, occurrence);
      }
      expect(await feed(ev, 2)).toHaveLength(2);
      expect(await feed(ev, 0)).toHaveLength(1);
      expect(await feed(ev, -5)).toHaveLength(1);
      expect(await feed(ev, 1000)).toHaveLength(3);
      expect(await feed(ev, 30, f.team())).toHaveLength(3);
    });

    it("leaves out an erased player, whose completions stay in the record", async () => {
      const ev = await f.newEvent({ phase: "live" });
      const stage = await quest(ev, "Find the stage");
      const kept = await member(ev);
      const erased = await member(ev);
      await complete(ev, kept.enrollment, stage);
      await complete(ev, erased.enrollment, stage);
      expect(await feed(ev)).toHaveLength(2);
      await f.asPlayer(erased.player, "SELECT * FROM erase_player($1, true, $2)", [
        await f.deletionToken(erased.player),
        randomUUID(),
      ]);
      const [left] = await f.owner<{ n: number }>(
        "SELECT count(*)::integer AS n FROM quest_completion WHERE enrollment_id = $1",
        [erased.enrollment],
      );
      expect(left?.n).toBe(1);
      const rows = await feed(ev);
      expect(rows.map((row) => row.username)).toEqual([await f.usernameOf(kept.player)]);
    });

    it("shows nothing of another event, and is an empty list for a quiet one", async () => {
      const quiet = await f.newEvent({ phase: "live" });
      expect(await feed(quiet)).toEqual([]);
    });
  });

  describe("the counters", () => {
    it("counts active members, and active members with a completion in the last 15 minutes", async () => {
      const ev = await f.newEvent({ phase: "live" });
      const stage = await quest(ev);
      const busy = await member(ev);
      const idle = await member(ev);
      const gone = await member(ev);
      await complete(ev, busy.enrollment, stage);
      await complete(ev, idle.enrollment, stage);
      await complete(ev, gone.enrollment, stage);
      await f.owner("UPDATE enrollment SET status = 'removed' WHERE id = $1", [gone.enrollment]);
      const ago = (enrollment: string, interval: string) =>
        f.owner(
          "UPDATE quest_completion SET created_at = now() - $2::interval WHERE enrollment_id = $1",
          [enrollment, interval],
        );
      await ago(idle.enrollment, "16 minutes");
      expect(await counts(ev)).toMatchObject({ players: 2, online: 1 });
      await ago(busy.enrollment, "14 minutes");
      expect((await counts(ev)).online).toBe(1);
      await ago(busy.enrollment, "15 minutes 5 seconds");
      expect((await counts(ev)).online).toBe(0);
    });

    it("counts rewards at or under the stock-low line, only the active ones", async () => {
      const ev = await f.newEvent({ phase: "live" });
      const reward = (stock: number, out: number, status = "active") =>
        f.owner(
          `INSERT INTO reward (event_id, kind, name_en, price, stock_total, units_out, status)
           VALUES ($1, 'item', 'Cap', 5, $2, $3, $4)`,
          [ev, stock, out, status],
        );
      await reward(100, 89);
      await reward(100, 90);
      await reward(100, 91);
      await reward(3, 2);
      await reward(3, 1);
      await reward(100, 99, "removed");
      expect((await counts(ev)).low_stock).toBe(3);
    });

    it("adds the event's open help requests to the submissions waiting, and counts open flags", async () => {
      const ev = await f.newEvent({ phase: "live" });
      expect(await counts(ev)).toEqual({ players: 0, online: 0, low_stock: 0, inbox: 0, flags: 0 });
      const stage = await quest(ev);
      const first = await member(ev);
      const second = await member(ev);
      const [org] = await f.owner<{ organizer_id: string }>(
        "SELECT organizer_id FROM event WHERE id = $1",
        [ev],
      );
      await f.owner(
        `INSERT INTO ticket (player_id, organizer_id, event_id, enrollment_id, kind, body, idempotency_key)
         VALUES ($1, $2, $3, $4, 'question', 'Where is the stage?', $5)`,
        [first.player, org?.organizer_id, ev, first.enrollment, randomUUID()],
      );
      await f.owner(
        `INSERT INTO submission (organizer_id, event_id, enrollment_id, quest_id, kind, body, points, status, idempotency_key)
         VALUES ($1, $2, $3, $4, 'text', 'My answer', 10, 'pending', $5)`,
        [org?.organizer_id, ev, first.enrollment, stage, randomUUID()],
      );
      await f.owner(
        `INSERT INTO submission (organizer_id, event_id, enrollment_id, quest_id, kind, body, points, status, reason,
                                 reviewed_by_staff, idempotency_key)
         VALUES ($1, $2, $3, $4, 'text', 'No', 10, 'rejected', 'Off topic', $5, $6)`,
        [org?.organizer_id, ev, first.enrollment, stage, f.ownerA, randomUUID()],
      );
      await f.owner(
        `INSERT INTO flag (organizer_id, event_id, enrollment_id, kind, status)
         VALUES ($1, $2, $3, 'burst', 'open')`,
        [org?.organizer_id, ev, first.enrollment],
      );
      await f.owner(
        `INSERT INTO flag (organizer_id, event_id, enrollment_id, kind, status, resolution, resolved_at)
         VALUES ($1, $2, $3, 'burst', 'cleared', 'cleared', now())`,
        [org?.organizer_id, ev, second.enrollment],
      );
      const seen = await counts(ev);
      expect([seen.inbox, seen.flags]).toEqual([2, 1]);
    });
  });

  describe("each quest's completions", () => {
    it("counts a player once however often they completed it, and leaves out a quest nobody did", async () => {
      const ev = await f.newEvent({ phase: "live" });
      const done = await quest(ev, "Done");
      const never = await quest(ev, "Never");
      const first = await member(ev);
      const second = await member(ev);
      await complete(ev, first.enrollment, done, 1);
      await complete(ev, first.enrollment, done, 2);
      await complete(ev, second.enrollment, done, 1);
      const rows = await f.run<{ quest_id: string; done: number }>(
        f.team(),
        "SELECT * FROM control_done($1)",
        [ev],
      );
      expect(rows).toEqual([{ quest_id: done, done: 2 }]);
      expect(rows.some((row) => row.quest_id === never)).toBe(false);
    });
  });

  describe("the indexes", () => {
    it("answers the feed and the per-quest completions from an index, not a walk of the table", async () => {
      const ev = await f.newEvent({ phase: "live" });
      const reads = [
        `SELECT c.id FROM quest_completion c WHERE c.event_id = $1 ORDER BY c.created_at DESC, c.id DESC LIMIT 30`,
        `SELECT c.quest_id, count(*) FROM quest_completion c WHERE c.event_id = $1 AND c.occurrence = 1
         GROUP BY c.quest_id`,
      ];
      const wanted = ["quest_completion_event_recent_idx", "quest_completion_event_first_idx"];
      await f.owner("BEGIN");
      try {
        await f.owner("SET LOCAL enable_seqscan = off");
        for (const [at, sql] of reads.entries()) {
          const plan = await f.owner<Record<string, unknown>>(`EXPLAIN ${sql}`, [ev]);
          expect(plan.map((line) => String(line["QUERY PLAN"])).join(" "), sql).toContain(
            wanted[at],
          );
        }
      } finally {
        await f.owner("ROLLBACK");
      }
    });
  });

  describe("who may read", () => {
    it("is the event's own team only: another organizer, a player, a stranger and an unknown event are refused", async () => {
      const ev = await f.newEvent({ phase: "live" });
      const stranger = await addMember(f.db.owner, f.ids.orgB, "owner");
      const player = await f.newPlayer();
      const reads = [
        "SELECT * FROM control_feed($1, 30)",
        "SELECT * FROM control_counts($1)",
        "SELECT * FROM control_done($1)",
      ];
      for (const sql of reads) {
        expect(await refusal(f.run(f.team(stranger, f.ids.orgB), sql, [ev])), sql).toBe("AN404");
        expect(await refusal(f.run(f.team(f.ownerA, f.ids.orgB), sql, [ev])), sql).toBe("AN404");
        expect(await refusal(f.run({ playerId: player }, sql, [ev])), sql).toBe("AN404");
        expect(await refusal(f.run({}, sql, [ev])), sql).toBe("AN404");
        expect(await refusal(f.run(f.team(), sql, [randomUUID()])), sql).toBe("AN404");
        expect(await refusal(f.run(f.team(), sql, [ev])), sql).toBe("none");
      }
    });

    it("keeps an editor to the events in their limit", async () => {
      const inside = await f.newEvent({ phase: "live" });
      const outside = await f.newEvent({ phase: "live" });
      const editor = await addMember(f.db.owner, f.ids.orgA, "editor", [inside]);
      const seat = f.team(editor);
      expect(await refusal(f.run(seat, "SELECT * FROM control_feed($1, 30)", [inside]))).toBe(
        "none",
      );
      expect(await refusal(f.run(seat, "SELECT * FROM control_counts($1)", [outside]))).toBe(
        "AN404",
      );
      expect(await refusal(f.run(seat, "SELECT * FROM control_done($1)", [outside]))).toBe("AN404");
    });
  });
});
