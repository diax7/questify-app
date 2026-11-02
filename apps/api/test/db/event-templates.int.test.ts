import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { templateRowSchema, type TemplateRow } from "@questify/shared";
import { pushFixture, type PushFixture } from "#test/support/push";
import { addMember, TEST_DATABASE_URL } from "#test/support/test-db";

type Applied = {
  template: string;
  categories: number;
  quests: number;
  rewards: number;
  layoutPreset: string;
};

/** A call's SQLSTATE and detail ("ED409:target_not_empty"), or "none". */
const refusal = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "none",
    (error: { code?: string; detail?: string }) =>
      error.detail === undefined || error.detail === ""
        ? `${error.code}`
        : `${error.code}:${error.detail}`,
  );

const body = (title: string) => ({
  config: { features: {}, accent: "honey", layoutPreset: "classic" },
  categories: [
    {
      nameAr: "فئة",
      nameEn: "Group",
      orderMode: "any",
      completionBonus: 0,
      quests: [
        {
          type: "scan_qr",
          titleAr: "عنوان",
          titleEn: title,
          descriptionAr: "وصف",
          descriptionEn: "Text",
          points: 10,
          repeatCap: 1,
          typeConfig: {},
        },
      ],
    },
  ],
  rewards: [],
});

const KEYS = ["conference", "festival", "campus", "corporate"];

