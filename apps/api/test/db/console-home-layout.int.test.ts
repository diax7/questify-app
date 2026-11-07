import { randomUUID } from "node:crypto";
import {
  QUESTIFY_HOME_BLOCKS,
  QUESTIFY_HOME_KEYS,
  QUESTIFY_HOME_PROTECTED,
  checkQuestifyHome,
  homeLayoutDocSchema,
} from "@questify/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RequestContext } from "#src/db/context";
import { questifyFixture, type QuestifyFixture } from "#test/support/questify";
import { addMember, TEST_DATABASE_URL } from "#test/support/test-db";

type Doc = Record<string, unknown>;
type Layout = { order: string[]; hidden: string[]; banner: Doc[] };

/** A call's SQLSTATE and detail ("CA400:banner.0.title"), or "none". */
const refusal = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "none",
    (error: { code?: string; detail?: string }) =>
      error.detail === undefined || error.detail === ""
        ? `${error.code}`
        : `${error.code}:${error.detail}`,
  );

const slide = (title: string, action: Doc = { type: "none" }): Doc => ({
  title: { ar: "", en: title },
  subtitle: { ar: "", en: "" },
  action,
});
const DEFAULT: Layout = { order: [...QUESTIFY_HOME_KEYS], hidden: [], banner: [] };
const doc = (overrides: Partial<Layout> | Doc = {}): Doc => ({ ...DEFAULT, ...overrides });
const reversed = [...QUESTIFY_HOME_KEYS].toReversed();

