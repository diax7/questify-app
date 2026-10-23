import { randomUUID } from "node:crypto";
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

/** The SQLSTATE and DETAIL a call is refused with. */
const refusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    const { code, detail } = error as { code: string; detail?: string };
    return detail === undefined ? code : `${code}:${detail}`;
  }
  throw new Error("expected a refusal");
};

const OPTIONS = [
  { id: "women", ar: "نساء", en: "Women" },
  { id: "men", ar: "رجال", en: "Men" },
];

/**
 * Targeting in the database (T-220, migration 0037, ADR-170 to ADR-173): who sees and may complete a targeted
 * category, reserve or pin a targeted reward; tags by phone and email; rehearsal; options and fields in use; the
 * rule's writer; leaving and rejoining; a draft event's delete.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("targeting (database)", () => {
  let db: TestDatabase;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let ownerA: string;
  let editorA: string;
  let ownerB: string;
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    ids = await seedTwoTenants(db.owner);
    ownerA = await addMember(db.owner, ids.orgA);
    editorA = await addMember(db.owner, ids.orgA, "editor");
    ownerB = await addMember(db.owner, ids.orgB);
  });
  afterAll(async () => {
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const as = async <T extends Row>(context: RequestContext, sql: string, values: unknown[] = []) =>
    withRequestContext(db.app, context, async () => (await db.app.query<T>(sql, values)).rows);
  const teamA = (staff = ownerA): RequestContext => ({ organizerId: ids.orgA, staffUserId: staff });

  type Setup = {
    id: string;
    code: string;
    field: string;
    category: string;
    quest: string;
    reward: string;
  };

  /** A live public event with a choice field, a category holding one code quest, and a reward. */
  const newEvent = async (status = "live"): Promise<Setup> => {
    counter += 1;
    const code = `TG${String(counter).padStart(4, "0")}`;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at, welcome_points)
       VALUES ($1, $2, 'Target Day', $3, now() - interval '1 hour', now() + interval '1 day', 100) RETURNING id`,
      [ids.orgA, code, status],
    );
    const id = event?.id ?? "";
    const [field] = await as<{ id: string }>(
      teamA(),
      `INSERT INTO event_join_field (event_id, kind, label_en, required, position, options)
       VALUES ($1, 'custom', 'Section', true, 0, $2::jsonb) RETURNING id`,
      [id, JSON.stringify(OPTIONS)],
    );
    const [category] = await owner<{ id: string }>(
      "INSERT INTO category (event_id, name_en) VALUES ($1, 'Ladies') RETURNING id",
      [id],
    );
    const [quest] = await owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
       VALUES ($1, $2, 'enter_code', 'Booth', 10, '{"code": "ABC"}') RETURNING id`,
      [id, category?.id],
    );
    const [reward] = await owner<{ id: string }>(
      "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, 'experience', 'Spa', 50, 9) RETURNING id",
      [id],
    );
    return {
      id,
      code,
      field: field?.id ?? "",
      category: category?.id ?? "",
      quest: quest?.id ?? "",
      reward: reward?.id ?? "",
    };
  };

  const newPlayer = async (contact: { phone?: string; email?: string } = {}): Promise<string> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`target_${counter}`],
    );
    await owner("INSERT INTO player_contact (player_id, phone_e164, email) VALUES ($1, $2, $3)", [
      player?.id,
      contact.phone ?? null,
      contact.email ?? `t${counter}@example.com`,
    ]);
    return player?.id ?? "";
  };

  const join = async (player: string, event: Setup, section: string) =>
    (
      await as<{ outcome: string; enrollment_id: string }>(
        { playerId: player },
        "SELECT * FROM join_event($1, 'code', '0.2', $2::jsonb)",
        [event.code, JSON.stringify({ [event.field]: section })],
      )
    )[0];

  const member = async (event: Setup, section: string, contact = {}) => {
    const player = await newPlayer(contact);
    const joined = await join(player, event, section);
    return { player, enrollment: joined?.enrollment_id ?? "" };
  };

  const setAudience = (
    event: string,
    kind: "category" | "reward",
    item: string,
    rule: { kind: "answer" | "tag"; field?: string | undefined; values: string[] } | null,
    context: RequestContext = teamA(),
  ) =>
    as<{ outcome: string }>(context, "SELECT set_audience($1, $2, $3, $4, $5, $6, $7) AS outcome", [
      event,
      kind,
      item,
      rule?.kind ?? null,
      rule?.field ?? null,
      rule?.values ?? null,
      randomUUID(),
    ]).then((rows) => rows[0]?.outcome);

  const women = (event: Setup) => ({
    kind: "answer" as const,
    field: event.field,
    values: ["women"],
  });

  const categoriesOf = async (player: string, event: Setup) =>
    (
      await as<{ category_id: string }>(
        { playerId: player },
        "SELECT DISTINCT category_id FROM member_event_quests($1)",
        [event.id],
      )
    ).map((row) => row.category_id);
  const shopOf = async (player: string, event: Setup) =>
    (
      await as<{ id: string }>({ playerId: player }, "SELECT id FROM shop_rewards($1)", [event.id])
    ).map((row) => row.id);
  const complete = (player: string, event: Setup) =>
    as({ playerId: player }, "SELECT * FROM complete_quest($1, 'code', NULL, 'ABC', $2, NULL)", [
      event.quest,
      randomUUID(),
    ]);
  const reserve = (player: string, event: Setup) =>
    as({ playerId: player }, "SELECT * FROM reserve_reward($1, $2)", [event.reward, randomUUID()]);
  const pin = (player: string, event: Setup) =>
    as({ playerId: player }, "SELECT set_goal($1, $2)", [event.id, event.reward]);

  describe("a rule by answer", () => {
    it("shows and opens a category to the matching answer only; others get not_for_you", async () => {
      const event = await newEvent();
      const her = await member(event, "women");
      const him = await member(event, "men");
      expect(await setAudience(event.id, "category", event.category, women(event))).toBe("changed");
      expect(await categoriesOf(her.player, event)).toEqual([event.category]);
      expect(await categoriesOf(him.player, event)).toEqual([]);
      await expect(complete(her.player, event)).resolves.toHaveLength(1);
      expect(await refusal(complete(him.player, event))).toBe("QN403:not_for_you");
    });

    it("refuses the team's quest award for a player outside the audience too", async () => {
      const event = await newEvent();
      const him = await member(event, "men");
      await setAudience(event.id, "category", event.category, women(event));
      const award = as(teamA(), "SELECT * FROM staff_award($1, $2, $3, NULL, 'Helped', $4, $5)", [
        event.id,
        him.enrollment,
        event.quest,
        randomUUID(),
        randomUUID(),
      ]);
      expect(await refusal(award)).toBe("QN403:not_for_you");
    });

    it("refuses an operator's My QR scan of a player outside the audience", async () => {
      const event = await newEvent();
      const him = await member(event, "men");
      const operator = await newPlayer();
      await owner(
        `INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities)
         VALUES ($1, $2, $3, '{scan_quests}')`,
        [ids.orgA, event.id, operator],
      );
      const [booth] = await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, verification)
         VALUES ($1, $2, 'scan_qr', 'Desk', 10, '{my_qr}') RETURNING id`,
        [event.id, event.category],
      );
      await setAudience(event.id, "category", event.category, women(event));
      const scan = as(
        { playerId: operator },
        "SELECT * FROM operator_complete_quest($1, $2, 1, $3)",
        [booth?.id, him.player, randomUUID()],
      );
      expect(await refusal(scan)).toBe("QN403:not_for_you");
    });

    it("hides a reward from the shop, its reservation and its pin; the matching player reserves it", async () => {
      const event = await newEvent();
      const her = await member(event, "women");
      const him = await member(event, "men");
      expect(await setAudience(event.id, "reward", event.reward, women(event))).toBe("changed");
      expect(await shopOf(her.player, event)).toEqual([event.reward]);
      expect(await shopOf(him.player, event)).toEqual([]);
      expect(await refusal(reserve(him.player, event))).toBe("RN404");
      expect(await refusal(pin(him.player, event))).toBe("RN404");
      await expect(pin(her.player, event)).resolves.toHaveLength(1);
      await expect(reserve(her.player, event)).resolves.toHaveLength(1);
    });

    it("applies a change at the next read and keeps earlier points and reservations", async () => {
      const event = await newEvent();
      const him = await member(event, "men");
      await complete(him.player, event);
      await reserve(him.player, event);
      await setAudience(event.id, "category", event.category, women(event));
      await setAudience(event.id, "reward", event.reward, women(event));
      expect(await categoriesOf(him.player, event)).toEqual([]);
      const [kept] = await owner<{ score: string; held: number }>(
        `SELECT n.score, (SELECT count(*)::int FROM redemption d WHERE d.enrollment_id = n.id) AS held
         FROM enrollment n WHERE n.id = $1`,
        [him.enrollment],
      );
      expect(kept).toEqual({ score: "110", held: 1 });
      expect(await setAudience(event.id, "category", event.category, null)).toBe("changed");
      expect(await categoriesOf(him.player, event)).toEqual([event.category]);
    });

    it("keeps a returning player's answer, so leaving and rejoining cannot switch audience", async () => {
      const event = await newEvent();
      const him = await member(event, "men");
      await setAudience(event.id, "category", event.category, women(event));
      await as({ playerId: him.player }, "UPDATE enrollment SET status = 'left' WHERE id = $1", [
        him.enrollment,
      ]);
      expect((await join(him.player, event, "women"))?.outcome).toBe("joined");
      expect(
        await owner("SELECT value FROM join_answer WHERE enrollment_id = $1", [him.enrollment]),
      ).toEqual([{ value: "men" }]);
      expect(await categoriesOf(him.player, event)).toEqual([]);
    });

    it("refuses an answer that is not one of the options", async () => {
      const event = await newEvent();
      const player = await newPlayer();
      expect(await refusal(join(player, event, "Women"))).toBe(`JA422:field:${event.field}`);
    });

    it("hides every targeted category from the signed-out event page", async () => {
      const event = await newEvent();
      const [open] = await owner<{ id: string }>(
        "INSERT INTO category (event_id, name_en) VALUES ($1, 'Everyone') RETURNING id",
        [event.id],
      );
      await owner(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
         VALUES ($1, $2, 'enter_code', 'Open', 5, '{"code": "XYZ"}')`,
        [event.id, open?.id],
      );
      await setAudience(event.id, "category", event.category, women(event));
      const rows = await as<{ category_id: string }>(
        {},
        "SELECT category_id FROM public_event_quests($1)",
        [event.code],
      );
      expect(rows.map((row) => row.category_id)).toEqual([open?.id]);
    });
  });

  describe("a rule by guest tag", () => {
    it("matches a tag on the player's phone or email entry, ignoring case; untagged players are out", async () => {
      const event = await newEvent();
      const byPhone = await member(event, "men", { phone: "+966511110001" });
      const byEmail = await member(event, "men", { email: "vip@acme.sa" });
      const plain = await member(event, "men", { phone: "+966511110002" });
      await as(
        teamA(),
        `INSERT INTO event_guest (event_id, kind, value, tag)
         VALUES ($1, 'phone', '+966511110001', 'VIP'), ($1, 'email', 'vip@acme.sa', 'vip'),
                ($1, 'phone', '+966511110002', NULL)`,
        [event.id],
      );
      expect(
        await setAudience(event.id, "reward", event.reward, { kind: "tag", values: ["Vip"] }),
      ).toBe("changed");
      expect(await shopOf(byPhone.player, event)).toEqual([event.reward]);
      expect(await shopOf(byEmail.player, event)).toEqual([event.reward]);
      expect(await shopOf(plain.player, event)).toEqual([]);
      const [stored] = await owner<{ audience_values: string[] }>(
        "SELECT audience_values FROM reward WHERE id = $1",
        [event.reward],
      );
      expect(stored?.audience_values).toEqual(["vip"]);
    });

    it("shows everything to a rehearsal enrollment", async () => {
      const event = await newEvent();
      const player = await newPlayer();
      await owner(
        `INSERT INTO enrollment (organizer_id, event_id, player_id, joined_via) VALUES ($1, $2, $3, 'rehearsal')`,
        [ids.orgA, event.id, player],
      );
      await setAudience(event.id, "category", event.category, { kind: "tag", values: ["vip"] });
      expect(await categoriesOf(player, event)).toEqual([event.category]);
    });
  });

  const setOptions = (field: string, options: unknown) =>
    as(teamA(), "UPDATE event_join_field SET options = $2::jsonb WHERE id = $1", [
      field,
      options === null ? null : JSON.stringify(options),
    ]);

  describe("fields and options in use (ADR-173)", () => {
    it("sets options only while a field has no answers", async () => {
      const event = await newEvent();
      const [free] = await as<{ id: string }>(
        teamA(),
        `INSERT INTO event_join_field (event_id, kind, label_en, position) VALUES ($1, 'custom', 'Team', 1)
         RETURNING id`,
        [event.id],
      );
      await setOptions(free?.id ?? "", OPTIONS);
      await setOptions(free?.id ?? "", null);
      const player = await newPlayer();
      await as({ playerId: player }, "SELECT * FROM join_event($1, 'code', '0.2', $2::jsonb)", [
        event.code,
        JSON.stringify({ [event.field]: "men", [free?.id ?? ""]: "Blue" }),
      ]);
      expect(await refusal(setOptions(free?.id ?? "", OPTIONS))).toBe("QT409:answers");
    });

    it("adds options and edits labels after answers; refuses removing an answered option or clearing all", async () => {
      const event = await newEvent();
      await member(event, "men");
      const relabelled = [
        { id: "women", ar: "سيدات", en: "Ladies" },
        OPTIONS[1],
        { id: "kids", en: "Kids" },
      ];
      await setOptions(event.field, relabelled);
      expect(await refusal(setOptions(event.field, [relabelled[0], relabelled[2]]))).toBe(
        "QT409:answers",
      );
      expect(await refusal(setOptions(event.field, null))).toBe("QT409:answers");
      await setOptions(event.field, [relabelled[0], relabelled[1]]);
    });

    it("refuses removing an option a rule names, or clearing the options, and deleting the field", async () => {
      const event = await newEvent();
      await setAudience(event.id, "reward", event.reward, women(event));
      expect(await refusal(setOptions(event.field, [OPTIONS[1], { id: "kids", en: "Kids" }]))).toBe(
        "QT409:rules",
      );
      expect(await refusal(setOptions(event.field, null))).toBe("QT409:rules");
      expect(
        await refusal(as(teamA(), "DELETE FROM event_join_field WHERE id = $1", [event.field])),
      ).toMatch(/^23503:/);
      await setOptions(event.field, [OPTIONS[0], { id: "kids", en: "Kids" }]);
    });

    it("refuses options of a bad shape or on a field that is not custom", async () => {
      const event = await newEvent();
      for (const bad of [
        [OPTIONS[0]],
        [OPTIONS[0], OPTIONS[0]],
        [OPTIONS[0], { id: "Bad Id", en: "x" }],
        [OPTIONS[0], { id: "x" }],
        [OPTIONS[0], { id: "x", en: " padded" }],
        [OPTIONS[0], { id: "x", en: "y", extra: 1 }],
        { id: "x" },
      ]) {
        expect(await refusal(setOptions(event.field, bad)), JSON.stringify(bad)).toBe("23514");
      }
      const typed = as(
        teamA(),
        `INSERT INTO event_join_field (event_id, kind, position, options) VALUES ($1, 'company', 1, $2::jsonb)`,
        [event.id, JSON.stringify(OPTIONS)],
      );
      expect(await refusal(typed)).toBe("23514");
    });

    it("lets a draft event with targeted items be deleted in one statement", async () => {
      const event = await newEvent("draft");
      await setAudience(event.id, "category", event.category, women(event));
      await setAudience(event.id, "reward", event.reward, women(event));
      await owner("DELETE FROM event WHERE id = $1", [event.id]);
      expect(await owner("SELECT 1 FROM event WHERE id = $1", [event.id])).toEqual([]);
    });
  });

  describe("setting a rule", () => {
    it("lets the owner and an editor in scope set it, and nobody else", async () => {
      const event = await newEvent();
      const outOfScope = await addMember(db.owner, ids.orgA, "editor", [ids.eventA]);
      expect(
        await setAudience(event.id, "category", event.category, women(event), teamA(editorA)),
      ).toBe("changed");
      for (const context of [
        teamA(outOfScope),
        { organizerId: ids.orgB, staffUserId: ownerB },
        { playerId: ids.playerA },
      ]) {
        expect(await setAudience(event.id, "category", event.category, null, context)).toBe(
          "not_found",
        );
      }
      expect(await setAudience(event.id, "reward", event.category, null)).toBe("not_found");
    });

    it("refuses what is not a valid rule and answers unchanged for the same one", async () => {
      const event = await newEvent();
      const [free] = await as<{ id: string }>(
        teamA(),
        `INSERT INTO event_join_field (event_id, kind, position) VALUES ($1, 'company', 1) RETURNING id`,
        [event.id],
      );
      for (const rule of [
        { kind: "answer" as const, field: free?.id, values: ["acme"] },
        { kind: "answer" as const, field: event.field, values: ["kids"] },
        { kind: "answer" as const, field: event.field, values: [] },
        { kind: "answer" as const, values: ["women"] },
        { kind: "tag" as const, field: event.field, values: ["vip"] },
        { kind: "tag" as const, values: [" vip"] },
        { kind: "tag" as const, values: ["x".repeat(31)] },
        { kind: "tag" as const, values: Array.from({ length: 21 }, (_, i) => `t${i}`) },
      ]) {
        expect(
          await setAudience(event.id, "category", event.category, rule),
          JSON.stringify(rule),
        ).toBe("invalid");
      }
      expect(await setAudience(event.id, "category", event.category, women(event))).toBe("changed");
      expect(
        await setAudience(event.id, "category", event.category, {
          ...women(event),
          values: ["women", "women"],
        }),
      ).toBe("unchanged");
    });

    it("answers archived for an archived event", async () => {
      const event = await newEvent();
      await owner("UPDATE event SET status = 'archived' WHERE id = $1", [event.id]);
      expect(await setAudience(event.id, "category", event.category, null)).toBe("archived");
    });

    it("clears the rule of a removed reward, so its field can go", async () => {
      const event = await newEvent();
      await setAudience(event.id, "reward", event.reward, women(event));
      await as(teamA(), "UPDATE reward SET status = 'removed' WHERE id = $1", [event.reward]);
      expect(await setAudience(event.id, "reward", event.reward, null)).toBe("changed");
      await as(teamA(), "DELETE FROM event_join_field WHERE id = $1", [event.field]);
    });

    it("audits ids and counts only, never a tag", async () => {
      const event = await newEvent();
      await setAudience(event.id, "reward", event.reward, {
        kind: "tag",
        values: ["Secret Group"],
      });
      const [entry] = await owner<{ action: string; before: Row; after: Row }>(
        "SELECT action, before, after FROM audit_log WHERE target_id = $1 ORDER BY id DESC LIMIT 1",
        [event.reward],
      );
      expect(entry).toEqual({
        action: "reward.audience",
        before: { kind: null, fieldId: null, values: null },
        after: { kind: "tag", fieldId: null, values: 1 },
      });
    });

    it("counts the members each rule reaches, for the team only", async () => {
      const event = await newEvent();
      await member(event, "women");
      await member(event, "women");
      await member(event, "men");
      await setAudience(event.id, "category", event.category, women(event));
      expect(await as(teamA(), "SELECT * FROM audience_counts($1)", [event.id])).toEqual([
        { item_kind: "category", item_id: event.category, members: 2 },
      ]);
      expect(
        await as(
          { organizerId: ids.orgB, staffUserId: ownerB },
          "SELECT * FROM audience_counts($1)",
          [event.id],
        ),
      ).toEqual([]);
    });

    it("is written only through set_audience: the API role cannot touch the columns", async () => {
      const event = await newEvent();
      expect(
        await refusal(
          as(teamA(), "UPDATE category SET audience_kind = NULL WHERE id = $1", [event.category]),
        ),
      ).toBe("42501");
      expect(
        await refusal(
          as(teamA(), "UPDATE reward SET audience_kind = NULL WHERE id = $1", [event.reward]),
        ),
      ).toBe("42501");
    });
  });
});
