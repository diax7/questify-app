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
 * at the join, and a stored name that fails shows by username wherever other players read it. Nothing else refuses a
 * name: not Arabic, not short, not a username an admin retired.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("full name word lists (database)", () => {
  let db: TestDatabase;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let staffA: string;
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    ids = await seedTwoTenants(db.owner);
    staffA = await addMember(db.owner, ids.orgA);
    await db.owner.query(
      "INSERT INTO username_word (word, match, language) VALUES ('qxbad', 'word', 'en'), ('خبيث', 'part', 'ar')",
    );
    await db.owner.query("INSERT INTO username_retired (fold) VALUES ('ساره'), ('nora')");
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

  describe("where other players read a name", () => {
    it("shows a stored name that fails by username, and one that fails once a word is added", async () => {
      const event = await newEvent();
      const field = await addField(event.id, "full_name", 0);
      await as(
        teamA(),
        "UPDATE event SET name_display = 'both', name_audience = 'everyone' WHERE id = $1",
        [event.id],
      );
      const clean = await member(event.id, field, "Sara Ahmed");
      const stored = await member(event.id, field, "Bastard Khan");
      const later = await member(event.id, field, "Zorvex Omar");
      const all = [clean, stored, later].map((one) => one.enrollment);
      const seen = () =>
        as<{ enrollment_id: string; full_name: string }>(
          { playerId: clean.player },
          "SELECT enrollment_id, full_name FROM ranking_names($1, $2::uuid[]) ORDER BY full_name",
          [event.id, all],
        );
      expect(await seen()).toEqual([
        { enrollment_id: clean.enrollment, full_name: "Sara Ahmed" },
        { enrollment_id: later.enrollment, full_name: "Zorvex Omar" },
      ]);
      await owner(
        "INSERT INTO username_word (word, match, language) VALUES ('zorvex', 'word', 'en')",
      );
      expect(await seen()).toEqual([{ enrollment_id: clean.enrollment, full_name: "Sara Ahmed" }]);
    });

    it("is internal: no grant on the check", async () => {
      expect(
        await owner(
          `SELECT has_function_privilege('questify_app', 'full_name_blocked(text)', 'EXECUTE') AS app,
                  has_function_privilege('public', 'full_name_blocked(text)', 'EXECUTE') AS anyone`,
        ),
      ).toEqual([{ app: false, anyone: false }]);
    });
  });
});
