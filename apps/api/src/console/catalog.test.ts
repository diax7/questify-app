import {
  achievementDocSchema,
  amountsBeforeSchema,
  amountsDocSchema,
  homeLayoutDocSchema,
  itemDocSchema,
  levelTitlesDocSchema,
  templateDocSchema,
  xpTableDocSchema,
  type CatalogKind,
} from "@questify/shared";
import { describe, expect, it } from "vitest";
import {
  catalogDoor,
  docSchemaOf,
  isConfirmable,
  listCatalog,
  revertCatalog,
  saveCatalog,
} from "#src/console/catalog";
import { createItem, previewXpTable } from "#src/console/xp-table";
import { HttpError } from "#src/http-error";
import { fakePool, pgError, type FakeAnswer } from "#test/support/fake-pool";

const ADMIN = { id: "11111111-1111-4111-8111-111111111111" };
const NAME = { ar: "اسم", en: "Name" };
const AMOUNTS = {
  xp: {
    questXp: 100,
    dailyFinishXp: 20,
    dailyRightXp: 10,
    dailyWordXp: 50,
    bronzeXp: 50,
    silverXp: 150,
    goldXp: 300,
  },
};
const ITEM_ROW = {
  id: "gold-frame",
  kind: "frame",
  name: NAME,
  visualKey: "frame-03",
  source: null,
  locked: { art: null },
};

type Seen = { sql: string; values: readonly unknown[] };
const isAudit = (sql: string) => sql.includes("FROM audit_log");

/** A pool answering the editor's door with `answer` as its `r`, and the audit read with `undoable` as its targets. */
function poolAnswering(answer: unknown, undoable: readonly string[] = [], latest?: FakeAnswer) {
  const seen: Seen[] = [];
  const { pool } = fakePool((sql, values) => {
    seen.push({ sql, values });
    if (sql.includes("ORDER BY id DESC LIMIT 1")) {
      return latest ?? { rows: [] };
    }
    if (isAudit(sql)) {
      return { rows: undoable.map((target_id) => ({ target_id })) };
    }
    return { rows: [{ r: answer }] };
  });
  return { pool, seen };
}

const failure = async (work: Promise<unknown>): Promise<unknown> => {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error("the call did not fail");
};

/** What an `HttpError` answers: its status, code and details. */
const answered = (error: unknown) => {
  expect(error).toBeInstanceOf(HttpError);
  const { status, envelope } = error as HttpError;
  return { status, code: envelope.code, details: envelope.details };
};

const refusing = (error: Error) =>
  catalogDoor(fakePool(() => ({})).pool, ADMIN, async () => {
    throw error;
  });

describe("a catalog door's refusals", () => {
  it("answers a broken CHECK as invalid_catalog", async () => {
    const error = await failure(refusing(pgError({ code: "23514" })));
    expect(answered(error)).toEqual({ status: 422, code: "invalid_catalog", details: {} });
  });

  it("answers an unconfirmed lowering with what each tier pays, or the levels", async () => {
    const detail = '{"bronze":{"xp":50,"itemId":null}}';
    const tiers = await failure(refusing(pgError({ code: "CA428", detail })));
    expect(answered(tiers)).toEqual({
      status: 409,
      code: "confirmation_required",
      details: { tiers: { bronze: { xp: 50, itemId: null } } },
    });
    const table = pgError({ code: "CA428", detail: '{"levels":[2,3]}' });
    expect(answered(await failure(refusing(table))).details).toEqual({ levels: [2, 3] });
  });

  it("fails as a server fault on a lowering without its detail", async () => {
    const error = await failure(refusing(pgError({ code: "CA428" })));
    expect(error).not.toBeInstanceOf(HttpError);
    expect(error).toMatchObject({
      message: "a catalog refusal came without its detail; check migrations 0122, 0124 and 0164",
    });
  });

  it("answers a bare CA409, or one whose detail is not JSON, as stale", async () => {
    for (const fields of [{ code: "CA409" }, { code: "CA409", detail: "stale" }]) {
      const error = await failure(refusing(pgError(fields)));
      expect(answered(error), JSON.stringify(fields)).toMatchObject({ status: 409, code: "stale" });
    }
  });

  it("answers a CA409 with a reason as that reason, with the level only when it names one", async () => {
    const held = pgError({ code: "CA409", detail: '{"reason":"level_held","level":4}' });
    expect(answered(await failure(refusing(held)))).toEqual({
      status: 409,
      code: "level_held",
      details: { level: 4 },
    });
    const given = answered(
      await failure(refusing(pgError({ code: "CA409", detail: '{"reason":"item_given"}' }))),
    );
    expect(given.code).toBe("item_given");
    expect(Object.keys(given.details ?? {})).toEqual([]);
  });

  it("fails as a server fault on a reason no door raises", async () => {
    const error = await failure(refusing(pgError({ code: "CA409", detail: '{"reason":"nope"}' })));
    expect(error).not.toBeInstanceOf(HttpError);
    expect(error).toMatchObject({
      message: "unknown catalog refusal nope; check migrations 0124 and 0164",
    });
  });

  it("lets any other error through as it came, even one with a JSON detail", async () => {
    const other = pgError({ code: "XX000", detail: '{"reason":"level_held"}' });
    expect(await failure(refusing(other))).toBe(other);
  });
});

