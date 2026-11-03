import { randomUUID } from "node:crypto";
import {
  PLAYER_INTRO_KEYS,
  checkPlayerIntro,
  playerIntroDocSchema,
  readPlayerIntro,
} from "@questify/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RequestContext } from "#src/db/context";
import { questifyFixture, type QuestifyFixture } from "#test/support/questify";
import { addMember, TEST_DATABASE_URL } from "#test/support/test-db";

type Doc = Record<string, unknown>;
type Layout = { order: string[]; hidden: string[] };

/** A call's SQLSTATE and detail ("CA400:hidden"), or "none". */
const refusal = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "none",
    (error: { code?: string; detail?: string }) =>
      error.detail === undefined || error.detail === ""
        ? `${error.code}`
        : `${error.code}:${error.detail}`,
  );

const DEFAULT: Layout = { order: [...PLAYER_INTRO_KEYS], hidden: [] };
const doc = (overrides: Partial<Layout> | Doc = {}): Doc => ({ ...DEFAULT, ...overrides });
const reversed = [...PLAYER_INTRO_KEYS].toReversed();

/**
 * The player intro's cards in the database (T-802b, migration 0145): one platform setting written only by the door of an
 * active platform admin (QE403), checked again here (CA400), audited with the layout before and after, and reverted through
 * the audit log (CA409 when another change landed after the entry).
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("player intro cards (database)", () => {
  let f: QuestifyFixture;
  let adminId = "";
  let admin: RequestContext = {};

  beforeAll(async () => {
    f = await questifyFixture();
    const [row] = await f.owner<{ id: string }>(
      "INSERT INTO staff_user (email, password_hash, platform_role, status) VALUES ('intro@questify.test', 'h', 'admin', 'active') RETURNING id",
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
    await f.owner("DELETE FROM platform_setting WHERE key = 'playerIntro'");
  });
  afterAll(async () => {
    await f.close();
  });

  const one = async <T>(sql: string, values: unknown[] = [], seat = admin): Promise<T> =>
    (await f.run<{ r: T }>(seat, sql, values))[0]?.r as T;
  const now = () => one<Layout>("SELECT admin_player_intro() AS r");
  const save = (input: unknown, revertOf: string | null = null, seat = admin) =>
    one<Layout>(
      "SELECT admin_player_intro_save($1, $2, $3) AS r",
      [input === null ? null : JSON.stringify(input), revertOf, randomUUID()],
      seat,
    );
  const audits = (action = "catalog.player_intro.update") =>
    f.owner<{ id: string; actor_id: string; before: Layout | null; after: Layout }>(
      "SELECT id, actor_id, before, after FROM audit_log WHERE action = $1 AND id > $2 ORDER BY id",
      [action, mark],
    );
  const latestEntry = async (): Promise<string> =>
    (
      await f.owner<{ id: string }>(
        `SELECT id FROM audit_log WHERE target_type = 'platform_setting' AND target_id = 'player_intro'
         AND action LIKE 'catalog.%' ORDER BY id DESC LIMIT 1`,
      )
    )[0]?.id ?? "";
  const stored = async (): Promise<Layout[]> =>
    (
      await f.owner<{ value: Layout }>(
        "SELECT value FROM platform_setting WHERE key = 'playerIntro'",
      )
    ).map((row) => row.value);

  /** The door refused with CA400 and the detail, and nothing was stored or audited. */
  const refused = async (input: unknown, detail: string) => {
    expect(await refusal(save(input)), JSON.stringify(input)).toBe(`CA400:${detail}`);
    expect(await stored()).toEqual([]);
    expect(await audits()).toEqual([]);
  };

  describe("who may ask", () => {
    it("refuses every seat that is not an active platform admin with QE403, on both doors", async () => {
      const editor = await addMember(f.db.owner, f.ids.orgA, "editor");
      const [off] = await f.owner<{ id: string }>(
        "INSERT INTO staff_user (email, password_hash, platform_role, status) VALUES ('intro-off@questify.test', 'h', 'admin', 'disabled') RETURNING id",
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
        expect(
          await refusal(f.run(seat, "SELECT admin_player_intro()")),
          JSON.stringify(seat),
        ).toBe("QE403");
        expect(
          await refusal(
            f.run(seat, "SELECT admin_player_intro_save($1, NULL, $2)", [
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
        "INSERT INTO platform_setting (key, value) VALUES ('playerIntro', '{}')",
      );
      expect(await refusal(insert)).toBe("42501");
      await save(doc({ hidden: ["prizes"] }));
      const update = f.run(
        admin,
        `UPDATE platform_setting SET value = '{"order": []}' WHERE key = 'playerIntro' RETURNING key`,
      );
      expect(await update).toEqual([]);
      expect((await stored())[0]).toEqual({ order: DEFAULT.order, hidden: ["prizes"] });
    });
  });

  describe("the cards", () => {
    it("names the same cards, in the same order, as the shared package", async () => {
      const [row] = await f.owner<{ cards: string[] }>("SELECT player_intro_cards() AS cards");
      expect(row?.cards).toEqual([...PLAYER_INTRO_KEYS]);
    });

    it("hides any one card", async () => {
      for (const key of PLAYER_INTRO_KEYS) {
        expect(await refusal(save(doc({ hidden: [key] }))), key).toBe("none");
      }
    });

    it("refuses to hide all of them", async () => {
      await refused(doc({ hidden: [...PLAYER_INTRO_KEYS] }), "hidden");
    });

    it("allows three hidden, so one card plays", async () => {
      const answer = await save(doc({ hidden: ["join", "quests", "points"] }));
      expect(answer.hidden).toEqual(["join", "quests", "points"]);
    });
  });

  describe("reading the layout in force", () => {
    it("is the default while none is stored, and reading writes nothing", async () => {
      expect(await now()).toEqual(DEFAULT);
      expect(await stored()).toEqual([]);
      expect(await audits()).toEqual([]);
    });

    it("makes a stored layout whole: unknown names go, a missing card joins the end, a hidden card keeps its place", async () => {
      await f.owner(
        `INSERT INTO platform_setting (key, value) VALUES ('playerIntro',
         '{"order": ["prizes", "ghost", "prizes", "join"], "hidden": ["join", "ghost", "join"]}')`,
      );
      expect(await now()).toEqual({
        order: ["prizes", "join", "quests", "points"],
        hidden: ["join"],
      });
    });

    it("shows every card when the stored layout hides them all or is not a layout", async () => {
      await f.owner(
        `INSERT INTO platform_setting (key, value) VALUES ('playerIntro',
         '{"order": ["points"], "hidden": ["join", "quests", "points", "prizes"]}')`,
      );
      expect(await now()).toEqual({ order: ["points", "join", "quests", "prizes"], hidden: [] });
      await f.owner(
        `UPDATE platform_setting SET value = '{"order": "x", "hidden": 5}' WHERE key = 'playerIntro'`,
      );
      expect(await now()).toEqual(DEFAULT);
    });

    it("reads the same layout as the shared reader", async () => {
      const written = { order: ["prizes", "points"], hidden: ["points", "nothing"] };
      await f.owner("INSERT INTO platform_setting (key, value) VALUES ('playerIntro', $1)", [
        JSON.stringify(written),
      ]);
      expect(await now()).toEqual(readPlayerIntro(written));
    });
  });

  describe("a save", () => {
    it("stores the layout, answers it, and audits the layout before and after in the admin's name", async () => {
      const answer = await save(doc({ order: reversed, hidden: ["quests", "join"] }));
      expect(answer.order).toEqual(reversed);
      expect(answer.hidden).toEqual(["join", "quests"]);
      expect((await stored())[0]).toEqual(answer);
      expect(playerIntroDocSchema.safeParse(answer).success).toBe(true);
      const [entry, ...rest] = await audits();
      expect(rest).toEqual([]);
      expect(entry?.actor_id).toBe(adminId);
      expect(entry?.before).toEqual(DEFAULT);
      expect(entry?.after).toEqual(answer);
    });

    it("writes nothing when nothing changed, however the hidden list was written", async () => {
      await save(doc({ hidden: ["quests", "join"] }));
      const [row] = await f.owner<{ updated_at: Date }>(
        "SELECT updated_at FROM platform_setting WHERE key = 'playerIntro'",
      );
      await save(doc({ hidden: ["join", "quests"] }));
      expect(await audits()).toHaveLength(1);
      const [after] = await f.owner<{ updated_at: Date }>(
        "SELECT updated_at FROM platform_setting WHERE key = 'playerIntro'",
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
        doc({ hidden: ["prizes"] }),
        doc({ hidden: [...PLAYER_INTRO_KEYS] }),
        doc({ hidden: ["join", "join"] }),
        doc({ hidden: ["ghost"] }),
        doc({ order: PLAYER_INTRO_KEYS.slice(1) }),
        doc({ order: [...PLAYER_INTRO_KEYS, "join"] }),
        { order: DEFAULT.order },
        { ...doc(), extra: 1 },
      ];
      for (const input of cases) {
        const expected = checkPlayerIntro(input).ok;
        const outcome = await refusal(save(input));
        expect(outcome === "none", JSON.stringify(input)).toBe(expected);
      }
    });
  });

  describe("what the door refuses", () => {
    it("a document that is not the intro's layout", async () => {
      await refused("x", "layout");
      await refused(null, "layout");
      await refused([], "layout");
      await refused({ order: DEFAULT.order }, "layout");
      await refused({ ...doc(), extra: 1 }, "layout");
      await refused(doc({ hidden: {} }), "layout");
    });

    it("an order that leaves a card out, lists one twice or names one that does not exist", async () => {
      await refused(doc({ order: PLAYER_INTRO_KEYS.slice(1) }), "order");
      await refused(doc({ order: [...PLAYER_INTRO_KEYS.slice(1), "quests"] }), "order");
      await refused(doc({ order: [...PLAYER_INTRO_KEYS.slice(1), "ghost"] }), "order");
      await refused(doc({ order: [...PLAYER_INTRO_KEYS.slice(1), 7] }), "order");
    });

    it("a hidden list that names an unknown card, one twice, or every card", async () => {
      await refused(doc({ hidden: ["ghost"] }), "hidden");
      await refused(doc({ hidden: ["quests", "quests"] }), "hidden");
      await refused(doc({ hidden: [5] }), "hidden");
      await refused(doc({ hidden: [...PLAYER_INTRO_KEYS] }), "hidden");
    });
  });

  describe("a revert", () => {
    it("puts back the layout before the latest change, audits it as a revert, and a second revert undoes the first", async () => {
      await save(doc({ order: reversed }));
      const changed = await save(doc({ order: reversed, hidden: ["quests"] }));
      const reverted = await save(null, await latestEntry());
      expect(reverted).toEqual({ order: reversed, hidden: [] });
      expect((await audits("catalog.player_intro.revert"))[0]?.before).toEqual(changed);
      const again = await save(null, await latestEntry());
      expect(again).toEqual(changed);
    });

    it("can go back to the intro the app always had", async () => {
      await save(doc({ order: reversed, hidden: ["quests"] }));
      expect(await save(null, await latestEntry())).toEqual(DEFAULT);
    });

    it("is refused with CA409 when another change landed after the entry, or the entry does not exist", async () => {
      await save(doc({ hidden: ["quests"] }));
      const old = await latestEntry();
      await save(doc({ hidden: ["points"] }));
      expect(await refusal(save(null, old))).toBe("CA409");
      expect(await refusal(save(null, "999999999"))).toBe("CA409");
      expect((await now()).hidden).toEqual(["points"]);
    });

    it("makes the earlier layout whole when a card was added after it", async () => {
      await save(doc({ hidden: ["quests"] }));
      const [entry] = await f.owner<{ id: string }>(
        `INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, before, after)
         VALUES ('admin', $1, 'catalog.player_intro.update', 'platform_setting', 'player_intro',
                 '{"order": ["prizes", "join"], "hidden": []}', '{}') RETURNING id`,
        [adminId],
      );
      const reverted = await save(null, entry?.id ?? null);
      expect(reverted.order).toEqual(["prizes", "join", "quests", "points"]);
    });

    it("never puts back a layout that hides every card", async () => {
      await save(doc({ hidden: ["quests"] }));
      const [entry] = await f.owner<{ id: string }>(
        `INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, before, after)
         VALUES ('admin', $1, 'catalog.player_intro.update', 'platform_setting', 'player_intro',
                 '{"order": ["join", "quests", "points", "prizes"], "hidden": ["join", "quests", "points", "prizes"]}', '{}')
         RETURNING id`,
        [adminId],
      );
      expect((await save(null, entry?.id ?? null)).hidden).toEqual([]);
    });
  });

  describe("two saves at once", () => {
    it("queue on the row: both are audited in turn and the second one's before is the first one's after", async () => {
      await Promise.all([save(doc({ hidden: ["quests"] })), save(doc({ hidden: ["points"] }))]);
      const entries = await audits();
      expect(entries).toHaveLength(2);
      expect(entries[1]?.before).toEqual(entries[0]?.after);
      expect(await now()).toEqual(entries[1]?.after);
    });
  });
});
