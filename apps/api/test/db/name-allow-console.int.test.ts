import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext, type RequestContext } from "#src/db/context";
import { ABUSIVE_NAMES, REAL_NAMES } from "#test/db/full-name-corpus";
import {
  TEST_DATABASE_URL,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

type Row = Record<string, unknown>;
/** The SQLSTATE a door fails with, or "none". */
const code = async (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "none",
    (error: unknown) => String((error as { code?: string }).code),
  );

type Page = { words: { word: string; language: string; addedAt: string }[]; total: number };

/**
 * The full-name allow-list from the console (migration 0185, FR-1779, ADR-817): an active admin reads, adds and removes an
 * allow word; the word is folded as the check reads a name and takes its language from its letters; a list entry and a
 * word that would let an abusive name of the corpus through are refused; every change is audited and marks the sweep.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("full-name allow-list doors (database)", () => {
  let db: TestDatabase;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let admin: RequestContext;
  let counter = 0;

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const as = async <T extends Row>(context: RequestContext, sql: string, values: unknown[] = []) =>
    withRequestContext(db.app, context, async () => (await db.app.query<T>(sql, values)).rows);
  const added = async (word: string, context = admin) =>
    (
      await as<{ r: { outcome: string; word: string } }>(
        context,
        "SELECT admin_name_allow_add($1, $2) AS r",
        [word, randomUUID()],
      )
    )[0]?.r;
  const add = async (word: string, context = admin) => (await added(word, context))?.outcome;
  const remove = async (word: string, context = admin) =>
    (
      await as<{ r: string }>(context, "SELECT admin_name_allow_remove($1, $2) AS r", [
        word,
        randomUUID(),
      ])
    )[0]?.r;
  const page = async (
    search: string | null,
    language: string | null = null,
    after: string | null = null,
  ) =>
    (
      await as<{ r: Page }>(admin, "SELECT console_name_allow($1, $2, $3) AS r", [
        search,
        language,
        after,
      ])
    )[0]?.r;
  const pending = async () =>
    (await owner<{ pending: boolean }>("SELECT pending FROM full_name_recheck"))[0]?.pending;
  const settle = () =>
    owner(
      "UPDATE full_name_recheck SET pending = false, after_enrollment = NULL, after_field = NULL",
    );
  const blocked = async (name: string) =>
    (await owner<{ b: boolean }>("SELECT full_name_blocked($1) AS b", [name]))[0]?.b;

  beforeAll(async () => {
    db = await createTestDatabase();
    ids = await seedTwoTenants(db.owner);
    await owner(
      "INSERT INTO username_word (word, match, language) VALUES ('qxbad', 'word', 'en'), ('خبيث', 'part', 'ar')",
    );
    const [made] = await owner<{ id: string }>(
      `INSERT INTO staff_user (email, password_hash, platform_role, status)
       VALUES ('allow@questify.test', 'h', 'admin', 'active') RETURNING id`,
    );
    admin = { isAdmin: true, staffUserId: made?.id ?? "" };
  });
  afterAll(async () => {
    await db.close();
  });

  it("refuses every door to anyone but an active platform admin, and changes nothing", async () => {
    const [off] = await owner<{ id: string }>(
      `INSERT INTO staff_user (email, password_hash, platform_role, status)
       VALUES ('off-allow@questify.test', 'h', 'admin', 'disabled') RETURNING id`,
    );
    const [teamMember] = await owner<{ id: string }>(
      `INSERT INTO staff_user (email, password_hash, platform_role, status)
       VALUES ('member-allow@questify.test', 'h', 'none', 'active') RETURNING id`,
    );
    const seats: RequestContext[] = [
      {},
      { isAdmin: true },
      { isAdmin: true, staffUserId: off?.id ?? "" },
      { staffUserId: teamMember?.id ?? "" },
      { organizerId: ids.orgA, staffUserId: teamMember?.id ?? "" },
    ];
    for (const seat of seats) {
      expect(await code(as(seat, "SELECT console_name_allow(NULL, NULL, NULL)"))).toBe("QE403");
      expect(await code(add("qorvanel", seat))).toBe("QE403");
      expect(await code(remove("nasser", seat))).toBe("QE403");
    }
    expect(await owner("SELECT 1 FROM full_name_allow WHERE word = 'qorvanel'")).toEqual([]);
    expect(await owner("SELECT 1 FROM full_name_allow WHERE word = 'nasser'")).toEqual([
      { "?column?": 1 },
    ]);
  });

  it("adds a word folded as the check reads a name, with its letters' language, and finds it by page", async () => {
    expect(await added("  QORVÁLIX ")).toEqual({ outcome: "added", word: "qorvalix" });
    expect(await added("qorvalix")).toEqual({ outcome: "exists", word: "qorvalix" });
    expect(await add("قُرنفلان")).toBe("added");
    // A Persian kaf and yeh read as the Arabic letters the check uses.
    expect(await add("کرنفلی")).toBe("added");
    expect(
      await owner(
        "SELECT word, language FROM full_name_allow WHERE word IN ('qorvalix', 'قرنفلان', 'كرنفلي') ORDER BY word",
      ),
    ).toEqual([
      { word: "qorvalix", language: "en" },
      { word: "قرنفلان", language: "ar" },
      { word: "كرنفلي", language: "ar" },
    ]);
    expect(await page("ORVAL")).toEqual({
      words: [{ word: "qorvalix", language: "en", addedAt: expect.any(String) }],
      total: 1,
    });
    expect((await page("رنفل", "ar"))?.words.map((row) => row.word)).toEqual(["قرنفلان", "كرنفلي"]);
    expect((await page("رنفل", "en"))?.total).toBe(0);
    expect(await page("رنفل", null, "قرنفلان")).toEqual({
      words: [expect.objectContaining({ word: "كرنفلي" })],
      total: 2,
    });
    const all = await page(null);
    expect(all?.words).toHaveLength(50);
    expect(all?.total).toBeGreaterThan(90);
    expect(await remove("Qorválix")).toBe("removed");
    expect(await remove("qorvalix")).toBe("not_found");
    expect(await remove("قرنفلان")).toBe("removed");
    expect(await remove("كرنفلی")).toBe("removed");
    expect(
      await owner(
        `SELECT actor_type, actor_id, action, target_type, target_id, after, before FROM audit_log
         WHERE action LIKE 'full_name_allow.%' AND target_id = 'qorvalix' ORDER BY id`,
      ),
    ).toEqual([
      {
        actor_type: "admin",
        actor_id: admin.staffUserId,
        action: "full_name_allow.add",
        target_type: "full_name_allow",
        target_id: "qorvalix",
        after: { language: "en" },
        before: null,
      },
      {
        actor_type: "admin",
        actor_id: admin.staffUserId,
        action: "full_name_allow.remove",
        target_type: "full_name_allow",
        target_id: "qorvalix",
        after: null,
        before: { language: "en" },
      },
    ]);
  });

  it("refuses what is not one word of Arabic or English letters", async () => {
    for (const word of [
      "",
      " ",
      "a",
      "ab1",
      "two words",
      "al-amri",
      "abcب",
      "ali!x",
      "名前",
      "x".repeat(61),
    ]) {
      expect(await code(add(word)), word).toBe("WA400");
    }
  });

  it("refuses a word that is itself a list entry, however it is typed", async () => {
    for (const word of ["qxbad", "QXBAD", "qxbád", "خبيث", "خَبيث"]) {
      expect(await code(add(word)), word).toBe("WA409");
    }
    expect(await owner("SELECT 1 FROM full_name_allow WHERE word IN ('qxbad', 'خبيث')")).toEqual(
      [],
    );
  });

  it("keeps every abusive name of the corpus refused: no word of one can be allowed so that it passes", async () => {
    const words = (
      await owner<{ w: string }>(
        `SELECT DISTINCT w FROM unnest($1::text[]) n,
           unnest(string_to_array(full_name_fold(n), ' ') || replace(full_name_fold(n), ' ', '')) w
         WHERE w ~ '^([ء-غف-ي]{2,}|[a-z]{2,})$' ORDER BY w`,
        [ABUSIVE_NAMES],
      )
    ).map((row) => row.w);
    expect(words.length).toBeGreaterThan(150);
    const outcomes: Record<string, string[]> = {};
    // One transaction in the admin's seat, each word tried and undone at a savepoint (the owner's seat runs the check).
    await db.owner.query("BEGIN");
    try {
      await db.owner.query(
        "SELECT set_config('app.is_admin', 'on', true), set_config('app.staff_user_id', $1, true)",
        [admin.staffUserId],
      );
      for (const word of words) {
        await db.owner.query("SAVEPOINT door");
        const answer = await db.owner
          .query<{ r: { outcome: string } }>("SELECT admin_name_allow_add($1, $2) AS r", [
            word,
            randomUUID(),
          ])
          .then(
            (result) => result.rows[0]?.r.outcome ?? "",
            (error: unknown) => String((error as { code?: string }).code),
          );
        (outcomes[answer] ??= []).push(word);
        if (answer === "added") {
          const passed = await owner<{ name: string }>(
            "SELECT n AS name FROM unnest($1::text[]) n WHERE NOT full_name_blocked(n)",
            [ABUSIVE_NAMES],
          );
          expect(passed, word).toEqual([]);
        }
        await db.owner.query("ROLLBACK TO SAVEPOINT door");
      }
    } finally {
      await db.owner.query("ROLLBACK");
    }
    expect(Object.keys(outcomes).toSorted()).toEqual(["WA409", "WA422", "added", "exists"]);
    // A list entry, or one with an affix the check strips (refused by its shape, corpus or not).
    expect(outcomes["WA409"]).toEqual(
      expect.arrayContaining([
        "fuck",
        "dickhead",
        "كس",
        "قحبه",
        "fucks",
        "السحاقي",
        "الشرموطه",
        "ياخولي",
        "كسك",
      ]),
    );
    // Forms of a list entry with a letter added or an ending the check does not strip: each would let its own abusive
    // name through.
    expect(outcomes["WA422"]).toEqual(
      expect.arrayContaining(["sexx", "fuckme", "fuckk", "شرموطا", "كسامكم"]),
    );
    // Words added safely: real words of the abusive names, and joined runs no abusive name is read as.
    expect(outcomes["added"]).toEqual(expect.arrayContaining(["omar", "khan", "احمد"]));
  });

  it("refuses a list entry with an affix the check strips or a run of letters it collapses, that would pass once allowed", async () => {
    const shapes = [
      "cunty",
      "pussys",
      "asses",
      "kikes",
      "Fuuuck",
      "كسي",
      "طيزي",
      "عرصي",
      "منيوكي",
      "نيكي",
      "الكسي",
    ];
    for (const word of shapes) {
      expect(await blocked(word), word).toBe(true);
      expect(await code(add(word)), word).toBe("WA409");
      expect(await blocked(word), word).toBe(true);
    }
    // The shape the review measured: «كسي» allowed would cover «الكسي» as its prefix form.
    expect(await code(add("كسي"))).toBe("WA409");
    expect(await blocked("محمد الكسي")).toBe(true);
    expect(await owner("SELECT 1 FROM full_name_allow WHERE word = ANY ($1)", [shapes])).toEqual(
      [],
    );
  });

  it("would allow every word of the corpus' real names but those of an entry's shape, each seeded (a migration's call)", async () => {
    const words = (
      await owner<{ w: string }>(
        `SELECT DISTINCT w FROM unnest($1::text[]) n, unnest(string_to_array(full_name_fold(n), ' ')) w
         WHERE w ~ '^([ء-غف-ي]{2,}|[a-z]{2,})$' ORDER BY w`,
        [REAL_NAMES],
      )
    ).map((row) => row.w);
    expect(words.length).toBeGreaterThan(500);
    const shaped: string[] = [];
    await db.owner.query("BEGIN");
    try {
      await db.owner.query(
        "SELECT set_config('app.is_admin', 'on', true), set_config('app.staff_user_id', $1, true)",
        [admin.staffUserId],
      );
      await db.owner.query("DELETE FROM full_name_allow");
      for (const word of words) {
        await db.owner.query("SAVEPOINT door");
        const answer = await db.owner
          .query("SELECT admin_name_allow_add($1, $2)", [word, randomUUID()])
          .then(
            () => "",
            (error: unknown) => String((error as { code?: string }).code),
          );
        await db.owner.query("ROLLBACK TO SAVEPOINT door");
        if (answer !== "" && answer !== "WA422") {
          const listed = await db.owner.query("SELECT 1 FROM username_word WHERE word = $1", [
            word,
          ]);
          if (listed.rowCount === 0) {
            shaped.push(`${word}:${answer}`);
          }
        }
      }
    } finally {
      await db.owner.query("ROLLBACK");
    }
    // Each is a list entry with an affix the check strips, so the check refuses it too and only a seeded allow word lets
    // it through: a new name of that shape is a migration's decision, reviewed (ADR-817).
    const known = [
      "asser",
      "atwater",
      "butters",
      "butts",
      "cocker",
      "cummings",
      "fuks",
      "skeeter",
      "slutsky",
      "spicer",
      "الاسحاقي",
      "البزاز",
      "البزي",
      "البلوطي",
      "الجماعي",
      "الخولي",
      "السكسكي",
      "الشرجي",
      "باسحاق",
      "بلوطي",
      "جماعي",
      "خوله",
      "خولي",
      "سكسك",
      "شرجي",
      "كسمايي",
      "لحسين",
    ];
    expect(shaped).toEqual(known.map((word) => `${word}:WA409`));
    for (const word of known) {
      expect(await blocked(word), word).toBe(false);
    }
    await db.owner.query("BEGIN");
    try {
      await db.owner.query("DELETE FROM full_name_allow");
      const refused = await db.owner.query<{ w: string }>(
        "SELECT w FROM unnest($1::text[]) w WHERE full_name_blocked(w) ORDER BY w",
        [known],
      );
      // «كسمايي» holds its entry with more letters around it than the check reads, so it passes with no allow word.
      expect(refused.rows.map((row) => row.w)).toEqual(
        known.filter((word) => word !== "كسمايي").toSorted(),
      );
    } finally {
      await db.owner.query("ROLLBACK");
    }
  });

  it("refuses an Arabic word whose prefix or nisba forms are an abusive name, and allows a real name that holds one", async () => {
    for (const word of ["السحاقي", "ياخولي", "سكسي"]) {
      expect(await code(add(word)), word).toBe("WA409");
    }
    expect(await code(add("شرموطا"))).toBe("WA422");
    expect(await blocked("خالد السحاقي")).toBe(true);
    expect(await blocked("عبدالله الخبيثاني")).toBe(true);
    expect(await add("خبيثان")).toBe("added");
    expect(await blocked("عبدالله الخبيثاني")).toBe(false);
    expect(await remove("خبيثان")).toBe("removed");
    expect(await blocked("عبدالله الخبيثاني")).toBe(true);
  });

  it("marks the sweep pending on every change, and the sweep then shows or hides a stored name", async () => {
    const event = await newEvent();
    const stored = await member(event.event, event.field, "عبدالله الخبيثاني");
    expect(await flagOf(stored)).toBe(true);
    await settle();
    expect(await add("خبيثان")).toBe("added");
    expect(await pending()).toBe(true);
    await sweepAll();
    expect(await flagOf(stored)).toBe(false);
    await settle();
    expect(await remove("خبيثان")).toBe("removed");
    expect(await pending()).toBe(true);
    await sweepAll();
    expect(await flagOf(stored)).toBe(true);
    // A refused add changes nothing: the sweep stays as it was. A list entry with an ending the check strips is refused.
    await settle();
    expect(await code(add("qxbad"))).toBe("WA409");
    expect(await code(add("qxbads"))).toBe("WA409");
    expect(await pending()).toBe(false);
  });

  it("keeps the probes closed and the doors for the API's role alone", async () => {
    expect(await owner("SELECT count(*)::int AS n FROM full_name_probe")).toEqual([
      { n: new Set(ABUSIVE_NAMES).size },
    ]);
    // The probes are the corpus' abusive names: a name added to the corpus needs a migration that adds its probe.
    expect(
      (await owner<{ name: string }>("SELECT name FROM full_name_probe"))
        .map((row) => row.name)
        .toSorted(),
    ).toEqual([...new Set(ABUSIVE_NAMES)].toSorted());
    await expect(db.app.query("SELECT * FROM full_name_probe")).rejects.toThrow(
      /permission denied/,
    );
    await expect(db.outsider.query("SELECT * FROM public.full_name_probe")).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      db.app.query("INSERT INTO full_name_allow (word, language) VALUES ('qorvan', 'en')"),
    ).rejects.toThrow(/permission denied/);
  });

  async function newEvent(): Promise<{ event: string; field: string }> {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, access, starts_at, ends_at)
       VALUES ($1, $2, 'Allow Day', 'live', 'public', now() - interval '1 hour', now() + interval '1 day')
       RETURNING id`,
      [ids.orgA, `NA${String(counter).padStart(4, "0")}`],
    );
    const [field] = await owner<{ id: string }>(
      `INSERT INTO event_join_field (organizer_id, event_id, kind, position) VALUES ($1, $2, 'full_name', 0) RETURNING id`,
      [ids.orgA, event?.id],
    );
    return { event: event?.id ?? "", field: field?.id ?? "" };
  }

  async function member(event: string, field: string, name: string): Promise<string> {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`allowed_${counter}`],
    );
    const [enrollment] = await owner<{ id: string }>(
      `INSERT INTO enrollment (organizer_id, event_id, player_id, status, name_notice, joined_via)
       VALUES ($1, $2, $3, 'active', 'everyone', 'code') RETURNING id`,
      [ids.orgA, event, player?.id],
    );
    await owner(
      "INSERT INTO join_answer (enrollment_id, field_id, organizer_id, event_id, value) VALUES ($1, $2, $3, $4, $5)",
      [enrollment?.id, field, ids.orgA, event, name],
    );
    return enrollment?.id ?? "";
  }

  async function flagOf(enrollment: string): Promise<boolean | undefined> {
    return (
      await owner<{ name_blocked: boolean }>(
        "SELECT name_blocked FROM join_answer WHERE enrollment_id = $1",
        [enrollment],
      )
    )[0]?.name_blocked;
  }

  async function sweepAll(): Promise<void> {
    for (;;) {
      const [one] = await as<{ n: number }>({}, "SELECT name_flag_sweep(2000) AS n");
      if ((one?.n ?? 0) < 2000) {
        return;
      }
    }
  }
});
