import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEMPLATE_BODY_MAX_BYTES, levelTitlesDocSchema, templateDocSchema } from "@questify/shared";
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
 * The console's catalog editors in the database (T-709b, migration 0119): event templates and level titles
 * (achievements and the amounts: console-catalog-xp, T-709c). Every door is for an active platform admin only
 * (QE403), changes only the row it names, checks the text it is given, writes one audit entry holding the fields before
 * and after, and writes nothing when nothing changed. A revert names the audit entry it undoes and is refused (CA409)
 * when another change landed after that entry.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("console catalog editors (database)", () => {
  let f: PushFixture;
  let adminId = "";
  let admin: RequestContext = {};

  beforeAll(async () => {
    f = await pushFixture();
    const [row] = await f.owner<{ id: string }>(
      "INSERT INTO staff_user (email, password_hash, platform_role, status) VALUES ('catalog@questify.test', 'h', 'admin', 'active') RETURNING id",
    );
    adminId = row?.id ?? "";
    admin = { isAdmin: true, staffUserId: adminId };
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
        `SELECT admin_achievement_save('quests-done', '${doc}', NULL, false, '${request}')`,
        "SELECT admin_level_titles()",
        `SELECT admin_level_titles_save('${doc}', NULL, '${request}')`,
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
      for (const mark of [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x061c, 0xfeff]) {
        const en = "Na" + String.fromCharCode(mark) + "me";
        expect(await refusal(save("corporate", named("اسم", en))), mark.toString(16)).toBe(
          "CA400:name.en",
        );
      }
      for (const blank of ["  ", "　", "   "]) {
        expect(await refusal(save("corporate", named(blank, "Name"))), JSON.stringify(blank)).toBe(
          "CA400:name.ar",
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
});
