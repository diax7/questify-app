import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { questifyFixture, type QuestifyFixture } from "#test/support/questify";
import { TEST_DATABASE_URL } from "#test/support/test-db";

type Door<T> = { door: T };
type Text = { ar: string | null; en: string | null };
type Sponsor = {
  sponsor: { id: string; name: Text };
  visits: number;
  completions: number;
  redemptions: number;
  quests: { id: string; title: Text; players: number }[];
  categories: { id: string; name: Text; players: number }[];
  rewards: { id: string; name: Text; redeemed: number }[];
};
type CompletionPage = {
  rows: { username: string; quest: Text; removed: boolean; occurrence: number }[];
  next: { at: string; id: number } | null;
};

const refusal = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "none",
    (error: { code?: string }) => `${error.code}`,
  );

/**
 * The export doors in the database (T-608, migration 0103): the rows of FR-1206 for the event's own team, the audit
 * entry of every export, only the fields the join card disclosed (FR-1207), and a sponsor's exact totals (FR-1306).
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("exports (database)", () => {
  let f: QuestifyFixture;
  beforeAll(async () => {
    f = await questifyFixture();
  });
  afterAll(async () => {
    await f.close();
  });

  const read = async <T>(sql: string, values: unknown[], seat = f.team()): Promise<T> =>
    (await f.run<Door<T>>(seat, `SELECT ${sql} AS door`, values))[0]?.door as T;

  const quest = async (event: string, title: string, category?: string): Promise<string> =>
    (
      await f.owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, visible)
         SELECT $1, coalesce($2::uuid, (SELECT id FROM category WHERE event_id = $1 ORDER BY position LIMIT 1)),
                'scan_qr', $3, 10, 5, true RETURNING id`,
        [event, category ?? null, title],
      )
    )[0]?.id ?? "";
  const category = async (event: string, name: string): Promise<string> =>
    (
      await f.owner<{ id: string }>(
        "INSERT INTO category (event_id, name_en) VALUES ($1, $2) RETURNING id",
        [event, name],
      )
    )[0]?.id ?? "";
  const member = async (event: string) => {
    const player = await f.newPlayer();
    const enrollment = await f.join(event, player);
    return { player, enrollment, username: await f.usernameOf(player) };
  };
  const complete = async (event: string, enrollment: string, questId: string, occurrence = 1) => {
    const [done] = await f.owner<{ id: string }>(
      `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method, idempotency_key)
       SELECT organizer_id, id, $2, $3, $4, 'qr', $5 FROM event WHERE id = $1 RETURNING id`,
      [event, enrollment, questId, occurrence, randomUUID()],
    );
    const [entry] = await f.owner<{ id: string }>(
      `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                 completion_id, quest_id, actor)
       SELECT organizer_id, id, $2, 'quest', 10, 10, $3, $4, 'player' FROM event WHERE id = $1 RETURNING id`,
      [event, enrollment, done?.id, questId],
    );
    return entry?.id ?? "";
  };
  const sponsor = async (event: string, name: string): Promise<string> =>
    (
      await f.owner<{ id: string }>(
        `INSERT INTO sponsor (organizer_id, event_id, name_en, tier, created_by)
         SELECT organizer_id, id, $2, 'gold', $3 FROM event WHERE id = $1 RETURNING id`,
        [event, name, f.ownerA],
      )
    )[0]?.id ?? "";
  const tag = async (event: string, sponsorId: string, kind: string, item: string) => {
    await f.owner(
      `INSERT INTO sponsor_tag (organizer_id, event_id, sponsor_id, kind, ${kind}_id, created_by)
       SELECT organizer_id, id, $2, $3, $4, $5 FROM event WHERE id = $1`,
      [event, sponsorId, kind, item, f.ownerA],
    );
  };
  const reward = async (event: string, name: string, price: number) =>
    (
      await f.owner<{ id: string }>(
        `INSERT INTO reward (event_id, kind, name_en, price, stock_total)
         VALUES ($1, 'experience', $2, $3, 20) RETURNING id`,
        [event, name, price],
      )
    )[0]?.id ?? "";
  const redeem = async (event: string, rewardId: string) => {
    const who = await member(event);
    await f.owner(
      `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor)
       SELECT organizer_id, event_id, id, 'welcome', 100, 100, 'system' FROM enrollment WHERE id = $1`,
      [who.enrollment],
    );
    await f.asPlayer(who.player, "SELECT * FROM reserve_reward($1, $2)", [rewardId, randomUUID()]);
    return who;
  };

  describe("export_start", () => {
    it("writes one audit entry that names the kind and no row, and answers the join fields only for players", async () => {
      const event = await f.newEvent({ phase: "live" });
      await f.owner(
        "INSERT INTO event_join_field (event_id, kind, required, position) VALUES ($1, 'company', true, 0)",
        [event],
      );
      const request = randomUUID();
      const start = await read<{ zone: string; fields: { kind: string }[] }>(
        "export_start($1, 'players', NULL, $2)",
        [event, request],
      );
      expect(start.fields.map((field) => field.kind)).toEqual(["company"]);
      expect(start.zone).toBe("Asia/Riyadh");
      const other = await read<{ fields: unknown[] }>("export_start($1, 'completions', NULL, $2)", [
        event,
        randomUUID(),
      ]);
      expect(other.fields).toEqual([]);
      const audit = await f.owner<{
        action: string;
        after: Record<string, unknown>;
        actor_type: string;
      }>(
        "SELECT action, after, actor_type FROM audit_log WHERE event_id = $1 AND request_id = $2",
        [event, request],
      );
      expect(audit).toEqual([
        { action: "event.export", actor_type: "staff", after: { kind: "players" } },
      ]);
    });

    it("audits the report when it is printed and not when it is only viewed, and answers the same names", async () => {
      const event = await f.newEvent({ phase: "live" });
      const viewed = await read<{ name: Text; zone: string }>(
        "export_start($1, 'report_view', NULL, $2)",
        [event, randomUUID()],
      );
      const printRequest = randomUUID();
      const printed = await read<{ name: Text; zone: string }>(
        "export_start($1, 'report', NULL, $2)",
        [event, printRequest],
      );
      expect(viewed).toEqual(printed);
      const audit = await f.owner<{ after: Record<string, unknown> }>(
        "SELECT after FROM audit_log WHERE event_id = $1 AND action = 'event.export'",
        [event],
      );
      expect(audit).toEqual([{ after: { kind: "report" } }]);
    });

    it("refuses the report's preview to anyone but the event's team", async () => {
      const event = await f.newEvent({ phase: "live" });
      expect(
        await refusal(
          f.run(f.team(f.ownerA, f.ids.orgB), "SELECT export_start($1, 'report_view', NULL, $2)", [
            event,
            randomUUID(),
          ]),
        ),
      ).toBe("AN404");
    });

    it("refuses an unknown kind, a sponsor on any other export and no sponsor on the sponsor export", async () => {
      const event = await f.newEvent({ phase: "live" });
      const aSponsor = await sponsor(event, "Acme");
      for (const [kind, who] of [
        ["'payroll'", "NULL"],
        ["'players'", `'${aSponsor}'`],
        ["'sponsor'", "NULL"],
      ] as const) {
        expect(
          await refusal(
            f.run(f.team(), `SELECT export_start($1, ${kind}, ${who}, $2)`, [event, randomUUID()]),
          ),
          `${kind} ${who}`,
        ).toBe("AX400");
      }
    });

    it("refuses a sponsor of another event, and keeps no audit entry for a refusal", async () => {
      const event = await f.newEvent({ phase: "live" });
      const elsewhere = await sponsor(await f.newEvent({ phase: "live" }), "Elsewhere");
      const request = randomUUID();
      expect(
        await refusal(
          f.run(f.team(), "SELECT export_start($1, 'sponsor', $2, $3)", [
            event,
            elsewhere,
            request,
          ]),
        ),
      ).toBe("AN404");
      expect(
        await f.owner("SELECT 1 FROM audit_log WHERE request_id = $1", [request]),
      ).toHaveLength(0);
    });
  });

  describe("export_players", () => {
    it("lists the members with their join answers and points, and nothing the join card did not disclose", async () => {
      const event = await f.newEvent({ phase: "live" });
      const [field] = await f.owner<{ id: string }>(
        `INSERT INTO event_join_field (event_id, kind, required, position)
         VALUES ($1, 'company', true, 0) RETURNING id`,
        [event],
      );
      const first = await member(event);
      const second = await member(event);
      await f.owner(
        `INSERT INTO join_answer (enrollment_id, field_id, organizer_id, event_id, value)
         SELECT $1, $2, organizer_id, id, 'Acme' FROM event WHERE id = $3`,
        [first.enrollment, field?.id, event],
      );
      await f.earn(event, first.enrollment, { points: 30 });
      const waiting = await f.newPlayer();
      await f.owner("UPDATE enrollment SET status = 'pending' WHERE id = $1", [
        await f.join(event, waiting),
      ]);
      const rows = await read<Record<string, unknown>[]>("export_players($1)", [event]);
      expect(rows.map((row) => row["username"])).toEqual([first.username, second.username]);
      expect(rows[0]).toMatchObject({
        status: "active",
        points: 30,
        answers: { [field?.id ?? ""]: "Acme" },
      });
      expect(rows[1]).toMatchObject({ answers: {} });
      for (const row of rows) {
        expect(Object.keys(row).toSorted()).toEqual([
          "answers",
          "joinedAt",
          "points",
          "status",
          "username",
        ]);
      }
      expect(JSON.stringify(rows)).not.toMatch(/@|\+966|player_id|email|phone/i);
    });

    it("answers an empty list for an event nobody joined", async () => {
      const event = await f.newEvent({ phase: "live" });
      expect(await read("export_players($1)", [event])).toEqual([]);
    });
  });

  describe("export_completions", () => {
    it("reads the event's completions in pages that join up, marks a removed one and keeps other events out", async () => {
      const event = await f.newEvent({ phase: "live" });
      const stage = await quest(event, "Stage");
      const who = [await member(event), await member(event), await member(event)];
      const entries: string[] = [];
      for (const one of who) entries.push(await complete(event, one.enrollment, stage));
      await complete(event, who[0]?.enrollment ?? "", stage, 2);
      await f.removeEntry(event, entries[1] ?? "");
      const elsewhere = await f.newEvent({ phase: "live" });
      const otherQuest = await quest(elsewhere, "Elsewhere");
      await complete(elsewhere, (await member(elsewhere)).enrollment, otherQuest);

      const seen: CompletionPage["rows"] = [];
      let cursor: { at: string; id: number } | null = { at: "-infinity", id: 0 };
      let pages = 0;
      while (cursor !== null) {
        const page: CompletionPage = await read<CompletionPage>(
          "export_completions($1, $2, $3, 3)",
          [event, cursor.at, cursor.id],
        );
        seen.push(...page.rows);
        cursor = page.next;
        pages += 1;
      }
      expect(pages).toBe(2);
      expect(seen.map((row) => row.username)).toEqual([
        who[0]?.username,
        who[1]?.username,
        who[2]?.username,
        who[0]?.username,
      ]);
      expect(seen.map((row) => row.removed)).toEqual([false, true, false, false]);
      expect(seen.map((row) => row.occurrence)).toEqual([1, 1, 1, 2]);
      expect(seen.every((row) => row.quest.en === "Stage")).toBe(true);
    });

    it("ends on a full last page with a page that is empty and has no next", async () => {
      const event = await f.newEvent({ phase: "live" });
      const stage = await quest(event, "Stage");
      await complete(event, (await member(event)).enrollment, stage);
      const first = await read<CompletionPage>("export_completions($1, '-infinity', 0, 1)", [
        event,
      ]);
      expect(first.rows).toHaveLength(1);
      expect(first.next).not.toBeNull();
      const second = await read<CompletionPage>("export_completions($1, $2, $3, 1)", [
        event,
        first.next?.at,
        first.next?.id,
      ]);
      expect(second).toEqual({ rows: [], next: null });
    });

    it("refuses a page of no completions or of more than ten thousand", async () => {
      const event = await f.newEvent({ phase: "live" });
      for (const size of [0, 10001]) {
        expect(
          await refusal(
            f.run(f.team(), "SELECT export_completions($1, '-infinity', 0, $2)", [event, size]),
          ),
        ).toBe("AX400");
      }
    });
  });

  describe("export_redemptions, export_submissions and export_surveys", () => {
    it("lists a reward redemption with its price and status, and never a code or an id of a person", async () => {
      const event = await f.newEvent({ phase: "live" });
      const prize = await reward(event, "Hoodie", 40);
      const buyer = await redeem(event, prize);
      const rows = await read<Record<string, unknown>[]>("export_redemptions($1)", [event]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        username: buyer.username,
        reward: { en: "Hoodie" },
        price: 40,
        status: "reserved",
        endedAt: null,
      });
      expect(Object.keys(rows[0] ?? {}).toSorted()).toEqual([
        "endedAt",
        "price",
        "reservedAt",
        "reward",
        "status",
        "username",
      ]);
      expect(await read("export_redemptions($1)", [await f.newEvent({ phase: "live" })])).toEqual(
        [],
      );
    });

    it("lists a submission with its text, and a blank text once the player's account erased it", async () => {
      const event = await f.newEvent({ phase: "live" });
      const photo = await quest(event, "Describe it");
      const writer = await member(event);
      const gone = await member(event);
      for (const [who, body, erased] of [
        [writer, "= big idea", false],
        [gone, null, true],
      ] as const) {
        await f.owner(
          `INSERT INTO submission (organizer_id, event_id, enrollment_id, quest_id, kind, body, points, status,
                                   idempotency_key, erased_at)
           SELECT organizer_id, id, $2, $3, 'text', $4, 5, 'pending', $5, CASE WHEN $6 THEN now() END
           FROM event WHERE id = $1`,
          [event, who.enrollment, photo, body, randomUUID(), erased],
        );
      }
      const rows = await read<{ username: string; answer: string | null; status: string }[]>(
        "export_submissions($1)",
        [event],
      );
      expect(rows.map((row) => [row.username, row.answer, row.status])).toEqual([
        [writer.username, "= big idea", "pending"],
        [gone.username, null, "pending"],
      ]);
    });

    it("lists the event's survey quests with no player in their results", async () => {
      const event = await f.newEvent({ phase: "live" });
      await f.owner(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, visible, type_config)
         SELECT $1, (SELECT id FROM category WHERE event_id = $1 LIMIT 1), 'survey', 'Feedback', 10, 1, true, $2::jsonb`,
        [
          event,
          JSON.stringify({
            questions: [{ id: "a", kind: "rating", text: { en: "How was it?" } }],
          }),
        ],
      );
      const surveys = await read<
        { quest: Text; results: { total: number; questions: unknown[] } }[]
      >("export_surveys($1)", [event]);
      expect(surveys).toHaveLength(1);
      expect(surveys[0]?.quest.en).toBe("Feedback");
      expect(surveys[0]?.results).toMatchObject({ total: 0 });
    });
  });

  describe("analytics_sponsor", () => {
    it("counts only the sponsor's items: its tagged quests, its categories' untagged quests and its rewards", async () => {
      const event = await f.newEvent({ phase: "live" });
      const stageA = await category(event, "Stage");
      const hall = await category(event, "Hall");
      const own = await quest(event, "Tagged", hall);
      const inherited = await quest(event, "Inherited", stageA);
      const rival = await quest(event, "Rival", stageA);
      const plain = await quest(event, "Plain", hall);
      const acme = await sponsor(event, "Acme");
      const rivalSponsor = await sponsor(event, "Rival Co");
      await tag(event, acme, "quest", own);
      await tag(event, acme, "category", stageA);
      await tag(event, rivalSponsor, "quest", rival);
      const prize = await reward(event, "Mug", 10);
      const rivalPrize = await reward(event, "Cap", 10);
      await tag(event, acme, "reward", prize);
      await tag(event, rivalSponsor, "reward", rivalPrize);
      const [one, two, three] = [await member(event), await member(event), await member(event)];
      await complete(event, one.enrollment, own);
      await complete(event, one.enrollment, inherited);
      await complete(event, two.enrollment, own);
      await complete(event, three.enrollment, rival);
      await complete(event, three.enrollment, plain);
      await redeem(event, prize);
      await redeem(event, rivalPrize);

      const totals = await read<Sponsor>("analytics_sponsor($1, $2)", [event, acme]);
      expect(totals.sponsor).toEqual({ id: acme, name: { ar: null, en: "Acme" } });
      expect(totals).toMatchObject({ visits: 2, completions: 3, redemptions: 1 });
      expect(totals.quests.map((row) => [row.title.en, row.players]).toSorted()).toEqual([
        ["Inherited", 1],
        ["Tagged", 2],
      ]);
      expect(totals.categories.map((row) => [row.name.en, row.players])).toEqual([["Stage", 2]]);
      expect(totals.rewards.map((row) => [row.name.en, row.redeemed])).toEqual([["Mug", 1]]);
      expect(JSON.stringify(totals)).not.toMatch(/username|enrollment|player_id|@/i);
    });

    it("leaves out a completion the team removed", async () => {
      const event = await f.newEvent({ phase: "live" });
      const stage = await quest(event, "Stage");
      const acme = await sponsor(event, "Acme");
      await tag(event, acme, "quest", stage);
      const kept = await member(event);
      const removed = await member(event);
      await complete(event, kept.enrollment, stage);
      await f.removeEntry(event, await complete(event, removed.enrollment, stage));
      expect(await read<Sponsor>("analytics_sponsor($1, $2)", [event, acme])).toMatchObject({
        visits: 1,
        completions: 1,
      });
    });

    it("shows zero everywhere for a sponsor with nothing tagged", async () => {
      const event = await f.newEvent({ phase: "live" });
      const empty = await sponsor(event, "Nobody");
      expect(await read<Sponsor>("analytics_sponsor($1, $2)", [event, empty])).toMatchObject({
        visits: 0,
        completions: 0,
        redemptions: 0,
        quests: [],
        categories: [],
        rewards: [],
      });
    });

    it("answers 404 for a sponsor of another event and for another organizer's team", async () => {
      const event = await f.newEvent({ phase: "live" });
      const elsewhere = await sponsor(await f.newEvent({ phase: "live" }), "Elsewhere");
      expect(
        await refusal(f.run(f.team(), "SELECT analytics_sponsor($1, $2)", [event, elsewhere])),
      ).toBe("AN404");
      expect(
        await refusal(
          f.run(f.team(f.ownerA, f.ids.orgB), "SELECT analytics_sponsor($1, $2)", [
            event,
            elsewhere,
          ]),
        ),
      ).toBe("AN404");
    });
  });
});
