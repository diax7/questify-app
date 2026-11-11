import { randomBytes } from "node:crypto";
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
type Mode = "username" | "full_name" | "both";
type Audience = "staff" | "everyone";

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
 * Name display in the database (T-615, migration 0109, ADR-400): the event's setting and the player's own notice are two
 * gates on a full name reaching other players, the guard on the setting, the notice a join records, and what an
 * operator or the prize desk may read. The tests read as the rows an event holds, never through the API.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("name display (database)", () => {
  let db: TestDatabase;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let staffA: string;
  let staffB: string;
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    ids = await seedTwoTenants(db.owner);
    staffA = await addMember(db.owner, ids.orgA);
    staffB = await addMember(db.owner, ids.orgB);
  });
  afterAll(async () => {
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const as = async <T extends Row>(context: RequestContext, sql: string, values: unknown[] = []) =>
    withRequestContext(db.app, context, async () => (await db.app.query<T>(sql, values)).rows);
  const teamA = (): RequestContext => ({ organizerId: ids.orgA, staffUserId: staffA });
  const teamB = (): RequestContext => ({ organizerId: ids.orgB, staffUserId: staffB });
  const newEvent = async (): Promise<{ id: string; code: string }> => {
    counter += 1;
    const code = `ND${String(counter).padStart(4, "0")}`;
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
      [`namer_${counter}`],
    );
    const id = player?.id ?? "";
    await owner("INSERT INTO player_contact (player_id, email) VALUES ($1, $2)", [
      id,
      `namer${counter}@example.com`,
    ]);
    return id;
  };
  const addField = async (event: string, kind = "full_name"): Promise<string> =>
    (
      await owner<{ id: string }>(
        `INSERT INTO event_join_field (organizer_id, event_id, kind, position) VALUES ($1, $2, $3, 0) RETURNING id`,
        [ids.orgA, event, kind],
      )
    )[0]?.id ?? "";
  const setNames = (event: string, display: Mode, audience: Audience, team = teamA()) =>
    as(team, "UPDATE event SET name_display = $2, name_audience = $3 WHERE id = $1", [
      event,
      display,
      audience,
    ]);

  /** An active member written straight into the rows: the notice they were given and the full name they typed. */
  const member = async (
    event: string,
    field: string | null,
    options: {
      notice?: Audience | null;
      name?: string | null;
      status?: string;
      via?: string;
    } = {},
  ): Promise<{ player: string; enrollment: string }> => {
    const player = await newPlayer();
    const [enrollment] = await owner<{ id: string }>(
      `INSERT INTO enrollment (organizer_id, event_id, player_id, status, name_notice, joined_via)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        ids.orgA,
        event,
        player,
        options.status ?? "active",
        options.notice ?? null,
        options.via ?? "code",
      ],
    );
    const id = enrollment?.id ?? "";
    if (field !== null && options.name !== null) {
      await owner(
        `INSERT INTO join_answer (enrollment_id, field_id, organizer_id, event_id, value)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, field, ids.orgA, event, options.name ?? `Name ${counter}`],
      );
    }
    return { player, enrollment: id };
  };
  const namesSeenBy = async (reader: string, event: string, enrollments: string[]) =>
    as<{ enrollment_id: string; full_name: string }>(
      { playerId: reader },
      "SELECT enrollment_id, full_name FROM ranking_names($1, $2::uuid[])",
      [event, enrollments],
    );

  const join = (player: string, code: string, answers: Record<string, string>) =>
    as<{ outcome: string; enrollment_id: string | null }>(
      { playerId: player },
      "SELECT outcome, enrollment_id FROM join_event($1, 'code', '0.2', $2::jsonb)",
      [code, JSON.stringify(answers)],
    );
  const noticeOf = async (enrollment: string | null) =>
    (await owner("SELECT name_notice FROM enrollment WHERE id = $1", [enrollment]))[0];

  const station = async (event: string) => {
    const operator = await newPlayer();
    await owner(
      "INSERT INTO staff_assignment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)",
      [ids.orgA, event, operator],
    );
    const [category] = await owner<{ id: string }>("SELECT id FROM category WHERE event_id = $1", [
      event,
    ]);
    const [quest] = await owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, type_config)
       VALUES ($1, $2, 'enter_code', 'Scan', 5, 1, '{"code":"SCAN"}') RETURNING id`,
      [event, category?.id],
    );
    return { operator, quest: quest?.id ?? "" };
  };

  describe("the setting", () => {
    it("starts on usernames for the staff, and only the event's own team changes it", async () => {
      const event = await newEvent();
      expect(
        await owner("SELECT name_display, name_audience FROM event WHERE id = $1", [event.id]),
      ).toEqual([{ name_display: "username", name_audience: "staff" }]);
      await addField(event.id);
      await setNames(event.id, "both", "staff");
      expect(
        await owner("SELECT name_display, name_audience FROM event WHERE id = $1", [event.id]),
      ).toEqual([{ name_display: "both", name_audience: "staff" }]);
      // Another organizer's team and a player reach no row; the update changes nothing.
      await setNames(event.id, "full_name", "everyone", teamB());
      await as(
        { playerId: await newPlayer() },
        "UPDATE event SET name_display = 'username' WHERE id = $1",
        [event.id],
      ).catch(() => undefined);
      expect(
        await owner("SELECT name_display, name_audience FROM event WHERE id = $1", [event.id]),
      ).toEqual([{ name_display: "both", name_audience: "staff" }]);
    });

    it("refuses an unknown display or audience", async () => {
      const event = await newEvent();
      await addField(event.id);
      expect(
        await failure(
          as(teamA(), "UPDATE event SET name_display = 'nickname' WHERE id = $1", [event.id]),
        ),
      ).toBe("23514");
      expect(
        await failure(
          as(teamA(), "UPDATE event SET name_audience = 'public' WHERE id = $1", [event.id]),
        ),
      ).toBe("23514");
    });

    it("needs the Full name join field to show a full name, and a username setting needs none", async () => {
      const event = await newEvent();
      expect(await failure(setNames(event.id, "full_name", "staff"))).toBe("ND422:full_name_field");
      expect(await failure(setNames(event.id, "both", "everyone"))).toBe("ND422:full_name_field");
      await addField(event.id, "company");
      expect(await failure(setNames(event.id, "both", "staff"))).toBe("ND422:full_name_field");
      expect(await failure(setNames(event.id, "username", "everyone"))).toBe("none");
      await addField(event.id);
      expect(await failure(setNames(event.id, "both", "staff"))).toBe("none");
    });
  });

  describe("widening to everyone", () => {
    it("is refused while a player who was not told is in the event, and narrowing is always allowed", async () => {
      const event = await newEvent();
      const field = await addField(event.id);
      await member(event.id, field, { notice: null });
      expect(await failure(setNames(event.id, "both", "everyone"))).toBe(
        "ND409:name_display_locked",
      );
      // Staff-only does not widen what other players see.
      expect(await failure(setNames(event.id, "both", "staff"))).toBe("none");
      expect(await failure(setNames(event.id, "full_name", "staff"))).toBe("none");
      expect(await failure(setNames(event.id, "both", "everyone"))).toBe(
        "ND409:name_display_locked",
      );
      expect(await failure(setNames(event.id, "username", "everyone"))).toBe("none");
    });

    it("counts a player told only about the staff, and a pending request, but not one who left or was declined", async () => {
      const event = await newEvent();
      const field = await addField(event.id);
      const told = await member(event.id, field, { notice: "staff" });
      expect(await failure(setNames(event.id, "both", "everyone"))).toBe(
        "ND409:name_display_locked",
      );
      await owner("UPDATE enrollment SET status = 'left' WHERE id = $1", [told.enrollment]);
      expect(await failure(setNames(event.id, "both", "everyone"))).toBe("none");
      await setNames(event.id, "username", "staff");
      const pending = await member(event.id, field, { notice: null, status: "pending" });
      expect(await failure(setNames(event.id, "both", "everyone"))).toBe(
        "ND409:name_display_locked",
      );
      await owner("UPDATE enrollment SET status = 'declined' WHERE id = $1", [pending.enrollment]);
      expect(await failure(setNames(event.id, "both", "everyone"))).toBe("none");
    });

    it("leaves rehearsal accounts and operators out, and lets an event whose players were all told widen again", async () => {
      const event = await newEvent();
      const field = await addField(event.id);
      await member(event.id, field, { notice: null, via: "rehearsal" });
      await member(event.id, field, { notice: null, via: "operator" });
      expect(await failure(setNames(event.id, "both", "everyone"))).toBe("none");
      await member(event.id, field, { notice: "everyone" });
      await setNames(event.id, "both", "staff");
      expect(await failure(setNames(event.id, "both", "everyone"))).toBe("none");
      await member(event.id, field, { notice: "staff" });
      await setNames(event.id, "username", "staff");
      expect(await failure(setNames(event.id, "full_name", "everyone"))).toBe(
        "ND409:name_display_locked",
      );
    });

    it("does not stop the trusted owner connection", async () => {
      const event = await newEvent();
      const field = await addField(event.id);
      await member(event.id, field, { notice: null });
      await owner(
        "UPDATE event SET name_display = 'both', name_audience = 'everyone' WHERE id = $1",
        [event.id],
      );
      expect(await owner("SELECT name_audience FROM event WHERE id = $1", [event.id])).toEqual([
        { name_audience: "everyone" },
      ]);
    });
  });

  describe("the notice a join records", () => {
    it("keeps the audience the card showed, and nothing when the card said nothing", async () => {
      const event = await newEvent();
      const field = await addField(event.id);
      const quiet = await newPlayer();
      const [first] = await join(quiet, event.code, { [field]: "Sara Ahmed" });
      expect(first?.outcome).toBe("joined");
      await as({ playerId: quiet }, "SELECT join_name_notice($1, NULL)", [first?.enrollment_id]);
      expect(await noticeOf(first?.enrollment_id ?? null)).toEqual({ name_notice: null });

      const shown = await newEvent();
      const shownField = await addField(shown.id);
      await setNames(shown.id, "both", "everyone");
      const player = await newPlayer();
      const [second] = await join(player, shown.code, { [shownField]: "Omar Ali" });
      await as({ playerId: player }, "SELECT join_name_notice($1, 'everyone')", [
        second?.enrollment_id,
      ]);
      expect(await noticeOf(second?.enrollment_id ?? null)).toEqual({ name_notice: "everyone" });
    });

    it("refuses a notice that is not the event's now, and says what it must be", async () => {
      const event = await newEvent();
      const field = await addField(event.id);
      await setNames(event.id, "full_name", "everyone");
      const player = await newPlayer();
      const [joined] = await join(player, event.code, { [field]: "Sara Ahmed" });
      const attempt = (shown: string | null) =>
        failure(
          as({ playerId: player }, "SELECT join_name_notice($1, $2)", [
            joined?.enrollment_id,
            shown,
          ]),
        );
      expect(await attempt(null)).toBe("NN409:full_name/everyone/answers");
      expect(await attempt("staff")).toBe("NN409:full_name/everyone/answers");
      expect(await attempt("nobody")).toBe("NN409:full_name/everyone/answers");
      expect(await attempt("everyone")).toBe("none");
      await owner("UPDATE event SET name_display = 'both', name_audience = 'staff' WHERE id = $1", [
        event.id,
      ]);
      expect(await attempt("everyone")).toBe("NN409:both/staff/answers");
      expect(await attempt("staff")).toBe("none");
      expect(await noticeOf(joined?.enrollment_id ?? null)).toEqual({ name_notice: "staff" });
    });

    it("keeps nobody else's enrollment and only an active or pending one", async () => {
      const event = await newEvent();
      const field = await addField(event.id);
      await setNames(event.id, "both", "everyone");
      const mine = await member(event.id, field, { notice: null });
      const other = await member(event.id, field, { notice: null });
      const attempt = (reader: string, enrollment: string, shown: string | null) =>
        failure(as({ playerId: reader }, "SELECT join_name_notice($1, $2)", [enrollment, shown]));
      expect(await attempt(mine.player, other.enrollment, "everyone")).toBe("42501");
      expect(await attempt(await newPlayer(), mine.enrollment, "everyone")).toBe("42501");
      expect(
        await failure(as({}, "SELECT join_name_notice($1, 'everyone')", [mine.enrollment])),
      ).toBe("42501");
      await owner("UPDATE enrollment SET status = 'left' WHERE id = $1", [mine.enrollment]);
      expect(await attempt(mine.player, mine.enrollment, "everyone")).toBe("42501");
      expect(await noticeOf(other.enrollment)).toEqual({ name_notice: null });
    });

    it("replaces the notice when a player who left joins again", async () => {
      const event = await newEvent();
      const field = await addField(event.id);
      await setNames(event.id, "both", "everyone");
      const player = await newPlayer();
      const [first] = await join(player, event.code, { [field]: "Sara Ahmed" });
      await as({ playerId: player }, "SELECT join_name_notice($1, 'everyone')", [
        first?.enrollment_id,
      ]);
      await owner("UPDATE enrollment SET status = 'left' WHERE id = $1", [first?.enrollment_id]);
      await owner("UPDATE event SET name_display = 'username' WHERE id = $1", [event.id]);
      const [again] = await join(player, event.code, { [field]: "Sara Ahmed" });
      expect(again).toMatchObject({ outcome: "joined", enrollment_id: first?.enrollment_id });
      await as({ playerId: player }, "SELECT join_name_notice($1, NULL)", [again?.enrollment_id]);
      expect(await noticeOf(again?.enrollment_id ?? null)).toEqual({ name_notice: null });
    });
  });

  describe("what another player may read", () => {
    it("gives a full name only for an active player told it would show to everyone, who gave one", async () => {
      const event = await newEvent();
      const field = await addField(event.id);
      await setNames(event.id, "both", "everyone");
      const told = await member(event.id, field, { notice: "everyone", name: "Sara Ahmed" });
      const staffOnly = await member(event.id, field, { notice: "staff", name: "Khalid Omar" });
      const untold = await member(event.id, field, { notice: null, name: "Layla Hassan" });
      const noName = await member(event.id, field, { notice: "everyone", name: null });
      const left = await member(event.id, field, {
        notice: "everyone",
        name: "Nora Saleh",
        status: "left",
      });
      const reader = await member(event.id, field, { notice: null });
      const all = [told, staffOnly, untold, noName, left, reader].map((one) => one.enrollment);
      expect(await namesSeenBy(reader.player, event.id, all)).toEqual([
        { enrollment_id: told.enrollment, full_name: "Sara Ahmed" },
      ]);
      // The same rows for a player who is not the subject, whoever else is asked about.
      expect(await namesSeenBy(told.player, event.id, [untold.enrollment])).toEqual([]);
    });

    it("gives none while only the staff are to see the name, or the event shows usernames", async () => {
      const event = await newEvent();
      const field = await addField(event.id);
      const told = await member(event.id, field, { notice: "everyone", name: "Sara Ahmed" });
      const reader = await member(event.id, field, { notice: null });
      for (const [display, audience] of [
        ["username", "everyone"],
        ["username", "staff"],
        ["both", "staff"],
        ["full_name", "staff"],
      ] as const) {
        await owner("UPDATE event SET name_display = $2, name_audience = $3 WHERE id = $1", [
          event.id,
          display,
          audience,
        ]);
        expect(
          await namesSeenBy(reader.player, event.id, [told.enrollment]),
          `${display}/${audience}`,
        ).toEqual([]);
      }
    });

    it("answers a stranger, an outsider and another event's player with a refusal, never a name", async () => {
      const event = await newEvent();
      const other = await newEvent();
      const field = await addField(event.id);
      await setNames(event.id, "both", "everyone");
      const told = await member(event.id, field, { notice: "everyone", name: "Sara Ahmed" });
      const stranger = await newPlayer();
      const elsewhere = await member(other.id, null);
      const ask = (context: RequestContext) =>
        failure(
          as(context, "SELECT * FROM ranking_names($1, $2::uuid[])", [event.id, [told.enrollment]]),
        );
      expect(await ask({ playerId: stranger })).toBe("QR403");
      expect(await ask({ playerId: elsewhere.player })).toBe("QR403");
      expect(await ask({})).toBe("QR403");
      expect(await ask(teamA())).toBe("QR403");
      const asked = await as(
        { playerId: (await member(event.id, field)).player },
        "SELECT * FROM ranking_names($1, $2::uuid[])",
        [other.id, [told.enrollment]],
      ).catch(() => "refused");
      expect(asked).toBe("refused");
    });

    it("tells a reader how the event names players, and nobody else", async () => {
      const event = await newEvent();
      const field = await addField(event.id);
      const reader = await member(event.id, field);
      const display = (context: RequestContext) =>
        as<{ display: string | null }>(context, "SELECT player_name_display($1) AS display", [
          event.id,
        ]);
      expect(await display({ playerId: reader.player })).toEqual([{ display: "username" }]);
      await setNames(event.id, "both", "staff");
      expect(await display({ playerId: reader.player })).toEqual([{ display: "username" }]);
      await owner("UPDATE event SET name_audience = 'everyone' WHERE id = $1", [event.id]);
      expect(await display({ playerId: reader.player })).toEqual([{ display: "both" }]);
      await owner("UPDATE event SET name_display = 'full_name' WHERE id = $1", [event.id]);
      expect(await display({ playerId: reader.player })).toEqual([{ display: "full_name" }]);
      expect(await display({ playerId: await newPlayer() })).toEqual([{ display: null }]);
      expect(await display({})).toEqual([{ display: null }]);
    });

    it("gives the first 60 characters of a long name, so a row stays one line", async () => {
      const event = await newEvent();
      const field = await addField(event.id);
      await setNames(event.id, "full_name", "everyone");
      const told = await member(event.id, field, { notice: "everyone", name: "N".repeat(150) });
      const reader = await member(event.id, field);
      const [seen] = await namesSeenBy(reader.player, event.id, [told.enrollment]);
      expect(seen?.full_name).toBe("N".repeat(60));
    });

    it.each([
      ["a direction override", "Sara \u202EdemhA\u202C", "Sara demhA"],
      ["zero-width characters and joiners", "Sa\u200Bra\u200F Ah\u200Dmed\u2066", "Sara Ahmed"],
      ["the byte-order mark and an isolate", "\uFEFF\u2067Sara\u2069", "Sara"],
      ["runs of spaces", "Sara     Ahmed", "Sara Ahmed"],
    ])("cleans %s out of the name", async (_label, typed, shown) => {
      const event = await newEvent();
      const field = await addField(event.id);
      await setNames(event.id, "both", "everyone");
      const told = await member(event.id, field, { notice: "everyone", name: typed });
      const reader = await member(event.id, field);
      expect(await namesSeenBy(reader.player, event.id, [told.enrollment])).toEqual([
        { enrollment_id: told.enrollment, full_name: shown },
      ]);
    });

    it("shows the username for a name made only of invisible characters", async () => {
      const event = await newEvent();
      const field = await addField(event.id);
      await setNames(event.id, "both", "everyone");
      const told = await member(event.id, field, {
        notice: "everyone",
        name: "\u200B\u202E\u200F\uFEFF",
      });
      const reader = await member(event.id, field);
      expect(await namesSeenBy(reader.player, event.id, [told.enrollment])).toEqual([]);
    });

    it.each([
      ["a letter in front of its mark", "N".repeat(59) + "e\u0301x", "N".repeat(59)],
      ["a letter and its mark that fit", "N".repeat(58) + "e\u0301x", "N".repeat(58) + "e\u0301"],
      ["an emoji on the last place", "N".repeat(59) + "\u{1F600}x", "N".repeat(59) + "\u{1F600}"],
    ])("cuts at 60 characters without splitting %s", async (_label, typed, shown) => {
      const event = await newEvent();
      const field = await addField(event.id);
      await setNames(event.id, "both", "everyone");
      const told = await member(event.id, field, { notice: "everyone", name: typed });
      const reader = await member(event.id, field);
      expect(await namesSeenBy(reader.player, event.id, [told.enrollment])).toEqual([
        { enrollment_id: told.enrollment, full_name: shown },
      ]);
    });

    it("is gone with the answer: an erased answer leaves the username", async () => {
      const event = await newEvent();
      const field = await addField(event.id);
      await setNames(event.id, "both", "everyone");
      const told = await member(event.id, field, { notice: "everyone", name: "Sara Ahmed" });
      const reader = await member(event.id, field);
      expect(await namesSeenBy(reader.player, event.id, [told.enrollment])).toHaveLength(1);
      await owner("DELETE FROM join_answer WHERE enrollment_id = $1", [told.enrollment]);
      expect(await namesSeenBy(reader.player, event.id, [told.enrollment])).toEqual([]);
    });
  });

  describe("what the staff may read", () => {
    it("shows an operator the full name of the player scanned whenever the event shows full names", async () => {
      const event = await newEvent();
      const field = await addField(event.id);
      const { operator, quest } = await station(event.id);
      const scanned = await member(event.id, field, { notice: null, name: "Sara Ahmed" });
      const subject = () =>
        as<{ username: string; full_name: string | null }>(
          { playerId: operator },
          "SELECT username, full_name FROM operator_scan_subject($1, $2)",
          [quest, scanned.player],
        );
      expect((await subject())[0]?.full_name).toBeNull();
      for (const [display, audience] of [
        ["full_name", "staff"],
        ["both", "staff"],
        ["both", "everyone"],
      ] as const) {
        await owner("UPDATE event SET name_display = $2, name_audience = $3 WHERE id = $1", [
          event.id,
          display,
          audience,
        ]);
        expect((await subject())[0]?.full_name, `${display}/${audience}`).toBe("Sara Ahmed");
      }
      await owner("UPDATE event SET name_display = 'username' WHERE id = $1", [event.id]);
      expect((await subject())[0]?.full_name).toBeNull();
    });

    it("shows nothing to a player who is not an operator of the event", async () => {
      const event = await newEvent();
      const field = await addField(event.id);
      const { quest } = await station(event.id);
      await owner("UPDATE event SET name_display = 'both', name_audience = 'staff' WHERE id = $1", [
        event.id,
      ]);
      const scanned = await member(event.id, field, { name: "Sara Ahmed" });
      const rows = await as(
        { playerId: (await member(event.id, field)).player },
        "SELECT * FROM operator_scan_subject($1, $2)",
        [quest, scanned.player],
      );
      expect(rows).toEqual([]);
    });

    it("shows nothing to an operator whose scanning is off (0189)", async () => {
      const event = await newEvent();
      const field = await addField(event.id);
      const { operator, quest } = await station(event.id);
      await setNames(event.id, "both", "staff");
      const scanned = await member(event.id, field, { name: "Sara Ahmed" });
      const subject = () =>
        as({ playerId: operator }, "SELECT username FROM operator_scan_subject($1, $2)", [
          quest,
          scanned.player,
        ]);
      expect(await subject()).toHaveLength(1);
      await owner(
        "UPDATE staff_assignment SET abilities = '{hand_over,award}' WHERE player_id = $1",
        [operator],
      );
      expect(await subject()).toEqual([]);
    });

    it("shows nothing for a quest outside the operator's quest limit, and the subject within it (0189)", async () => {
      const event = await newEvent();
      const field = await addField(event.id);
      const { operator, quest } = await station(event.id);
      const { quest: other } = await station(event.id);
      const scanned = await member(event.id, field, { name: "Sara Ahmed" });
      const subject = (target: string) =>
        as({ playerId: operator }, "SELECT username FROM operator_scan_subject($1, $2)", [
          target,
          scanned.player,
        ]);
      await owner(
        `INSERT INTO staff_assignment_quest (assignment_id, event_id, quest_id)
         SELECT id, event_id, $2 FROM staff_assignment WHERE player_id = $1`,
        [operator, quest],
      );
      expect(await subject(quest)).toHaveLength(1);
      expect(await subject(other)).toEqual([]);
    });

    it("cleans the name the staff read the same way", async () => {
      const event = await newEvent();
      const field = await addField(event.id);
      const { operator, quest } = await station(event.id);
      await setNames(event.id, "both", "staff");
      const scanned = await member(event.id, field, { name: "Sara \u202EdemhA\u200B" });
      const [seen] = await as<{ full_name: string | null }>(
        { playerId: operator },
        "SELECT full_name FROM operator_scan_subject($1, $2)",
        [quest, scanned.player],
      );
      expect(seen?.full_name).toBe("Sara demhA");
    });

    it("shows the name of an active or pending player only: others show by username to the staff too", async () => {
      const event = await newEvent();
      const field = await addField(event.id);
      const { operator, quest } = await station(event.id);
      await setNames(event.id, "both", "staff");
      const nameFor = async (status: string) => {
        const one = await member(event.id, field, { name: "Sara Ahmed", status });
        const [seen] = await as<{ username: string; full_name: string | null }>(
          { playerId: operator },
          "SELECT username, full_name FROM operator_scan_subject($1, $2)",
          [quest, one.player],
        );
        const [named] = await as<{ name: string | null }>(
          { playerId: operator },
          "SELECT desk_full_name($1, $2) AS name",
          [event.id, seen?.username ?? ""],
        );
        return [seen?.full_name ?? null, named?.name ?? null];
      };
      expect(await nameFor("active")).toEqual(["Sara Ahmed", "Sara Ahmed"]);
      expect(await nameFor("pending")).toEqual(["Sara Ahmed", "Sara Ahmed"]);
      for (const status of ["left", "removed", "banned"]) {
        expect(await nameFor(status), status).toEqual([null, null]);
      }
    });

    it("gives the prize desk the full name of a player found by username, to a desk operator only", async () => {
      const event = await newEvent();
      const field = await addField(event.id);
      const { operator } = await station(event.id);
      const found = await member(event.id, field, { name: "Sara Ahmed" });
      const [named] = await owner<{ username: string }>(
        "SELECT username FROM player WHERE id = $1",
        [found.player],
      );
      const desk = (player: string, username: string) =>
        as<{ name: string | null }>({ playerId: player }, "SELECT desk_full_name($1, $2) AS name", [
          event.id,
          username,
        ]);
      expect(await desk(operator, named?.username ?? "")).toEqual([{ name: null }]);
      await setNames(event.id, "full_name", "staff");
      expect(await desk(operator, (named?.username ?? "").toUpperCase())).toEqual([
        { name: "Sara Ahmed" },
      ]);
      expect(await desk(operator, "nobody_here")).toEqual([{ name: null }]);
      expect(await failure(desk(found.player, named?.username ?? ""))).toBe("OP403");
      await owner(
        "UPDATE staff_assignment SET abilities = ARRAY['scan_quests'] WHERE player_id = $1",
        [operator],
      );
      expect(await failure(desk(operator, named?.username ?? ""))).toBe("OA403");
    });
  });

  describe("the guard on the setting and the readers of a name", () => {
    it("holds any login but the one that owns the guard, whatever the app's role is called", async () => {
      const event = await newEvent();
      const role = `questify_renamed_${randomBytes(6).toString("hex")}`;
      await owner(`CREATE ROLE ${role} NOLOGIN IN ROLE questify_app`);
      try {
        const attempt = failure(
          withRequestContext(db.owner, teamA(), async () => {
            await db.owner.query(`SET LOCAL SESSION AUTHORIZATION ${role}`);
            await db.owner.query("UPDATE event SET name_display = 'full_name' WHERE id = $1", [
              event.id,
            ]);
          }),
        );
        expect(await attempt).toBe("ND422:full_name_field");
      } finally {
        await owner(`DROP ROLE ${role}`);
      }
      expect(await owner("SELECT name_display FROM event WHERE id = $1", [event.id])).toEqual([
        { name_display: "username" },
      ]);
    });

    it("tells a team whether a player who was not told is in its own event, and no other team", async () => {
      const event = await newEvent();
      const field = await addField(event.id);
      const locked = (team: RequestContext) =>
        as<{ locked: boolean }>(team, "SELECT event_names_locked($1) AS locked", [event.id]);
      expect(await locked(teamA())).toEqual([{ locked: false }]);
      await member(event.id, field, { notice: null, via: "rehearsal" });
      expect(await locked(teamA())).toEqual([{ locked: false }]);
      const untold = await member(event.id, field, { notice: "staff" });
      expect(await locked(teamA())).toEqual([{ locked: true }]);
      expect(await locked(teamB())).toEqual([{ locked: false }]);
      await owner("UPDATE enrollment SET name_notice = 'everyone' WHERE id = $1", [
        untold.enrollment,
      ]);
      expect(await locked(teamA())).toEqual([{ locked: false }]);
    });

    it("is read by no function beyond the doors that need it", async () => {
      const callers = await owner<{ proname: string }>(
        `SELECT p.proname FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
         WHERE s.nspname = 'public' AND p.prosrc ~ '(public|staff)_full_name|full_name_part|display_name_text'
         ORDER BY p.proname`,
      );
      expect(callers.map((row) => row.proname)).toEqual([
        "desk_full_name",
        "event_results",
        "full_name_part",
        "operator_scan_subject",
        "public_full_name",
        "ranking_names",
        "screen_finale",
        "screen_ranking",
        "session_check_in",
        "staff_full_name",
      ]);
    });
  });
});