/**
 * Questify home's layout in the database (T-713, migration 0137): one platform setting written only by the door of an
 * active platform admin (QE403), checked again here (CA400), audited with the layout before and after, and reverted through
 * the audit log (CA409 when another change landed after the entry).
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("Questify home layout (database)", () => {
  let f: QuestifyFixture;
  let adminId = "";
  let admin: RequestContext = {};

  beforeAll(async () => {
    f = await questifyFixture();
    const [row] = await f.owner<{ id: string }>(
      "INSERT INTO staff_user (email, password_hash, platform_role, status) VALUES ('home@questify.test', 'h', 'admin', 'active') RETURNING id",
    );
    adminId = row?.id ?? "";
    admin = { isAdmin: true, staffUserId: adminId };
  });
  // The audit log is append-only for every role, so each test counts the entries made after the last one that existed.
  let mark = "0";
  beforeEach(async () => {
    mark =
      (await f.owner<{ id: string }>("SELECT coalesce(max(id), 0) AS id FROM audit_log"))[0]?.id ??
      "0";
  });
  afterEach(async () => {
    await f.owner("DELETE FROM platform_setting WHERE key = 'questifyHome'");
  });
  afterAll(async () => {
    await f.close();
  });

  const one = async <T>(sql: string, values: unknown[] = [], seat = admin): Promise<T> =>
    (await f.run<{ r: T }>(seat, sql, values))[0]?.r as T;
  const now = () => one<Layout>("SELECT admin_home_layout() AS r");
  const save = (input: unknown, revertOf: string | null = null, seat = admin) =>
    one<Layout>(
      "SELECT admin_home_layout_save($1, $2, $3) AS r",
      [input === null ? null : JSON.stringify(input), revertOf, randomUUID()],
      seat,
    );
  const audits = (action = "catalog.home_layout.update") =>
    f.owner<{ id: string; actor_id: string; before: Layout | null; after: Layout }>(
      "SELECT id, actor_id, before, after FROM audit_log WHERE action = $1 AND id > $2 ORDER BY id",
      [action, mark],
    );
  const latestEntry = async (): Promise<string> =>
    (
      await f.owner<{ id: string }>(
        `SELECT id FROM audit_log WHERE target_type = 'platform_setting' AND target_id = 'questify_home'
         AND action LIKE 'catalog.%' ORDER BY id DESC LIMIT 1`,
      )
    )[0]?.id ?? "";
  const stored = async (): Promise<Layout[]> =>
    (
      await f.owner<{ value: Layout }>(
        "SELECT value FROM platform_setting WHERE key = 'questifyHome'",
      )
    ).map((row) => row.value);

  /** The door refused with CA400 and the detail, and nothing was stored or audited. */
  const refused = async (input: unknown, detail: string) => {
    expect(await refusal(save(input))).toBe(`CA400:${detail}`);
    expect(await stored()).toEqual([]);
    expect(await audits()).toEqual([]);
  };

  describe("who may ask", () => {
    it("refuses every seat that is not an active platform admin with QE403, on both doors", async () => {
      const editor = await addMember(f.db.owner, f.ids.orgA, "editor");
      const [off] = await f.owner<{ id: string }>(
        "INSERT INTO staff_user (email, password_hash, platform_role, status) VALUES ('home-off@questify.test', 'h', 'admin', 'disabled') RETURNING id",
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
      for (const seat of seats) {
        expect(await refusal(f.run(seat, "SELECT admin_home_layout()")), JSON.stringify(seat)).toBe(
          "QE403",
        );
        expect(
          await refusal(
            f.run(seat, "SELECT admin_home_layout_save($1, NULL, $2)", [
              JSON.stringify(doc()),
              randomUUID(),
            ]),
          ),
          JSON.stringify(seat),
        ).toBe("QE403");
      }
      expect(await stored()).toEqual([]);
    });

    it("cannot be written around the door: the generic settings writer refuses the key", async () => {
      const insert = f.run(
        admin,
        "INSERT INTO platform_setting (key, value) VALUES ('questifyHome', '{}')",
      );
      expect(await refusal(insert)).toBe("42501");
      await save(doc());
      const update = f.run(
        admin,
        `UPDATE platform_setting SET value = '{"order": []}' WHERE key = 'questifyHome' RETURNING key`,
      );
      expect(await update).toEqual([]);
      expect((await stored())[0]).toEqual(DEFAULT);
    });
  });

  describe("the blocks", () => {
    it("names the same blocks, in the same order, with the same protected ones, as the shared package", async () => {
      const [row] = await f.owner<{ blocks: { block: string; protected: boolean }[] }>(
        "SELECT questify_home_blocks() AS blocks",
      );
      expect(row?.blocks).toEqual(
        QUESTIFY_HOME_BLOCKS.map((entry) => ({ block: entry.block, protected: entry.protected })),
      );
    });

    it("hides every block that is not protected and refuses to hide each one that is", async () => {
      for (const key of QUESTIFY_HOME_KEYS) {
        const outcome = await refusal(save(doc({ hidden: [key] })));
        expect(outcome, key).toBe(QUESTIFY_HOME_PROTECTED.has(key) ? "CA400:hidden" : "none");
      }
    });
  });

  describe("reading the layout in force", () => {
    it("is the default while none is stored, and reading writes nothing", async () => {
      expect(await now()).toEqual(DEFAULT);
      expect(await stored()).toEqual([]);
      expect(await audits()).toEqual([]);
    });

    it("makes a stored layout whole: unknown names go, a missing block joins the end, a protected one is shown", async () => {
      await f.owner(
        `INSERT INTO platform_setting (key, value) VALUES ('questifyHome',
         '{"order": ["quests", "ghost", "quests", "events"], "hidden": ["events", "streak", "ghost"], "banner": "x"}')`,
      );
      const read = await now();
      expect(read.order.slice(0, 2)).toEqual(["quests", "events"]);
      expect([...read.order].toSorted()).toEqual([...QUESTIFY_HOME_KEYS].toSorted());
      expect(read.hidden).toEqual(["streak"]);
      expect(read.banner).toEqual([]);
    });
  });

  describe("a save", () => {
    it("stores the layout, answers it, and audits the layout before and after in the admin's name", async () => {
      const input = doc({
        order: reversed,
        hidden: ["quests", "streak"],
        banner: [
          slide("Welcome"),
          slide("Visit", { type: "link", url: "https://questify.example/x" }),
        ],
      });
      const answer = await save(input);
      expect(answer.order).toEqual(reversed);
      expect(answer.hidden).toEqual(["streak", "quests"]);
      expect(answer.banner).toHaveLength(2);
      expect((await stored())[0]).toEqual(answer);
      expect(homeLayoutDocSchema.safeParse(answer).success).toBe(true);
      const [entry, ...rest] = await audits();
      expect(rest).toEqual([]);
      expect(entry?.actor_id).toBe(adminId);
      expect(entry?.before).toEqual(DEFAULT);
      expect(entry?.after).toEqual(answer);
    });

    it("stores a slide in one shape whatever was left out", async () => {
      const answer = await save(doc({ banner: [{ title: { en: "Hi" } }] }));
      expect(answer.banner).toEqual([
        {
          title: { ar: "", en: "Hi" },
          subtitle: { ar: "", en: "" },
          action: { type: "none" },
        },
      ]);
    });

    it("writes nothing when nothing changed, however the hidden list was written", async () => {
      await save(doc({ hidden: ["quests", "streak"] }));
      const [row] = await f.owner<{ updated_at: Date }>(
        "SELECT updated_at FROM platform_setting WHERE key = 'questifyHome'",
      );
      await save(doc({ hidden: ["streak", "quests"] }));
      expect(await audits()).toHaveLength(1);
      const [after] = await f.owner<{ updated_at: Date }>(
        "SELECT updated_at FROM platform_setting WHERE key = 'questifyHome'",
      );
      expect(after?.updated_at).toEqual(row?.updated_at);
    });

    it("stores the default as it is when the first save changes nothing, with no audit entry", async () => {
      expect(await save(doc())).toEqual(DEFAULT);
      expect(await stored()).toEqual([DEFAULT]);
      expect(await audits()).toEqual([]);
    });

    it("accepts what the shared check accepts and refuses what it refuses", async () => {
      const cases: Doc[] = [
        doc(),
        doc({ order: reversed }),
        doc({ hidden: ["events"] }),
        doc({ banner: Array.from({ length: 6 }, () => slide("S")) }),
        doc({ banner: [slide("A", { type: "agenda" })] }),
        doc({ banner: [slide("")] }),
        doc({ banner: [slide("A", { type: "link", url: "http://questify.example" })] }),
        doc({ banner: [slide("A", { type: "link", url: "https://questify.example:65535/x" })] }),
        doc({ banner: [slide("A", { type: "link", url: "https://questify.example:65536/x" })] }),
        doc({ banner: [slide("A", { type: "link", url: "https://questify.example:0" })] }),
        doc({ order: QUESTIFY_HOME_KEYS.slice(1) }),
      ];
      for (const input of cases) {
        const expected = checkQuestifyHome(input).ok;
        const outcome = await refusal(save(input));
        expect(outcome === "none", JSON.stringify(input).slice(0, 80)).toBe(expected);
      }
    });
  });

  describe("what the door refuses", () => {
    it("a document that is not Questify home's layout", async () => {
      await refused("x", "layout");
      await refused(null, "layout");
      await refused([], "layout");
      await refused({ order: DEFAULT.order, hidden: [] }, "layout");
      await refused({ ...doc(), extra: 1 }, "layout");
      await refused(doc({ banner: {} }), "layout");
    });

    it("an order that leaves a block out, lists one twice or names one that does not exist", async () => {
      await refused(doc({ order: QUESTIFY_HOME_KEYS.slice(1) }), "order");
      await refused(doc({ order: [...QUESTIFY_HOME_KEYS.slice(1), "events"] }), "order");
      await refused(doc({ order: [...QUESTIFY_HOME_KEYS.slice(1), "ghost"] }), "order");
      await refused(doc({ order: [...QUESTIFY_HOME_KEYS.slice(1), 7] }), "order");
    });

    it("a hidden list that names a protected block, an unknown one, or one twice", async () => {
      await refused(doc({ hidden: ["notices"] }), "hidden");
      await refused(doc({ hidden: ["ghost"] }), "hidden");
      await refused(doc({ hidden: ["streak", "streak"] }), "hidden");
      await refused(doc({ hidden: [5] }), "hidden");
    });

    it("more than five slides, a slide with no title and text over its limit", async () => {
      await refused(doc({ banner: Array.from({ length: 6 }, () => slide("S")) }), "banner");
      await refused(doc({ banner: [slide("A"), { subtitle: { en: "x" } }] }), "banner.1.title");
      await refused(doc({ banner: [slide("x".repeat(61))] }), "banner.0.title");
      await refused(
        doc({ banner: [{ ...slide("A"), subtitle: { ar: "", en: "x".repeat(101) } }] }),
        "banner.0.subtitle",
      );
      await refused(doc({ banner: [{ ...slide("A"), image: "x" }] }), "banner.0");
      await refused(
        doc({ banner: [{ ...slide("A"), title: { ar: "a", en: "b", fr: "c" } }] }),
        "banner.0.title",
      );
      await refused(
        doc({ banner: [{ ...slide("A"), title: { ar: 1, en: "b" } }] }),
        "banner.0.title",
      );
    });

    it("control and direction characters in a slide's text", async () => {
      for (const bad of ["a\u0007b", "a‮b", "a b", "a\u0085b", "a⁦b"]) {
        await refused(doc({ banner: [slide(bad)] }), "banner.0.title");
      }
    });

    it("zero-width and mark characters in a slide's text (migration 0161)", async () => {
      for (const bad of ["a​b", "a‌b", "a‍b", "a‎b", "a‏b", "a؜b", "a﻿b"]) {
        await refused(doc({ banner: [slide(bad)] }), "banner.0.title");
        await refused(
          doc({ banner: [{ ...slide("A"), subtitle: { ar: "", en: bad } }] }),
          "banner.0.subtitle",
        );
      }
    });

    it("a title of whitespace alone, and stores a subtitle of whitespace as empty (migration 0161)", async () => {
      for (const blank of ["   ", " ", "　  "]) {
        await refused(doc({ banner: [slide(blank)] }), "banner.0.title");
      }
      const answer = await save(
        doc({ banner: [{ ...slide("A"), subtitle: { ar: " ", en: "　" } }] }),
      );
      expect(answer.banner[0]?.["subtitle"]).toEqual({ ar: "", en: "" });
      expect(answer.banner[0]?.["title"]).toEqual({ ar: "", en: "A" });
    });

    it("a tap that opens an event's screen, and a link that is not an https address to a named host", async () => {
      await refused(doc({ banner: [slide("A", { type: "agenda" })] }), "banner.0.action");
      await refused(
        doc({ banner: [slide("A", { type: "none", url: "https://q.example" })] }),
        "banner.0.action",
      );
      await refused(doc({ banner: [slide("A", { type: "link" })] }), "banner.0.action");
      await refused(doc({ banner: [slide("A", { type: "link", url: 5 })] }), "banner.0.action");
      for (const url of [
        "http://questify.example",
        "https://127.0.0.1/x",
        "https://localhost/x",
        "https://questify.example:65536/x",
        "https://questify.example:99999",
        "https://questify.example:0/x",
        "javascript:alert(1)",
        "https://questify.example/a b",
        "https://questify.example/a\u0001b",
        `https://questify.example/${"a".repeat(300)}`,
        "",
      ]) {
        await refused(doc({ banner: [slide("A", { type: "link", url })] }), "banner.0.url");
      }
    });
  });

  describe("a revert", () => {
    it("puts back the layout before the latest change, audits it as a revert, and a second revert undoes the first", async () => {
      const first = doc({ order: reversed, banner: [slide("One")] });
      await save(first);
      const changed = await save(doc({ hidden: ["quests"], banner: [slide("Two")] }));
      const reverted = await save(null, await latestEntry());
      expect(reverted.hidden).toEqual([]);
      expect(reverted.banner).toHaveLength(1);
      expect(reverted.banner[0]?.["title"]).toEqual({ ar: "", en: "One" });
      expect((await audits("catalog.home_layout.revert"))[0]?.before).toEqual(changed);
      const again = await save(null, await latestEntry());
      expect(again).toEqual(changed);
    });

    it("can go back to the layout the screen always had", async () => {
      await save(doc({ order: reversed, hidden: ["quests"] }));
      expect(await save(null, await latestEntry())).toEqual(DEFAULT);
    });

    it("is refused with CA409 when another change landed after the entry, or the entry does not exist", async () => {
      await save(doc({ hidden: ["quests"] }));
      const old = await latestEntry();
      await save(doc({ hidden: ["streak"] }));
      expect(await refusal(save(null, old))).toBe("CA409");
      expect(await refusal(save(null, "999999999"))).toBe("CA409");
      expect((await now()).hidden).toEqual(["streak"]);
    });

    it("makes the earlier layout whole when a block was added after it", async () => {
      await save(doc({ hidden: ["quests"] }));
      const [entry] = await f.owner<{ id: string }>(
        `INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, before, after)
         VALUES ('admin', $1, 'catalog.home_layout.update', 'platform_setting', 'questify_home',
                 '{"order": ["quests", "events"], "hidden": [], "banner": []}', '{}') RETURNING id`,
        [adminId],
      );
      const reverted = await save(null, entry?.id ?? null);
      expect(reverted.order.slice(0, 2)).toEqual(["quests", "events"]);
      expect(reverted.order).toHaveLength(QUESTIFY_HOME_KEYS.length);
    });
  });

  describe("two saves at once", () => {
    it("queue on the row: both are audited in turn and the second one's before is the first one's after", async () => {
      const a = doc({ hidden: ["quests"] });
      const b = doc({ hidden: ["streak"], banner: [slide("B")] });
      await Promise.all([save(a), save(b)]);
      const entries = await audits();
      expect(entries).toHaveLength(2);
      expect(entries[1]?.before).toEqual(entries[0]?.after);
      expect(await now()).toEqual(entries[1]?.after);
    });
  });
});