/**
 * Event templates in the database (T-601b, migration 0115; plan docs/plans/2026-11-02-t-601b-event-templates.md, ADR-404): the
 * four shipped templates are checked against the shared schema, `event_apply_template` fills an empty draft with fresh rows
 * and never a player, a point, a code or a secret, and it works only inside the caller's own organizer.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("event templates (database)", () => {
  let f: PushFixture;
  let counter = 0;

  const draft = async (organizer = f.ids.orgA, status = "draft"): Promise<string> => {
    counter += 1;
    const [row] = await f.owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Template', $3, now() + interval '30 days', now() + interval '31 days') RETURNING id`,
      [organizer, `TPL${counter}`, status],
    );
    return row?.id ?? "";
  };
  const templates = async (seat = f.team()): Promise<TemplateRow[]> => {
    const [row] = await f.run<{ list: unknown[] }>(seat, "SELECT event_templates() AS list");
    return (row?.list ?? []).map((one) => templateRowSchema.parse(one));
  };
  const apply = (event: string, key: string, seat = f.team()) =>
    f.run<{ r: Applied }>(seat, "SELECT event_apply_template($1, $2, $3) AS r", [
      event,
      key,
      randomUUID(),
    ]);
  const count = async (table: string, event: string): Promise<number> =>
    (
      await f.owner<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE event_id = $1`, [
        event,
      ])
    )[0]?.n ?? 0;

  beforeAll(async () => {
    f = await pushFixture();
  });
  afterAll(async () => {
    await f.close();
  });

  it("ships conference, festival, campus and corporate, valid and in both languages", async () => {
    const shipped = await templates();
    expect(shipped.map((one) => one.key)).toEqual(KEYS);
    for (const one of shipped) {
      const quests = one.body.categories.flatMap((category) => category.quests);
      expect(one.body.categories.length, one.key).toBeGreaterThanOrEqual(3);
      expect(quests.length, one.key).toBeGreaterThanOrEqual(8);
      expect(quests.length, one.key).toBeLessThanOrEqual(16);
      expect(one.body.rewards.length, one.key).toBeGreaterThanOrEqual(4);
      expect(new Set(quests.map((quest) => quest.type)).size, one.key).toBeGreaterThanOrEqual(4);
      expect(new Set(quests.map((quest) => quest.titleEn)).size, one.key).toBe(quests.length);
      expect(one.name.ar, one.key).not.toBe(one.name.en);
    }
  });

  it("prices every reward within reach of the points a player can earn from the quests", async () => {
    for (const one of await templates()) {
      const earnable =
        one.body.categories
          .flatMap((category) => category.quests)
          .reduce((sum, quest) => sum + quest.points * (quest.type === "meet" ? 2 : 1), 0) +
        one.body.categories.reduce((sum, category) => sum + category.completionBonus, 0);
      const prices = one.body.rewards.map((reward) => reward.price);
      expect(Math.min(...prices), one.key).toBeLessThanOrEqual(earnable / 4);
      expect(Math.max(...prices), one.key).toBeLessThanOrEqual(earnable * 0.8);
    }
  });

  it("fills an empty draft with the template's categories, quests and rewards in both languages", async () => {
    const [festival] = (await templates()).filter((one) => one.key === "festival");
    const target = await draft();
    expect(await count("category", target)).toBe(1);
    const answer = (await apply(target, "festival"))[0]?.r;
    const quests = festival?.body.categories.flatMap((category) => category.quests) ?? [];
    expect(answer).toMatchObject({
      template: "festival",
      categories: festival?.body.categories.length,
      quests: quests.length,
      rewards: festival?.body.rewards.length,
      layoutPreset: "play_first",
    });
    const categories = await f.owner<{ name_ar: string; name_en: string; position: number }>(
      "SELECT name_ar, name_en, position FROM category WHERE event_id = $1 ORDER BY position",
      [target],
    );
    expect(categories.map((row) => [row.name_ar, row.name_en, row.position])).toEqual(
      (festival?.body.categories ?? []).map((category, index) => [
        category.nameAr,
        category.nameEn,
        index,
      ]),
    );
    const stored = await f.owner<{
      type: string;
      points: number;
      title_ar: string;
      title_en: string;
      description_ar: string;
      description_en: string;
      type_config: unknown;
      verification: string[];
    }>(
      `SELECT q.type, q.points, q.title_ar, q.title_en, q.description_ar, q.description_en, q.type_config, q.verification
       FROM quest q JOIN category c ON c.id = q.category_id
       WHERE q.event_id = $1 ORDER BY c.position, q.position`,
      [target],
    );
    expect(stored.map((row) => [row.type, row.points, row.title_ar, row.title_en])).toEqual(
      quests.map((quest) => [quest.type, quest.points, quest.titleAr, quest.titleEn]),
    );
    for (const [index, row] of stored.entries()) {
      expect(row.type_config, quests[index]?.titleEn).toEqual(quests[index]?.typeConfig);
      expect(row.description_ar).not.toBe("");
      expect(row.description_en).not.toBe("");
    }
    expect(stored.find((row) => row.type === "scan_qr")?.verification).toEqual(["quest_qr"]);
    expect(stored.find((row) => row.type === "challenge")?.verification).toEqual(["my_qr"]);
  });

  it("adds rewards without stock, codes or an item that needs the prize desk", async () => {
    const target = await draft();
    await apply(target, "conference");
    const rewards = await f.owner<{
      kind: string;
      stock_total: number;
      units_out: number;
      position: number;
    }>(
      "SELECT kind, stock_total, units_out, position FROM reward WHERE event_id = $1 ORDER BY position",
      [target],
    );
    expect(rewards.length).toBeGreaterThanOrEqual(4);
    expect(rewards.map((row) => row.position)).toEqual(rewards.map((_, index) => index));
    for (const row of rewards) {
      expect(["experience", "digital"]).toContain(row.kind);
      expect([row.stock_total, row.units_out]).toEqual([0, 0]);
    }
    expect(await count("reward_code", target)).toBe(0);
    expect(await count("quest_item", target)).toBe(0);
  });

  it("lays the template's switches and accent over the event and bumps its configuration version", async () => {
    const target = await draft();
    await f.owner(
      `UPDATE event SET config = '{"features": {"ranking": false}, "terms": {"currency": {"en": "Gems"}}}' WHERE id = $1`,
      [target],
    );
    const [before] = await f.owner<{ config_version: number }>(
      "SELECT config_version FROM event WHERE id = $1",
      [target],
    );
    await apply(target, "conference");
    const [after] = await f.owner<{ config: Record<string, unknown>; config_version: number }>(
      "SELECT config, config_version FROM event WHERE id = $1",
      [target],
    );
    expect(after?.config).toMatchObject({
      features: { ranking: false, miniGames: false, questRatings: true },
      branding: { accent: "sky" },
      terms: { currency: { en: "Gems" } },
    });
    expect(after?.config_version).toBe((before?.config_version ?? 0) + 1);
  });

  it("holds no player, point, code or secret, and audits what it added", async () => {
    const target = await draft();
    await apply(target, "campus");
    for (const table of [
      "enrollment",
      "quest_completion",
      "ledger_entry",
      "redemption",
      "reward_code",
      "nfc_tag",
      "paired_device",
      "staff_assignment",
      "event_guest",
      "submission",
    ]) {
      expect(await count(table, target), table).toBe(0);
    }
    const secrets = await f.owner<{ n: number }>(
      "SELECT count(*)::int AS n FROM quest WHERE event_id = $1 AND type_config ? 'code'",
      [target],
    );
    expect(secrets[0]?.n).toBe(0);
    const [entry] = await f.owner<{ after: Record<string, unknown>; actor_id: string }>(
      "SELECT after, actor_id FROM audit_log WHERE event_id = $1 AND action = 'event.template'",
      [target],
    );
    expect(entry?.after).toMatchObject({ template: "campus", categories: 4 });
    expect(entry?.actor_id).toBe(f.ownerA);
  });

  it("keeps each event's copy its own: editing one changes only that event and never the template", async () => {
    const first = await draft();
    const second = await draft();
    await apply(first, "festival");
    await apply(second, "festival");
    const before = await templates();
    await f.owner("UPDATE quest SET title_en = 'Changed', points = 1 WHERE event_id = $1", [first]);
    await f.owner("DELETE FROM reward WHERE event_id = $1", [first]);
    const titles = await f.owner<{ title_en: string }>(
      "SELECT title_en FROM quest WHERE event_id = $1 AND title_en = 'Changed'",
      [second],
    );
    expect(titles).toEqual([]);
    expect(await count("reward", second)).toBeGreaterThan(0);
    expect(await templates()).toEqual(before);
  });

  it("starts a new event from an edited template and leaves earlier events as they were", async () => {
    await f.owner(
      `INSERT INTO event_template (key, position, name_ar, name_en, description_ar, description_en, body)
       VALUES ('edited', 98, 'قالب', 'Edited', 'وصف', 'Text', $1::jsonb)`,
      [JSON.stringify(body("Version one"))],
    );
    try {
      const earlier = await draft();
      await apply(earlier, "edited");
      await f.owner("UPDATE event_template SET body = $1::jsonb WHERE key = 'edited'", [
        JSON.stringify(body("Version two")),
      ]);
      const later = await draft();
      await apply(later, "edited");
      const titleOf = async (event: string) =>
        (
          await f.owner<{ title_en: string }>("SELECT title_en FROM quest WHERE event_id = $1", [
            event,
          ])
        )[0]?.title_en;
      expect([await titleOf(earlier), await titleOf(later)]).toEqual([
        "Version one",
        "Version two",
      ]);
      await f.owner("UPDATE event_template SET enabled = false WHERE key = 'edited'");
      expect((await templates()).map((one) => one.key)).toEqual(KEYS);
      expect(await refusal(apply(await draft(), "edited"))).toBe("ET404:unknown_template");
    } finally {
      await f.owner("DELETE FROM event_template WHERE key = 'edited'");
    }
  });

  it("leaves the draft untouched when a template cannot be applied in full", async () => {
    await f.owner(
      `INSERT INTO event_template (key, position, name_ar, name_en, description_ar, description_en, body)
       VALUES ('broken', 97, 'قالب', 'Broken', 'وصف', 'Text', $1::jsonb)`,
      [
        JSON.stringify({
          config: { features: {}, accent: "honey", layoutPreset: "classic" },
          categories: [
            {
              nameAr: "فئة",
              nameEn: "Group",
              orderMode: "any",
              completionBonus: 0,
              quests: [
                {
                  type: "scan_qr",
                  titleAr: "ع",
                  titleEn: "T",
                  descriptionAr: "و",
                  descriptionEn: "D",
                  points: -5,
                  repeatCap: 1,
                  typeConfig: {},
                },
              ],
            },
          ],
          rewards: [],
        }),
      ],
    );
    try {
      const target = await draft();
      expect(await refusal(apply(target, "broken"))).toMatch(/^23514/);
      expect(await count("category", target)).toBe(1);
      expect(await count("quest", target)).toBe(0);
      expect(await count("audit_log", target)).toBe(0);
    } finally {
      await f.owner("DELETE FROM event_template WHERE key = 'broken'");
    }
  });

  it("refuses an unknown template and anything but an empty draft", async () => {
    const target = await draft();
    expect(await refusal(apply(target, "wedding"))).toBe("ET404:unknown_template");
    expect(await count("category", target)).toBe(1);
    await apply(target, "corporate");
    expect(await refusal(apply(target, "festival"))).toBe("ED409:target_not_empty");
    const scheduled = await draft(f.ids.orgA, "scheduled");
    expect(await refusal(apply(scheduled, "festival"))).toBe("ED409:target_not_empty");
    const joined = await draft();
    await f.join(joined, await f.newPlayer());
    expect(await refusal(apply(joined, "festival"))).toBe("ED409:target_not_empty");
    expect(await count("quest", joined)).toBe(0);
    const withReward = await draft();
    await f.owner(
      "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, 'experience', 'Mine', 10, 1)",
      [withReward],
    );
    expect(await refusal(apply(withReward, "festival"))).toBe("ED409:target_not_empty");
  });

  it("works only for the signed-in team of the event's own organizer and scope", async () => {
    const mine = await draft();
    const theirs = await draft(f.ids.orgB);
    expect(await refusal(apply(theirs, "festival"))).toBe("AN404");
    expect(await count("quest", theirs)).toBe(0);
    expect(await refusal(apply(mine, "festival", f.team(f.ownerA, f.ids.orgB)))).toBe("AN404");
    const limited = await addMember(f.db.owner, f.ids.orgA, "editor", [await draft()]);
    expect(await refusal(apply(mine, "festival", f.team(limited)))).toBe("AN404");
    expect(await refusal(apply(mine, "festival", { organizerId: f.ids.orgA }))).toBe("AN404");
    expect(await refusal(apply(mine, "festival", { playerId: await f.newPlayer() }))).toBe("AN404");
    expect(await count("quest", mine)).toBe(0);
    expect(await count("audit_log", mine)).toBe(0);
  });

  it("lists templates only to a signed-in team member", async () => {
    expect((await templates()).length).toBe(4);
    expect(await refusal(templates({ organizerId: f.ids.orgA }))).toBe("AN404");
    expect(await refusal(templates({ playerId: await f.newPlayer() }))).toBe("AN404");
    expect(await refusal(templates({}))).toBe("AN404");
  });
});
