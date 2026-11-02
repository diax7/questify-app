import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  TEMPLATE_BODY_MAX_BYTES,
  achievementDocSchema,
  gemShopDocSchema,
  levelTitlesDocSchema,
  templateDocSchema,
} from "@questify/shared";
import type { RequestContext } from "#src/db/context";
import { pushFixture, type PushFixture } from "#test/support/push";
import { addMember, connectAsOwner, TEST_DATABASE_URL } from "#test/support/test-db";

type Doc = Record<string, unknown>;

/** A call's SQLSTATE and detail ("CA400:name.ar"), or "none". */
const refusal = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "none",
    (error: { code?: string; detail?: string }) =>
      error.detail === undefined || error.detail === ""
        ? `${error.code}`
        : `${error.code}:${error.detail}`,
  );

const levelTitle = (levelFrom: number, ar = "لقب", en = "Title") => ({
  levelFrom,
  name: { ar, en },
});

/** A table's own bound (a CHECK) refused the value. */
const checkViolation = async (work: Promise<unknown>): Promise<boolean> =>
  (await refusal(work)).startsWith("23514");

/**
 * The console's catalog editors in the database (T-709b, migration 0119): event templates, achievement names, level titles
 * and the gem shop. Every door is for an active platform admin only (QE403), changes only the row it names, checks the text
 * it is given, writes one audit entry holding the fields before and after, and writes nothing when nothing changed. A
 * revert names the audit entry it undoes and is refused (CA409) when another change landed after that entry.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("console catalog editors (database)", () => {
  let f: PushFixture;
  let adminId = "";
  let admin: RequestContext = {};
  let otherAdmin: RequestContext = {};

  beforeAll(async () => {
    f = await pushFixture();
    const [row] = await f.owner<{ id: string }>(
      "INSERT INTO staff_user (email, password_hash, platform_role, status) VALUES ('catalog@questify.test', 'h', 'admin', 'active') RETURNING id",
    );
    adminId = row?.id ?? "";
    admin = { isAdmin: true, staffUserId: adminId };
    const [second] = await f.owner<{ id: string }>(
      "INSERT INTO staff_user (email, password_hash, platform_role, status) VALUES ('catalog2@questify.test', 'h', 'admin', 'active') RETURNING id",
    );
    otherAdmin = { isAdmin: true, staffUserId: second?.id ?? "" };
  });
  afterAll(async () => {
    await f.close();
  });

  const one = async <T>(sql: string, values: unknown[] = [], seat = admin): Promise<T> =>
    (await f.run<{ r: T }>(seat, sql, values))[0]?.r as T;
  const titlesNow = () =>
    one<{ titles: { levelFrom: number; name: Doc }[] }>("SELECT admin_level_titles() AS r");
  /** `revertOf` is the id of the audit entry a revert undoes; a save passes none. */
  const saveTitles = (doc: unknown, revertOf: string | null = null) =>
    one<{ titles: { levelFrom: number }[] }>("SELECT admin_level_titles_save($1, $2, $3) AS r", [
      doc,
      revertOf,
      randomUUID(),
    ]);

  const audits = async (action: string, target?: string) =>
    f.owner<{ id: string; actor_id: string; target_id: string; before: Doc | null; after: Doc }>(
      `SELECT id, actor_id, target_id, before, after FROM audit_log
       WHERE action = $1 AND ($2::text IS NULL OR target_id = $2) ORDER BY id`,
      [action, target ?? null],
    );
  const count = async (action: string): Promise<number> => (await audits(action)).length;
  /** The latest catalog entry of a row, the one a revert would undo. */
  const latestEntry = async (targetType: string, target: string): Promise<string> =>
    (
      await f.owner<{ id: string }>(
        `SELECT id FROM audit_log WHERE target_type = $1 AND target_id = $2 AND action LIKE 'catalog.%'
         ORDER BY id DESC LIMIT 1`,
        [targetType, target],
      )
    )[0]?.id ?? "";
  /** Waits until a backend running `fragment` is waiting on a lock. */
  const waitsOnLock = async (fragment: string): Promise<boolean> => {
    for (let tries = 0; tries < 100; tries += 1) {
      const waiting = await f.owner(
        `SELECT 1 FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`,
        [`%${fragment}%`],
      );
      if (waiting.length > 0) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  };

  describe("who may ask", () => {
    it("refuses every seat that is not an active platform admin with QE403, on every door", async () => {
      const editor = await addMember(f.db.owner, f.ids.orgA, "editor");
      const [off] = await f.owner<{ id: string }>(
        "INSERT INTO staff_user (email, password_hash, platform_role, status) VALUES ('off@questify.test', 'h', 'admin', 'disabled') RETURNING id",
      );
      const seats: RequestContext[] = [
        f.team(),
        f.team(editor),
        { playerId: await f.newPlayer() },
        { isAdmin: true },
        { isAdmin: true, staffUserId: editor },
        { isAdmin: true, staffUserId: off?.id ?? "" },
        { staffUserId: adminId },
        {},
      ];
      const doc = JSON.stringify({ any: 1 });
      const request = randomUUID();
      const calls = [
        "SELECT admin_templates()",
        `SELECT admin_template_save('conference', '${doc}', NULL, '${request}')`,
        "SELECT admin_achievements()",
        `SELECT admin_achievement_save('quests-done', '${doc}', NULL, '${request}')`,
        "SELECT admin_level_titles()",
        `SELECT admin_level_titles_save('${doc}', NULL, '${request}')`,
        "SELECT admin_shop_items()",
        `SELECT admin_shop_item_save('shop-map-reader', '${doc}', NULL, '${request}')`,
      ];
      for (const seat of seats) {
        for (const call of calls) {
          expect(await refusal(f.run(seat, call)), `${call} ${JSON.stringify(seat)}`).toBe("QE403");
        }
      }
    });
  });

  describe("event templates", () => {
    type Template = { key: string; position: number; enabled: boolean } & Doc;
    const list = () => one<Template[]>("SELECT admin_templates() AS r");
    const save = (key: string, doc: unknown, revertOf: string | null = null, seat = admin) =>
      one<Template>(
        "SELECT admin_template_save($1, $2, $3, $4) AS r",
        [key, doc, revertOf, randomUUID()],
        seat,
      );
    const docOf = (template: Template): Doc => ({
      name: template["name"],
      description: template["description"],
      body: template["body"],
      enabled: template.enabled,
    });

    it("lists every template in order, the switched-off ones too, each a valid edit document", async () => {
      await f.owner("UPDATE event_template SET enabled = false WHERE key = 'campus'");
      const rows = await list();
      expect(rows.map((row) => row.key)).toEqual(["conference", "festival", "campus", "corporate"]);
      expect(rows.find((row) => row.key === "campus")?.enabled).toBe(false);
      for (const row of rows) {
        expect(templateDocSchema.safeParse(docOf(row)).success, row.key).toBe(true);
      }
      await f.owner("UPDATE event_template SET enabled = true WHERE key = 'campus'");
    });

    it("changes only the named row and audits the fields before and after", async () => {
      const before = await list();
      const festival = before.find((row) => row.key === "festival") as Template;
      const edited = {
        ...docOf(festival),
        name: { ar: "مهرجان جديد", en: "New festival" },
      };
      const saved = await save("festival", edited);
      expect(saved["name"]).toEqual({ ar: "مهرجان جديد", en: "New festival" });
      const after = await list();
      for (const row of after.filter((candidate) => candidate.key !== "festival")) {
        expect(row).toEqual(before.find((old) => old.key === row.key));
      }
      const [entry] = await audits("catalog.template.update", "festival");
      expect(entry?.actor_id).toBe(adminId);
      expect(entry?.before?.["name"]).toEqual(festival["name"]);
      expect(entry?.after["name"]).toEqual({ ar: "مهرجان جديد", en: "New festival" });
      expect(templateDocSchema.safeParse(entry?.before).success).toBe(true);
    });

    it("keeps what an event that started earlier got, and gives the next event the edited template", async () => {
      const conference = (await list()).find((row) => row.key === "conference") as Template;
      const [early] = await f.owner<{ id: string }>(
        `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
         VALUES ($1, 'CAT1', 'Early', 'draft', now() + interval '30 days', now() + interval '31 days') RETURNING id`,
        [f.ids.orgA],
      );
      await f.run(f.team(), "SELECT event_apply_template($1, 'conference', $2)", [
        early?.id,
        randomUUID(),
      ]);
      const categoriesOf = async (event: string) =>
        (
          await f.owner<{ n: number }>(
            "SELECT count(*)::int AS n FROM category WHERE event_id = $1",
            [event],
          )
        )[0]?.n;
      const startedWith = await categoriesOf(early?.id ?? "");
      const body = conference["body"] as { categories: unknown[] };
      await save("conference", {
        ...docOf(conference),
        body: { ...body, categories: body.categories.slice(0, 1) },
      });
      expect(await categoriesOf(early?.id ?? "")).toBe(startedWith);
      const [late] = await f.owner<{ id: string }>(
        `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
         VALUES ($1, 'CAT2', 'Late', 'draft', now() + interval '30 days', now() + interval '31 days') RETURNING id`,
        [f.ids.orgA],
      );
      await f.run(f.team(), "SELECT event_apply_template($1, 'conference', $2)", [
        late?.id,
        randomUUID(),
      ]);
      expect(await categoriesOf(late?.id ?? "")).toBe(1);
    });

    it("writes nothing when nothing changed", async () => {
      const corporate = (await list()).find((row) => row.key === "corporate") as Template;
      const before = await count("catalog.template.update");
      await save("corporate", docOf(corporate));
      expect(await count("catalog.template.update")).toBe(before);
    });

    it("makes a new template last in order, and a revert of an unknown key is CA404", async () => {
      const corporate = (await list()).find((row) => row.key === "corporate") as Template;
      const last = Math.max(...(await list()).map((row) => row.position));
      const made = await save("summit", { ...docOf(corporate), name: { ar: "قمة", en: "Summit" } });
      expect(made.position).toBe(last + 1);
      const [entry] = await audits("catalog.template.update", "summit");
      expect(entry?.before).toBeNull();
      expect(await refusal(save("nothing", docOf(corporate), "1"))).toBe("CA404");
    });

    it("refuses control and direction characters, a blank or long name, a bad body and a huge body", async () => {
      const corporate = (await list()).find((row) => row.key === "corporate") as Template;
      const base = docOf(corporate);
      const named = (ar: string, en: string) => ({ ...base, name: { ar, en } });
      for (const [ar, en, detail] of [
        ["اسم" + String.fromCharCode(1), "Name", "name.ar"],
        ["اسم", "Na" + String.fromCharCode(0x202e) + "me", "name.en"],
        ["اسم", "Name" + String.fromCharCode(0x2066), "name.en"],
        ["   ", "Name", "name.ar"],
        ["ا".repeat(121), "Name", "name.ar"],
      ] as const) {
        expect(await refusal(save("corporate", named(ar, en))), `${ar} ${en}`).toBe(
          `CA400:${detail}`,
        );
      }
      expect(await checkViolation(save("corporate", { ...base, body: { config: {} } }))).toBe(true);
      const huge = { ...(base["body"] as Doc), padding: "x".repeat(70_000) };
      expect(await refusal(save("corporate", { ...base, body: huge }))).toBe("CA400:body");
    });

    it("saves and audits a body of the largest size the API accepts, twice over in the audit entry", async () => {
      const campus = (await list()).find((row) => row.key === "campus") as Template;
      const base = docOf(campus);
      const room = TEMPLATE_BODY_MAX_BYTES - JSON.stringify(base["body"]).length - 20;
      const large = { ...(base["body"] as Doc), padding: "x".repeat(room) };
      expect(JSON.stringify(large).length).toBeLessThanOrEqual(TEMPLATE_BODY_MAX_BYTES);
      await save("campus", { ...base, body: large });
      await save("campus", base);
      const [entry] = await audits("catalog.template.update", "campus");
      expect(entry?.after["body"]).toEqual(large);
      const [back] = (await audits("catalog.template.update", "campus")).slice(-1);
      expect(back?.before?.["body"]).toEqual(large);
    });

    it("refuses the second of two saves that make the same new key at once, with CA409", async () => {
      const corporate = (await list()).find((row) => row.key === "corporate") as Template;
      const twin = { ...docOf(corporate), name: { ar: "توأم", en: "Twin" } };
      const holder = await connectAsOwner(f.db);
      try {
        await holder.query("BEGIN");
        await holder.query("LOCK TABLE event_template IN SHARE ROW EXCLUSIVE MODE");
        const second = refusal(save("twin", twin));
        expect(await waitsOnLock("admin_template_save")).toBe(true);
        await holder.query(
          `INSERT INTO event_template (key, position, name_ar, name_en, description_ar, description_en, body)
           SELECT 'twin', 99, name_ar, name_en, description_ar, description_en, body
           FROM event_template WHERE key = 'corporate'`,
        );
        await holder.query("COMMIT");
        expect(await second).toBe("CA409");
        expect(await audits("catalog.template.update", "twin")).toHaveLength(0);
      } finally {
        await holder.end();
        await f.owner("DELETE FROM event_template WHERE key = 'twin'");
      }
    });
  });

  describe("achievements", () => {
    type Achievement = { id: string; bronze: number; silver: number; gold: number } & Doc;
    const list = () => one<Achievement[]>("SELECT admin_achievements() AS r");
    const save = (id: string, doc: unknown, revertOf: string | null = null) =>
      one<Achievement>("SELECT admin_achievement_save($1, $2, $3, $4) AS r", [
        id,
        doc,
        revertOf,
        randomUUID(),
      ]);
    const docOf = (row: Achievement): Doc => ({ name: row["name"] });
    const thresholds = (rows: Achievement[]) =>
      rows.map((row) => [row.id, row.bronze, row.silver, row.gold]);

    it("lists the five achievements in order with their thresholds, each name a valid edit document", async () => {
      const rows = await list();
      expect(rows.map((row) => row.id)).toEqual([
        "events-attended",
        "quests-done",
        "cities-played",
        "top-ten",
        "community-goals",
      ]);
      for (const row of rows) {
        expect(row.bronze, row.id).toBeLessThan(row.silver);
        expect(achievementDocSchema.safeParse(docOf(row)).success, row.id).toBe(true);
      }
    });

    it("changes the name of one achievement and audits it; thresholds and earned rows stay", async () => {
      const before = await list();
      const row = before.find((candidate) => candidate.id === "quests-done") as Achievement;
      const player = await f.newPlayer();
      await f.owner("INSERT INTO player_xp (player_id) VALUES ($1) ON CONFLICT DO NOTHING", [
        player,
      ]);
      await f.owner(
        "INSERT INTO achievement_earned (player_id, achievement_id, tier) VALUES ($1, 'quests-done', 'bronze')",
        [player],
      );
      const saved = await save("quests-done", { name: { ar: "صائد المهام", en: "Quest Master" } });
      expect(saved).toMatchObject({
        bronze: row.bronze,
        silver: row.silver,
        gold: row.gold,
        name: { en: "Quest Master" },
      });
      const [entry] = await audits("catalog.achievement.update", "quests-done");
      expect(entry?.actor_id).toBe(adminId);
      expect(entry?.before).toEqual(docOf(row));
      expect(entry?.after).toEqual({ name: { ar: "صائد المهام", en: "Quest Master" } });
      const earned = await f.owner<{ n: number }>(
        "SELECT count(*)::int AS n FROM achievement_earned WHERE achievement_id = 'quests-done'",
      );
      expect(earned[0]?.n).toBe(1);
      expect(thresholds(await list())).toEqual(thresholds(before));
    });

    it("refuses any threshold, changed or not, and keeps the row and the audit log as they were", async () => {
      const before = await list();
      const row = before.find((candidate) => candidate.id === "top-ten") as Achievement;
      const entries = await count("catalog.achievement.update");
      for (const extra of [
        { bronze: row.bronze - 1 === 0 ? 1 : row.bronze - 1 },
        { silver: row.silver + 1 },
        { gold: 1 },
        { bronze: row.bronze, silver: row.silver, gold: row.gold },
        { bronze: 1, silver: 2, gold: 3 },
        { threshold: 5 },
      ]) {
        expect(
          await refusal(save("top-ten", { ...docOf(row), ...extra })),
          JSON.stringify(extra),
        ).toBe("CA400:thresholds");
      }
      expect(await refusal(save("top-ten", { bronze: 1, silver: 2, gold: 3 }))).toBe(
        "CA400:thresholds",
      );
      expect(await list()).toEqual(before);
      expect(await count("catalog.achievement.update")).toBe(entries);
    });

    it("refuses an unknown id, a missing or unsafe name, and a revert of an entry that is not the latest", async () => {
      const row = (await list()).find((candidate) => candidate.id === "top-ten") as Achievement;
      expect(await refusal(save("nothing", docOf(row)))).toBe("CA404");
      expect(await refusal(save("top-ten", { name: { ar: "ا‮ب", en: "Top" } }))).toBe(
        "CA400:name.ar",
      );
      expect(await refusal(save("top-ten", {}))).toBe("CA400:name.ar");
      expect(await refusal(save("top-ten", { name: { ar: "ا", en: "  " } }))).toBe("CA400:name.en");
      expect(await refusal(save("top-ten", docOf(row), "999999999"))).toBe("CA409");
    });

    it("reverts the name through the audit entry, and a revert never carries a threshold", async () => {
      const row = (await list()).find(
        (candidate) => candidate.id === "cities-played",
      ) as Achievement;
      await save("cities-played", { name: { ar: "جوّاب كبير", en: "Big Traveller" } });
      const entry = await latestEntry("achievement", "cities-played");
      const reverted = await save("cities-played", null, entry);
      expect(reverted["name"]).toEqual(row["name"]);
      expect(reverted).toMatchObject({ bronze: row.bronze, silver: row.silver, gold: row.gold });
      expect(await count("catalog.achievement.revert")).toBe(1);
    });

    it("writes nothing when nothing changed", async () => {
      const row = (await list()).find(
        (candidate) => candidate.id === "events-attended",
      ) as Achievement;
      const before = await count("catalog.achievement.update");
      await save("events-attended", docOf(row));
      expect(await count("catalog.achievement.update")).toBe(before);
    });
  });

  describe("level titles", () => {
    it("reads the set in order as a valid edit document", async () => {
      const set = await titlesNow();
      expect(set.titles.map((row) => row.levelFrom)).toEqual([1, 6, 11, 16, 21, 26]);
      expect(levelTitlesDocSchema.safeParse(set).success).toBe(true);
    });

    it("replaces the whole set at once and audits the set before and after", async () => {
      const before = await titlesNow();
      const saved = await saveTitles({
        titles: [levelTitle(1, "مبتدئ", "Rookie"), levelTitle(10, "خبير", "Expert")],
      });
      expect(saved.titles.map((row) => row.levelFrom)).toEqual([1, 10]);
      const [entry] = await audits("catalog.level_titles.update", "all");
      expect(entry?.before).toEqual(before);
      expect(entry?.after).toEqual(await titlesNow());
      await saveTitles(null, entry?.id ?? null);
      expect(await titlesNow()).toEqual(before);
      expect(await count("catalog.level_titles.revert")).toBe(1);
    });

    it("refuses a set without level 1, with a level twice, empty, too long or unsafe, and keeps the old set", async () => {
      const before = await titlesNow();
      for (const [doc, detail] of [
        [{ titles: [levelTitle(2)] }, "titles"],
        [{ titles: [levelTitle(1), levelTitle(1)] }, "titles"],
        [{ titles: [] }, "titles"],
        [{ titles: [{ levelFrom: 1 }] }, "name.ar"],
        [{ titles: [levelTitle(1, "ا".repeat(41))] }, "name.ar"],
        [{ titles: [levelTitle(1, "لقب", "Ti‏tle‮")] }, "name.en"],
        [{ titles: Array.from({ length: 101 }, (_, index) => levelTitle(index + 1)) }, "titles"],
      ] as const) {
        expect(await refusal(saveTitles(doc)), JSON.stringify(doc).slice(0, 60)).toBe(
          `CA400:${detail}`,
        );
      }
      expect(await checkViolation(saveTitles({ titles: [levelTitle(1), levelTitle(101)] }))).toBe(
        true,
      );
      expect(await titlesNow()).toEqual(before);
    });

    it("writes nothing when the set is the same", async () => {
      const before = await count("catalog.level_titles.update");
      await saveTitles(await titlesNow());
      expect(await count("catalog.level_titles.update")).toBe(before);
    });
  });

  describe("gem shop", () => {
    type Item = { itemId: string; price: number; status: string; position: number } & Doc;
    const list = () => one<Item[]>("SELECT admin_shop_items() AS r");
    const save = (id: string, doc: unknown, revertOf: string | null = null, seat = admin) =>
      one<Item>(
        "SELECT admin_shop_item_save($1, $2, $3, $4) AS r",
        [id, doc, revertOf, randomUUID()],
        seat,
      );

    it("lists the twelve shop items in shop order with their names, each a valid edit document", async () => {
      const rows = await list();
      expect(rows).toHaveLength(12);
      expect(rows[0]).toMatchObject({ itemId: "shop-map-reader", kind: "title", price: 40 });
      for (const row of rows) {
        expect(
          gemShopDocSchema.safeParse({
            price: row.price,
            status: row.status,
            position: row.position,
          }).success,
          row.itemId,
        ).toBe(true);
      }
    });

    it("changes price, status and place of one item, audits it, and leaves what players paid", async () => {
      const player = await f.newPlayer();
      await f.owner("INSERT INTO player_xp (player_id) VALUES ($1) ON CONFLICT DO NOTHING", [
        player,
      ]);
      await f.owner("UPDATE player_xp SET gems = 500 WHERE player_id = $1", [player]);
      const bought = await f.run<{ r: unknown }>(
        { playerId: player },
        "SELECT gem_buy('shop-map-reader', 40, $1) AS r",
        [randomUUID()],
      );
      expect(bought).toHaveLength(1);
      const saved = await save("shop-map-reader", { price: 45, status: "retired", position: 3 });
      expect(saved).toMatchObject({ price: 45, status: "retired", position: 3 });
      const [entry] = await audits("catalog.gem_shop.update", "shop-map-reader");
      expect(entry?.before).toEqual({ price: 40, status: "active", position: 1 });
      expect(entry?.after).toEqual({ price: 45, status: "retired", position: 3 });
      const paid = await f.owner<{ price: number }>(
        "SELECT price FROM gem_purchase WHERE item_id = 'shop-map-reader'",
      );
      expect(paid.map((row) => row.price)).toEqual([40]);
      expect((await list()).filter((row) => row.itemId !== "shop-map-reader")).toHaveLength(11);
    });

    it("refuses a price or place out of range, a bad status and an item not in the shop", async () => {
      const dune = (price: number, status: string, position: number) =>
        save("shop-dune-ring", { price, status, position });
      expect(await checkViolation(dune(0, "active", 1))).toBe(true);
      expect(await checkViolation(dune(100_001, "active", 1))).toBe(true);
      expect(await checkViolation(dune(80, "free", 1))).toBe(true);
      expect(await checkViolation(dune(80, "active", 0))).toBe(true);
      expect(await refusal(save("level-4", { price: 80, status: "active", position: 1 }))).toBe(
        "CA404",
      );
    });

    it("writes nothing when nothing changed", async () => {
      const row = (await list()).find(
        (candidate) => candidate.itemId === "shop-pearl-ring",
      ) as Item;
      const before = await count("catalog.gem_shop.update");
      await save("shop-pearl-ring", {
        price: row.price,
        status: row.status,
        position: row.position,
      });
      expect(await count("catalog.gem_shop.update")).toBe(before);
    });
    it("refuses a revert of an entry another admin has since followed with a change, and reverts the latest", async () => {
      const id = "shop-star-navigator";
      const stored = (await list()).find((row) => row.itemId === id) as Item;
      const doc = (price: number) => ({ price, status: stored.status, position: stored.position });
      await save(id, doc(stored.price + 1));
      const first = await latestEntry("gem_shop_item", id);
      await save(id, doc(stored.price + 2), null, otherAdmin);
      const second = await latestEntry("gem_shop_item", id);

      expect(await refusal(save(id, null, first))).toBe("CA409");
      expect((await list()).find((row) => row.itemId === id)?.price).toBe(stored.price + 2);

      const reverted = await save(id, null, second);
      expect(reverted.price).toBe(stored.price + 1);
      const third = await latestEntry("gem_shop_item", id);
      expect(await refusal(save(id, null, second))).toBe("CA409");
      expect((await save(id, null, third)).price).toBe(stored.price + 2);
      const reverts = await audits("catalog.gem_shop.revert", id);
      expect(reverts.map((entry) => entry.actor_id)).toEqual([adminId, adminId]);
    });

    it("refuses a revert that names another row's entry or an entry that does not exist", async () => {
      const entry = await latestEntry("gem_shop_item", "shop-star-navigator");
      expect(await refusal(save("shop-pearl-ring", null, entry))).toBe("CA409");
      expect(await refusal(save("shop-pearl-ring", null, "999999999"))).toBe("CA409");
      expect(await refusal(save("level-4", null, entry))).toBe("CA404");
    });
  });
});
