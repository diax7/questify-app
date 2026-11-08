import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext, type RequestContext } from "#src/db/context";
import { ABUSIVE_NAMES, ACCEPTED_PASSES, REAL_NAMES } from "#test/db/full-name-corpus";
import {
  TEST_DATABASE_URL,
  addMember,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

type Row = Record<string, unknown>;

/** The SQLSTATE and detail a statement fails with, or "none". */
const failure = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
    return "none";
  } catch (error) {
    const pg = error as { code?: string; detail?: string };
    return pg.detail === undefined ? String(pg.code) : `${pg.code}:${pg.detail}`;
  }
};

/**
 * The username word lists on a full name (migration 0177, ADR-817): a Full name answer holding a listed word is refused
 * at the join; every stored one carries a flag, set as it is written and again by the sweep after a list change, and a
 * flagged name shows by username wherever other players read it (the read checks the flag only). The check goes word by
 * word (0178, Q-754: a word holding an entry with few letters around it, known prefixes and endings not counted), skips
 * the allow-list's real names, and folds other scripts and forms first. Nothing else refuses a name: not Arabic, not short,
 * not a username an admin retired.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("full name word lists (database)", () => {
  let db: TestDatabase;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let staffA: string;
  let admin: RequestContext;
  let counter = 0;
  let shipped: Row | undefined;

  beforeAll(async () => {
    db = await createTestDatabase();
    // As the migration leaves it, before any test changes a list or runs the sweep.
    shipped = (
      await db.owner.query(
        `SELECT r.pending, r.after_enrollment, a.atthasmissing AS default_in_catalog
         FROM full_name_recheck r, pg_attribute a
         WHERE a.attrelid = 'join_answer'::regclass AND a.attname = 'name_blocked'`,
      )
    ).rows[0];
    ids = await seedTwoTenants(db.owner);
    staffA = await addMember(db.owner, ids.orgA);
    await db.owner.query(
      "INSERT INTO username_word (word, match, language) VALUES ('qxbad', 'word', 'en'), ('خبيث', 'part', 'ar'), ('qxz', 'part', 'en')",
    );
    await db.owner.query("INSERT INTO username_retired (fold) VALUES ('ساره'), ('nora')");
    const made = await db.owner.query<{ id: string }>(
      `INSERT INTO staff_user (email, password_hash, platform_role, status)
       VALUES ('lists@questify.test', 'h', 'admin', 'active') RETURNING id`,
    );
    admin = { isAdmin: true, staffUserId: made.rows[0]?.id ?? "" };
  });
  afterAll(async () => {
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const as = async <T extends Row>(context: RequestContext, sql: string, values: unknown[] = []) =>
    withRequestContext(db.app, context, async () => (await db.app.query<T>(sql, values)).rows);
  const teamA = (): RequestContext => ({ organizerId: ids.orgA, staffUserId: staffA });

  const newEvent = async (): Promise<{ id: string; code: string }> => {
    counter += 1;
    const code = `FN${String(counter).padStart(4, "0")}`;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, access, starts_at, ends_at)
       VALUES ($1, $2, 'Names Day', 'live', 'public', now() - interval '1 hour', now() + interval '1 day')
       RETURNING id`,
      [ids.orgA, code],
    );
    return { id: event?.id ?? "", code };
  };
  const newPlayer = async (): Promise<string> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`filtered_${counter}`],
    );
    const id = player?.id ?? "";
    await owner("INSERT INTO player_contact (player_id, email) VALUES ($1, $2)", [
      id,
      `filtered${counter}@example.com`,
    ]);
    return id;
  };
  const addField = async (event: string, kind: string, position: number): Promise<string> =>
    (
      await owner<{ id: string }>(
        `INSERT INTO event_join_field (organizer_id, event_id, kind, position) VALUES ($1, $2, $3, $4) RETURNING id`,
        [ids.orgA, event, kind, position],
      )
    )[0]?.id ?? "";
  const join = (player: string, code: string, answers: Record<string, string>) =>
    as<{ outcome: string }>(
      { playerId: player },
      "SELECT outcome FROM join_event($1, 'code', '0.2', $2::jsonb)",
      [code, JSON.stringify(answers)],
    );

  const member = async (event: string, field: string, name: string) => {
    const player = await newPlayer();
    const [enrollment] = await owner<{ id: string }>(
      `INSERT INTO enrollment (organizer_id, event_id, player_id, status, name_notice, joined_via)
       VALUES ($1, $2, $3, 'active', 'everyone', 'code') RETURNING id`,
      [ids.orgA, event, player],
    );
    const id = enrollment?.id ?? "";
    await owner(
      `INSERT INTO join_answer (enrollment_id, field_id, organizer_id, event_id, value)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, field, ids.orgA, event, name],
    );
    return { player, enrollment: id };
  };

  const blocked = async (names: readonly string[]) =>
    (
      await owner<{ name: string }>(
        "SELECT n AS name FROM unnest($1::text[]) n WHERE full_name_blocked(n)",
        [names],
      )
    ).map((row) => row.name);

  const shownEvent = async () => {
    const event = await newEvent();
    const field = await addField(event.id, "full_name", 0);
    await as(
      teamA(),
      "UPDATE event SET name_display = 'both', name_audience = 'everyone' WHERE id = $1",
      [event.id],
    );
    return { event, field };
  };

  /** The tick's work: pages of the sweep until one comes back short. */
  const sweepAll = async () => {
    for (;;) {
      const [page] = await as<{ n: number }>({}, "SELECT name_flag_sweep(2000) AS n");
      if ((page?.n ?? 0) < 2000) {
        return;
      }
    }
  };

  const flagOf = async (enrollment: string) =>
    (
      await owner<{ name_blocked: boolean }>(
        "SELECT name_blocked FROM join_answer WHERE enrollment_id = $1",
        [enrollment],
      )
    )[0]?.name_blocked;

  describe("at the join", () => {
    it("refuses a full name with a listed word, however it is spelled, and names the field", async () => {
      const event = await newEvent();
      const field = await addField(event.id, "full_name", 0);
      const player = await newPlayer();
      for (const name of [
        "Sara QXBAD",
        "Sara qxbad-Ahmed",
        "Bastard Khan",
        "B4st4rd Khan",
        "Bas​tard Khan",
        "B a s t a r d",
        "عبدالله الخبيث",
        "عبدالله الخَبِيث",
        "عبدالله الخبـيث",
        "خ ب ي ث",
      ]) {
        expect(await failure(join(player, event.code, { [field]: name })), name).toBe(
          `JA422:name:${field}`,
        );
      }
      expect(await owner("SELECT 1 FROM enrollment WHERE player_id = $1", [player])).toEqual([]);
    });

    it("never refuses a name for being Arabic, short, marked or retired as a username", async () => {
      const event = await newEvent();
      const field = await addField(event.id, "full_name", 0);
      for (const name of [
        "محمد",
        "Li",
        "أحمد بن سعيد القحطاني",
        "مُحَمَّد عَبْدُ الله",
        "Hassan Al-Qahtani",
        "Glass Ann",
        "سارة",
        "Nora",
      ]) {
        const player = await newPlayer();
        expect(await join(player, event.code, { [field]: name }), name).toEqual([
          { outcome: "joined" },
        ]);
      }
    });

    it("checks the Full name field only, and a malformed answer still says field", async () => {
      const event = await newEvent();
      const name = await addField(event.id, "full_name", 0);
      const company = await addField(event.id, "company", 1);
      const player = await newPlayer();
      expect(await join(player, event.code, { [name]: "Sara", [company]: "Qxbad Ltd" })).toEqual([
        { outcome: "joined" },
      ]);
      const other = await newPlayer();
      expect(await failure(join(other, event.code, { [name]: " qxbad " }))).toBe(
        `JA422:field:${name}`,
      );
    });
  });

  describe("the check", () => {
    it(`never refuses the ${REAL_NAMES.length} real names of the corpus with the lists as shipped`, async () => {
      expect(REAL_NAMES.length).toBeGreaterThanOrEqual(300);
      expect(await blocked(REAL_NAMES)).toEqual([]);
    });

    it("refuses every abusive name of the corpus, other scripts and forms included", async () => {
      const passed = await owner<{ name: string }>(
        "SELECT n AS name FROM unnest($1::text[]) n WHERE NOT full_name_blocked(n)",
        [ABUSIVE_NAMES],
      );
      expect(passed).toEqual([]);
    });

    it("reads look-alike letters, compatibility forms, accents and Persian letters as the list's letters", async () => {
      expect(
        await owner(
          `SELECT full_name_fold('fυck') AS greek, full_name_fold('fuсk') AS cyrillic, full_name_fold('ｆｕｃｋ') AS wide,
                  full_name_fold('FÜCK') AS accent, full_name_fold('ﻛﺲ') AS forms, full_name_fold('کس') AS persian,
                  full_name_fold('أحمد  آل-سعيد') AS arabic, full_name_fold('سارة ١٢٣') AS digits`,
        ),
      ).toEqual([
        {
          greek: "fuck",
          cyrillic: "fuck",
          wide: "fuck",
          accent: "fuck",
          forms: "كس",
          persian: "كس",
          arabic: "احمد ال سعيد",
          digits: "ساره 123",
        },
      ]);
    });

    it(`passes the ${ACCEPTED_PASSES.length} joined forms Dhia accepted: many letters around the entry (Q-754)`, async () => {
      expect(await blocked(ACCEPTED_PASSES)).toEqual([]);
    });

    it("refuses a word holding an entry with few letters around it, known prefixes and endings not counted", async () => {
      // A part entry of 4 letters or more: 2 letters; of 3: 1; a word entry of 3 letters or more: 1; of 1 or 2: none.
      const cases: readonly (readonly [string, boolean])[] = [
        ["fuck", true],
        ["fuckme", true],
        ["xfuckx", true],
        ["fuckmee", false],
        ["fuckers", true],
        ["fuckings", true],
        ["pussies", true],
        ["qxz", true],
        ["aqxz", true],
        ["qxzers", true],
        ["aqxza", false],
        ["qxzali", false],
        ["qxbadz", true],
        ["qxbads", true],
        ["qxbadzz", false],
        ["sexx", true],
        ["Essex", false],
        ["c0ck", true],
        ["ali2porn", true],
        ["Anaslutfi", false],
        ["Siriporns", false],
        ["خبيثنا", true],
        ["خبيثناا", false],
        ["والخبيثات", true],
        ["ياشرموطة", true],
        ["يا القحبة", true],
        ["ياالقحبة", true],
        ["الشرموطات", true],
        ["وشرموطتك", true],
        ["شرموطاتك", true],
        ["شرموطتي", true],
        ["معرص", true],
        ["كسك", true],
        ["كسا", false],
        ["عباس كساب", false],
        ["کسمایی", false],
        ["ملاكسمير", false],
        ["porn star", true],
        ["Ali Butthole", true],
        ["Coon Smith", true],
        ["Mong Vang", true],
        ["fuckface Ali", true],
        ["Mr Shithead", true],
        ["ا ل ش ر م و ط ة", true],
      ];
      const refused = cases.filter(([, out]) => out).map(([name]) => name);
      expect(await blocked(cases.map(([name]) => name))).toEqual(refused);
    });

    it("covers an Arabic allow word with a prefix or the nisba, never with a plural, a pronoun or يا", async () => {
      expect(
        await blocked([
          "محمد الإسحاقي",
          "سعيد باسحاق",
          "عبدالله البلوطي",
          "علي السكسكي",
          "خولة الحربي",
          "محمود الخولي",
          "زبيدة بنت جعفر",
          "عمر زبيدي",
          "مصعب بن الزبير",
          "محمد الزبيدات",
          "عبدالله الجماعي",
          "الخولات",
          "خول",
          "زبي",
          "ياخولي",
          "يا خولي",
          "ياسحاق",
        ]),
      ).toEqual(["الخولات", "خول", "زبي", "ياخولي", "يا خولي", "ياسحاق"]);
    });

    it("keeps «البزاز», a real family name, and only it: the bare word and its other forms are refused", async () => {
      // «البزاز» is the family name of the corpus' «سعد البزاز» (the cloth merchant); the allow word is the whole word
      // with its article, so «بزاز» (the breasts) and its plural and pronoun forms stay refused.
      expect(
        await blocked([
          "سعد البزاز",
          "والبزاز",
          "بزاز",
          "بزازك",
          "البزازات",
          "يا بزاز",
          "يا البزاز",
          "ياالبزاز",
        ]),
      ).toEqual(["بزاز", "بزازك", "البزازات", "يا بزاز", "يا البزاز", "ياالبزاز"]);
    });

    it("skips an allow word only with no digit in it", async () => {
      expect(
        await blocked([
          "Dick Smith",
          "Kike Garcia",
          "dick5",
          "dick69",
          "butt69",
          "kike88",
          "Nasser2",
        ]),
      ).toEqual(["dick5", "dick69", "butt69", "kike88", "Nasser2"]);
    });

    it("reads * ! @ $ inside a word as letters, only for a list hit, and never as an allow word (0180)", async () => {
      expect(
        await blocked([
          "f*ck",
          "sh!t",
          "Sh*t Omar",
          "a$$hole",
          "B@stard",
          "d!ck",
          "Dick!",
          "!Dick",
          "@li Khan",
          "N!xau Toma",
          "Noor @ Ali",
          "D'Souza",
          "O'Brien",
          "S*ra",
        ]),
      ).toEqual(["f*ck", "sh!t", "Sh*t Omar", "a$$hole", "B@stard", "d!ck"]);
    });

    it("reads symbols after NFKC, ∗ ⁎ ¡ as * and !, * as any one letter and a run as one symbol (0181)", async () => {
      expect(
        await blocked([
          "f＊ck",
          "b＠stard",
          "f∗ck",
          "sh¡t",
          "sh!!t",
          "F**k",
          "fu*k",
          "c**t",
          "Ke$ha",
          "Ｋｅ＄ｈａ",
          "Wi!!iam",
          "Ｔａｒｏ Ｙａｍａｄａ",
          "S*ra",
          "Ali*Khan",
          "Y**k",
          "Dick",
          "Y*nus",
          "N*sser",
          "Sm*th",
          "Ha*na",
          "Mo*****d",
          "fuuu*k",
          "f*ccck",
          "Saaa*d",
        ]),
      ).toEqual([
        "f＊ck",
        "b＠stard",
        "f∗ck",
        "sh¡t",
        "sh!!t",
        "F**k",
        "fu*k",
        "c**t",
        "fuuu*k",
        "f*ccck",
      ]);
    });

    it("reads _ # • | and the other stars as * (0181 review), and leaves . - and a click letter alone", async () => {
      expect(
        await blocked([
          "f_ck",
          "ｆ＿ｃｋ",
          "f#ck",
          "f٭ck",
          "f✱ck",
          "f✳ck",
          "f❋ck",
          "f★ck",
          "f•ck",
          "f|ck",
          "sh|t",
          "f.ck",
          "f-ck",
          "Ju|'hoan",
          "Ali_Khan",
          "Team#1",
        ]),
      ).toEqual([
        "f_ck",
        "ｆ＿ｃｋ",
        "f#ck",
        "f٭ck",
        "f✱ck",
        "f✳ck",
        "f❋ck",
        "f★ck",
        "f•ck",
        "f|ck",
        "sh|t",
      ]);
    });

    it("reads a run of 3 or more of one letter as 1 and 2, never a run of 2 (0180)", async () => {
      expect(
        await blocked([
          "Fuuuck",
          "Asssshole",
          "Diiick",
          "كسسس",
          "Aaron",
          "Abbas",
          "Hassan",
          "Moo",
          "Mohammed",
          "Dick",
          "Diick",
          "Saaad",
        ]),
      ).toEqual(["Fuuuck", "Asssshole", "Diiick", "كسسس"]);
    });

    it("reads small capitals and other look-alike letters as Latin letters (0180)", async () => {
      expect(
        await owner(
          `SELECT full_name_fold('ꜱᴇx') AS small, full_name_fold('ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘꞯʀꜱᴛᴜᴠᴡʏᴢ') AS alphabet,
                  full_name_fold('ɑɡɩȷһӏүϲϳսօհ') AS others`,
        ),
      ).toEqual([{ small: "sex", alphabet: "abcdefghijklmnopqrstuvwyz", others: "agijhlycjuoh" }]);
      expect(await blocked(["ꜱex", "ꜰᴜᴄᴋ", "ꜱʜɪᴛ", "fսck", "ᴀᴀʀᴏɴ"])).toEqual([
        "ꜱex",
        "ꜰᴜᴄᴋ",
        "ꜱʜɪᴛ",
        "fսck",
      ]);
    });

    it("refuses a username token that is a word compound, never a longer token holding one", async () => {
      const names = [
        "jackass",
        "dumbass_7",
        "the_dickhead",
        "كسامك",
        "كسأمك",
        "jackassery",
        "dumbasses",
        "smartass",
      ];
      expect(
        (
          await owner<{ name: string }>(
            "SELECT n AS name FROM unnest($1::text[]) n WHERE username_blocked(n)",
            [names],
          )
        ).map((row) => row.name),
      ).toEqual(["jackass", "dumbass_7", "the_dickhead", "كسامك", "كسأمك"]);
    });

    it("holds only real names the rule refuses, and drops 0177's names that pass without one", async () => {
      const words = (
        await owner<{ word: string }>("SELECT word FROM full_name_allow ORDER BY word")
      ).map((row) => row.word);
      expect(words).toHaveLength(92);
      expect(words).toEqual(
        expect.arrayContaining([
          "kike",
          "butt",
          "nasser",
          "tito",
          "shittu",
          "asser",
          "butters",
          "اسحاق",
          "بلوطي",
          "خوله",
          "زبير",
          "لحسن",
          "لحسين",
          "زبيدات",
          "nazir",
          "fuks",
          "fuki",
          "fuko",
          "fuke",
          "whitler",
          "nazish",
        ]),
      );
      const dropped = [
        "akshita",
        "dikshit",
        "harshit",
        "harshita",
        "kinoshita",
        "kshitij",
        "lipshitz",
        "matsushita",
        "morishita",
        "nishita",
        "pornchai",
        "pornpan",
        "pornpimol",
        "pornsak",
        "pornthip",
        "rishita",
        "shitaya",
        "takeshita",
        "toshitaka",
        "wankhede",
        "yamashita",
        "yoshitaka",
        "yoshito",
        "yoshitomo",
      ];
      expect(words.filter((word) => dropped.includes(word))).toEqual([]);
      // With no allow-list, each of its words is refused and each dropped name passes.
      await db.owner.query("BEGIN");
      try {
        await owner("DELETE FROM full_name_allow");
        expect(await blocked(words)).toEqual(words);
        expect(await blocked(dropped)).toEqual([]);
      } finally {
        await db.owner.query("ROLLBACK");
      }
    });

    it("keeps the allow-list closed: no grant to the API's role or anyone", async () => {
      expect(
        await owner(
          `SELECT has_table_privilege('questify_app', 'full_name_allow', 'SELECT') AS app_read,
                  has_table_privilege('questify_app', 'full_name_allow', 'INSERT') AS app_write,
                  has_table_privilege('questify_app', 'full_name_recheck', 'SELECT') AS app_sweep,
                  has_table_privilege('public', 'full_name_allow', 'SELECT') AS anyone`,
        ),
      ).toEqual([{ app_read: false, app_write: false, app_sweep: false, anyone: false }]);
      await expect(db.outsider.query("SELECT * FROM public.full_name_allow")).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        db.app.query("INSERT INTO full_name_allow (word, language) VALUES ('shit', 'en')"),
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe("where other players read a name", () => {
    it("flags a name as it is written, and the read gives no flagged name and checks nothing else", async () => {
      const { event, field } = await shownEvent();
      const clean = await member(event.id, field, "Sara Ahmed");
      const stored = await member(event.id, field, "Bastard Khan");
      const company = await addField(event.id, "company", 1);
      await owner(
        `INSERT INTO join_answer (enrollment_id, field_id, organizer_id, event_id, value) VALUES ($1, $2, $3, $4, 'Bastard Ltd')`,
        [clean.enrollment, company, ids.orgA, event.id],
      );
      expect(
        await owner(
          "SELECT field_id = $2 AS name, name_blocked FROM join_answer WHERE enrollment_id = ANY ($1) ORDER BY 1, 2",
          [[clean.enrollment, stored.enrollment], field],
        ),
      ).toEqual([
        { name: false, name_blocked: false },
        { name: true, name_blocked: false },
        { name: true, name_blocked: true },
      ]);
      const seen = () =>
        as<{ enrollment_id: string; full_name: string }>(
          { playerId: clean.player },
          "SELECT enrollment_id, full_name FROM ranking_names($1, $2::uuid[]) ORDER BY full_name",
          [event.id, [clean.enrollment, stored.enrollment]],
        );
      expect(await seen()).toEqual([{ enrollment_id: clean.enrollment, full_name: "Sara Ahmed" }]);
      // The read runs no check: the flag alone decides.
      await owner(
        "UPDATE join_answer SET name_blocked = NOT name_blocked WHERE enrollment_id = ANY ($1) AND field_id = $2",
        [[clean.enrollment, stored.enrollment], field],
      );
      expect(await seen()).toEqual([
        { enrollment_id: stored.enrollment, full_name: "Bastard Khan" },
      ]);
    });

    it("gives the big screen's part one key, or none for a flagged name", async () => {
      const { event, field } = await shownEvent();
      const clean = await member(event.id, field, "Sara Ahmed");
      const stored = await member(event.id, field, "Bastard Khan");
      expect(
        await owner("SELECT full_name_part($1) AS clean, full_name_part($2) AS stored", [
          clean.enrollment,
          stored.enrollment,
        ]),
      ).toEqual([{ clean: { fullName: "Sara Ahmed" }, stored: {} }]);
    });

    it("ships with no backfill: the column is a catalog default and the sweep is left pending", () => {
      expect(shipped).toEqual({ pending: true, after_enrollment: null, default_in_catalog: true });
    });

    it("hides stored names when the console adds a word and shows them again when it is removed", async () => {
      const { event, field } = await shownEvent();
      const later = await member(event.id, field, "Zorvex Omar");
      const other = await member(event.id, field, "Omar Zorvexian");
      await sweepAll();
      expect([await flagOf(later.enrollment), await flagOf(other.enrollment)]).toEqual([
        false,
        false,
      ]);
      expect(
        await as(admin, "SELECT admin_word_add('zorvex', 'word', 'en', $1) AS r", [randomUUID()]),
      ).toEqual([{ r: "added" }]);
      // The door runs no page: the sweep is pending from the start, and the tick does it.
      expect(await owner("SELECT pending, after_enrollment FROM full_name_recheck")).toEqual([
        { pending: true, after_enrollment: null },
      ]);
      expect(await flagOf(later.enrollment)).toBe(false);
      await sweepAll();
      expect([await flagOf(later.enrollment), await flagOf(other.enrollment)]).toEqual([
        true,
        false,
      ]);
      expect(await owner("SELECT pending FROM full_name_recheck")).toEqual([{ pending: false }]);
      expect(
        await as(admin, "SELECT admin_word_remove('zorvex', $1) AS r", [randomUUID()]),
      ).toEqual([{ r: "removed" }]);
      await sweepAll();
      expect(await flagOf(later.enrollment)).toBe(false);
    });

    it("restarts the sweep on a list change made outside the console doors", async () => {
      await sweepAll();
      for (const change of [
        "INSERT INTO username_word (word, match, language) VALUES ('vexlor', 'word', 'en')",
        "UPDATE username_word SET language = 'en' WHERE word = 'vexlor'",
        "DELETE FROM username_word WHERE word = 'vexlor'",
        "INSERT INTO full_name_allow (word, language) VALUES ('vexlorian', 'en')",
        "DELETE FROM full_name_allow WHERE word = 'vexlorian'",
      ]) {
        await owner(
          "UPDATE full_name_recheck SET pending = false, after_enrollment = NULL, after_field = NULL",
        );
        await owner(change);
        expect(await owner("SELECT pending FROM full_name_recheck"), change).toEqual([
          { pending: true },
        ]);
      }
      await sweepAll();
    });

    it("makes a word add wait for a join's answer in flight, and the sweep then flags that answer", async () => {
      const { event, field } = await shownEvent();
      await sweepAll();
      const player = await newPlayer();
      // The join: its answer is written (the trigger takes the lists' key shared) and its transaction stays open.
      await db.owner.query("BEGIN");
      const [enrollment] = (
        await db.owner.query<{ id: string }>(
          `INSERT INTO enrollment (organizer_id, event_id, player_id, status, name_notice, joined_via)
           VALUES ($1, $2, $3, 'active', 'everyone', 'code') RETURNING id`,
          [ids.orgA, event.id, player],
        )
      ).rows;
      const id = enrollment?.id ?? "";
      await db.owner.query(
        `INSERT INTO join_answer (enrollment_id, field_id, organizer_id, event_id, value)
         VALUES ($1, $2, $3, $4, 'Plovex Omar')`,
        [id, field, ids.orgA, event.id],
      );
      let settled = 0;
      const adding = as(admin, "SELECT admin_word_add('plovex', 'word', 'en', $1) AS r", [
        randomUUID(),
      ]).then((rows) => {
        settled = performance.now();
        return rows;
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(settled).toBe(0);
      const committed = performance.now();
      await db.owner.query("COMMIT");
      expect(await adding).toEqual([{ r: "added" }]);
      // The door waited for the join and no more: no page of its own, and no tick page was in flight.
      expect(settled - committed).toBeLessThan(1000);
      // Checked against the lists before the word, so it is the sweep's to flag.
      expect(await flagOf(id)).toBe(false);
      expect(await owner("SELECT pending FROM full_name_recheck")).toEqual([{ pending: true }]);
      await sweepAll();
      expect(await flagOf(id)).toBe(true);
      await as(admin, "SELECT admin_word_remove('plovex', $1)", [randomUUID()]);
      await sweepAll();
    });

    it("sweeps in pages from the stored key, and a list change starts it again", async () => {
      const { event, field } = await shownEvent();
      const names = [];
      for (const name of ["Qorvane One", "Qorvane Two", "Qorvane Three"]) {
        names.push(await member(event.id, field, name));
      }
      await owner(
        "INSERT INTO username_word (word, match, language) VALUES ('qorvane', 'word', 'en')",
      );
      const total =
        (
          await owner<{ n: number }>(
            "SELECT count(*)::int AS n FROM join_answer a JOIN event_join_field f ON f.id = a.field_id AND f.kind = 'full_name'",
          )
        )[0]?.n ?? 0;
      let pages = 0;
      let checked = 0;
      for (;;) {
        const [page] = await as<{ n: number }>({}, "SELECT name_flag_sweep(2) AS n");
        pages += 1;
        checked += page?.n ?? 0;
        if ((page?.n ?? 0) < 2) {
          break;
        }
      }
      expect(checked).toBe(total);
      expect(pages).toBe(Math.floor(total / 2) + 1);
      expect(await owner("SELECT pending, after_enrollment FROM full_name_recheck")).toEqual([
        { pending: false, after_enrollment: null },
      ]);
      for (const one of names) {
        expect(await flagOf(one.enrollment)).toBe(true);
      }
      expect(await as<{ n: number }>({}, "SELECT name_flag_sweep(2) AS n")).toEqual([{ n: 0 }]);
      // A list change in the middle of a sweep starts it again from the first page.
      await owner("INSERT INTO full_name_allow (word, language) VALUES ('qorvanex', 'en')");
      await as({}, "SELECT name_flag_sweep(2)");
      expect(
        await owner("SELECT after_enrollment IS NOT NULL AS mid FROM full_name_recheck"),
      ).toEqual([{ mid: true }]);
      await owner("DELETE FROM username_word WHERE word = 'qorvane'");
      expect(await owner("SELECT pending, after_enrollment FROM full_name_recheck")).toEqual([
        { pending: true, after_enrollment: null },
      ]);
      await sweepAll();
      expect(await owner("SELECT pending, after_enrollment FROM full_name_recheck")).toEqual([
        { pending: false, after_enrollment: null },
      ]);
      for (const one of names) {
        expect(await flagOf(one.enrollment)).toBe(false);
      }
    });

    it("is internal, but for the sweep's door: the API's role runs only name_flag_sweep", async () => {
      expect(
        await owner(
          `SELECT p.proname, has_function_privilege('questify_app', p.oid, 'EXECUTE') AS app,
                  has_function_privilege('public', p.oid, 'EXECUTE') AS anyone
           FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
             AND p.proname IN ('full_name_blocked', 'full_name_fold', 'join_answer_name_flag', 'full_name_recheck_mark',
                               'name_flag_sweep')
           ORDER BY p.proname`,
        ),
      ).toEqual([
        { proname: "full_name_blocked", app: false, anyone: false },
        { proname: "full_name_fold", app: false, anyone: false },
        { proname: "full_name_recheck_mark", app: false, anyone: false },
        { proname: "join_answer_name_flag", app: false, anyone: false },
        { proname: "name_flag_sweep", app: true, anyone: false },
      ]);
    });
  });
});