type Case = Readonly<{
  kind: CatalogKind;
  list: string;
  save: string;
  targetType: string;
  /** The audit target of the row: its id, or the document's name. */
  target: string;
  row: Record<string, unknown>;
  /** The save's values for id `x`, document `doc` and request `req`, confirmed. */
  values: readonly unknown[];
  doc: unknown;
  confirmable: boolean;
}>;

const ID_CASES: readonly Case[] = [
  {
    kind: "template",
    list: "SELECT admin_templates() AS r",
    save: "SELECT admin_template_save($1, $2, $3, $4) AS r",
    targetType: "event_template",
    target: "conference",
    row: {
      key: "conference",
      position: 1,
      name: NAME,
      description: NAME,
      body: {},
      enabled: true,
      updatedAt: "2030-01-01T00:00:00Z",
    },
    values: ["conference", "doc", null, "req"],
    doc: templateDocSchema,
    confirmable: false,
  },
  {
    kind: "achievement",
    list: "SELECT admin_achievements() AS r",
    save: "SELECT admin_achievement_save($1, $2, $3, $4, $5) AS r",
    targetType: "achievement",
    target: "quests-done",
    row: {
      id: "quests-done",
      metric: "quests",
      bronze: 1,
      silver: 2,
      gold: 3,
      name: NAME,
      visualKey: "trophy",
      item: null,
      position: 1,
    },
    values: ["quests-done", "doc", null, true, "req"],
    doc: achievementDocSchema,
    confirmable: true,
  },
  {
    kind: "item",
    list: "SELECT admin_items() AS r",
    save: "SELECT admin_item_save($1, $2, $3, $4) AS r",
    targetType: "item",
    target: "gold-frame",
    row: ITEM_ROW,
    values: ["gold-frame", "doc", null, "req"],
    doc: itemDocSchema,
    confirmable: false,
  },
];

const DOCUMENT_CASES: readonly Case[] = [
  {
    kind: "level_titles",
    list: "SELECT admin_level_titles() AS r",
    save: "SELECT admin_level_titles_save($1, $2, $3) AS r",
    targetType: "level_title",
    target: "all",
    row: { titles: [] },
    values: ["doc", null, "req"],
    doc: levelTitlesDocSchema,
    confirmable: false,
  },
  {
    kind: "amounts",
    list: "SELECT admin_amounts() AS r",
    save: "SELECT admin_amounts_save($1, $2, $3) AS r",
    targetType: "platform_setting",
    target: "amounts",
    row: { ...AMOUNTS, stored: { xp: true } },
    values: ["doc", null, "req"],
    doc: amountsDocSchema,
    confirmable: false,
  },
  {
    kind: "xp_table",
    list: "SELECT admin_xp_table() AS r",
    save: "SELECT admin_xp_table_save($1, $2, $3, $4) AS r",
    targetType: "xp_level",
    target: "all",
    row: { levels: [] },
    values: ["doc", null, true, "req"],
    doc: xpTableDocSchema,
    confirmable: true,
  },
  {
    kind: "home_layout",
    list: "SELECT admin_home_layout() AS r",
    save: "SELECT admin_home_layout_save($1, $2, $3) AS r",
    targetType: "platform_setting",
    target: "questify_home",
    row: { order: [], hidden: [], banner: [] },
    values: ["doc", null, "req"],
    doc: homeLayoutDocSchema,
    confirmable: false,
  },
];

describe.each([...ID_CASES, ...DOCUMENT_CASES])("the $kind editor", (editor) => {
  const isDocument = DOCUMENT_CASES.includes(editor);

  it("checks with its own schema and says whether a save needs a confirmation", () => {
    expect(docSchemaOf(editor.kind)).toBe(editor.doc);
    expect(isConfirmable(editor.kind)).toBe(editor.confirmable);
  });

  it("lists through its door, marking what its latest audit entry can revert", async () => {
    const answer = isDocument ? editor.row : [editor.row];
    const { pool, seen } = poolAnswering(answer, [editor.target]);
    const rows = await listCatalog(pool, ADMIN, editor.kind);
    expect(rows).toEqual([{ ...editor.row, revertible: true }]);
    expect(seen[0]).toEqual({ sql: editor.list, values: [] });
    expect(seen[1]?.values).toEqual([editor.targetType]);
  });

  it("saves through its door with the confirmation only where it pays XP or items", async () => {
    const { pool, seen } = poolAnswering(editor.row, [editor.target]);
    const id = isDocument ? "all" : editor.target;
    const saved = await saveCatalog(pool, ADMIN, editor.kind, {
      id,
      input: "doc",
      requestId: "req",
      confirmed: true,
    });
    expect(saved).toEqual({ ...editor.row, revertible: true });
    expect(seen[0]).toEqual({ sql: editor.save, values: editor.values });
  });
});

describe.each(ID_CASES)("the $kind list", (editor) => {
  it("marks each row by its own id", async () => {
    const idField = Object.keys(editor.row)[0] ?? "";
    const other = { ...editor.row, [idField]: "otherone" };
    const { pool } = poolAnswering([editor.row, other], ["otherone"]);
    const rows = await listCatalog(pool, ADMIN, editor.kind);
    expect(rows).toEqual([
      { ...editor.row, revertible: false },
      { ...other, revertible: true },
    ]);
  });
});

/** The latest catalog entry of a row, id 41, holding `before`. */
const latest = (before: unknown): FakeAnswer => ({ rows: [{ id: "41", before }] });

describe("a revert", () => {
  it("answers nothing_to_revert with no entry or an entry with nothing before", async () => {
    for (const entry of [{ rows: [] }, latest(null)]) {
      const { pool, seen } = poolAnswering({}, [], entry);
      const error = await failure(
        revertCatalog(pool, ADMIN, "amounts", { id: "all", requestId: "req" }),
      );
      expect(answered(error).code).toBe("nothing_to_revert");
      expect(seen.map((query) => query.sql)).toHaveLength(1);
      expect(seen[0]?.values).toEqual(["platform_setting", "amounts"]);
    }
  });

  it("refuses an entry whose before fails the schema, with its issues, and saves nothing", async () => {
    const { pool, seen } = poolAnswering({}, [], latest({ xp: {} }));
    const error = await failure(
      revertCatalog(pool, ADMIN, "amounts", { id: "all", requestId: "req" }),
    );
    const { status, code, details } = answered(error);
    expect({ status, code }).toEqual({ status: 422, code: "invalid_catalog" });
    const issues = amountsBeforeSchema.safeParse({ xp: {} }).error?.issues ?? [];
    expect(details).toEqual({ issues: issues.map((issue) => issue.message) });
    expect(seen).toHaveLength(1);
  });

  it("puts the entry back through the save door, by its id", async () => {
    const { pool, seen } = poolAnswering({ ...AMOUNTS, stored: { xp: true } }, [], latest(AMOUNTS));
    await revertCatalog(pool, ADMIN, "amounts", { id: "all", requestId: "req" });
    expect(seen[1]).toEqual({
      sql: "SELECT admin_amounts_save($1, $2, $3) AS r",
      values: [null, "41", "req"],
    });
  });
});

describe("the XP table's extras", () => {
  it("previews what the door answers", async () => {
    const preview = { up: 1, down: 0, levels: 2 };
    const { pool, seen } = poolAnswering(preview);
    await expect(previewXpTable(pool, ADMIN, { levels: [] })).resolves.toEqual(preview);
    expect(seen[0]).toEqual({
      sql: "SELECT admin_xp_table_preview($1) AS r",
      values: [{ levels: [] }],
    });
  });

  it("makes an item with nothing to revert to", async () => {
    const { pool, seen } = poolAnswering(ITEM_ROW);
    await expect(createItem(pool, ADMIN, { doc: "doc", requestId: "req" })).resolves.toEqual({
      ...ITEM_ROW,
      revertible: false,
    });
    expect(seen[0]).toEqual({
      sql: "SELECT admin_item_create($1, $2) AS r",
      values: ["doc", "req"],
    });
  });
});

const listed = async (before: unknown) => {
  const { pool } = fakePool((sql) =>
    isAudit(sql)
      ? { rows: [{ target_id: "amounts", before }] }
      : { rows: [{ r: { ...AMOUNTS, stored: { xp: true } } }] },
  );
  return listCatalog(pool, ADMIN, "amounts");
};

describe("the amounts a revert would put back", () => {
  it("are the latest entry's before, with the tier amounts an older entry lacks as they stand", async () => {
    const { questXp, dailyFinishXp, dailyRightXp, dailyWordXp } = AMOUNTS.xp;
    const older = { questXp: 80, dailyFinishXp, dailyRightXp, dailyWordXp };
    const [row] = await listed({ xp: older, gems: { gold: 3 } });
    expect(row).toMatchObject({
      revertible: true,
      previous: { xp: { ...AMOUNTS.xp, questXp: 80 } },
    });
    expect(questXp).toBe(100);
  });

  it("are left out when the entry does not read", async () => {
    const [row] = await listed({ xp: { questXp: "many" } });
    expect(row).toMatchObject({ revertible: true });
    expect(row).not.toHaveProperty("previous");
  });
});
