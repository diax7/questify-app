import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "#src/db/context";
import { newRehearsalCode } from "#src/rehearsal/rehearsal";
import { TEST_DATABASE_URL, addMember } from "#test/support/test-db";
import { pushFixture, type PushFixture } from "#test/support/push";

type Answer = { outcome: string; walkIn?: boolean; points?: number };
type Entry = {
  id: string;
  kind: string;
  score_delta: string;
  balance_delta: string;
  operator_id: string | null;
  session_id: string | null;
};

const minutes = (count: number): string => new Date(Date.now() + count * 60_000).toISOString();

/** A call's SQLSTATE and detail ("PS409:has_attendance"), or "none". */
const refusal = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "none",
    (error: { code?: string; detail?: string }) =>
      error.detail === undefined || error.detail === ""
        ? `${error.code}`
        : `${error.code}:${error.detail}`,
  );

/**
 * A session's points on check-in and the session bulk target (T-505b, migration 0093; plan
 * docs/plans/2026-10-31-t-505b-t-602c-points-doors.md, ADR-382): the door pays once per player and session (the pair is
 * the key), only while the player may play and the agenda is on; removal never opens a second payment; the races end in
 * a known answer; the bulk target reaches the session's attendees through the award's own filter.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("session points (database)", () => {
  let f: PushFixture;
  let event: string;
  let editor: string;
  beforeAll(async () => {
    f = await pushFixture();
    event = await f.newEvent({ phase: "live" });
    editor = await addMember(f.db.owner, f.ids.orgA, "editor");
  });
  afterAll(async () => {
    await f.close();
  });

  const make = async (points: number, over: Record<string, unknown> = {}, target = event) => {
    const [row] = await f.run<{ r: { id: string } }>(
      f.team(),
      "SELECT session_save($1, $2::jsonb, NULL, $3) AS r",
      [
        target,
        JSON.stringify({
          kind: "talk",
          titleEn: "Keynote",
          titleAr: "الافتتاح",
          startsAt: minutes(10),
          endsAt: minutes(70),
          access: "open",
          points,
          ...over,
        }),
        randomUUID(),
      ],
    );
    return row?.r.id ?? "";
  };
  const member = async (target = event, via: string | null = null) => {
    const who = await f.newPlayer();
    const enrollment = await f.join(target, who, via);
    return { who, enrollment };
  };
  const operator = async (target = event) => {
    const who = await f.newPlayer();
    await f.owner(
      `INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities)
       SELECT organizer_id, id, $2, '{scan_quests}' FROM event WHERE id = $1`,
      [target, who],
    );
    return who;
  };
  const checkIn = async (op: string, session: string, scanned: string) =>
    (
      await f.run<{ r: Answer }>({ playerId: op }, "SELECT session_check_in($1, $2, 1) AS r", [
        session,
        scanned,
      ])
    )[0]?.r;
  const entries = (enrollment: string) =>
    f.owner<Entry>(
      `SELECT id, kind, score_delta, balance_delta, operator_id, session_id FROM ledger_entry
       WHERE enrollment_id = $1 ORDER BY id`,
      [enrollment],
    );
  const scoreOf = async (enrollment: string) =>
    (
      await f.owner<{ score: string; balance: string }>(
        "SELECT score, balance FROM enrollment WHERE id = $1",
        [enrollment],
      )
    )[0];
  const remove = (entry: string, seat: RequestContext = f.team()) =>
    f.run(seat, "SELECT * FROM remove_award($1, $2, 'Not there', $3, $4)", [
      event,
      entry,
      randomUUID(),
      randomUUID(),
    ]);
  const bulk = (session: string, amount: number, key = randomUUID(), seat = f.team()) =>
    f.run<{ bulk_id: string; awarded: number; skipped: number; replayed: boolean }>(
      seat,
      "SELECT * FROM bulk_award($1, NULL, NULL, $2, $3, 'Thanks for coming', $4, $5)",
      [event, session, amount, key, randomUUID()],
    );
  const preview = async (session: string) =>
    (
      await f.run<{ r: { count: number; earlier: number } }>(
        f.team(),
        "SELECT session_bulk_count($1, $2) AS r",
        [event, session],
      )
    )[0]?.r;
  const setFeature = (target: string, on: boolean) =>
    f.owner(
      `UPDATE event SET config = jsonb_set(config, '{features}', coalesce(config -> 'features', '{}')
         || jsonb_build_object('agenda', $2::boolean)) WHERE id = $1`,
      [target, on],
    );

  describe("the door pays", () => {
    it("pays the session's points once, as the operator, without XP, streak or cap", async () => {
      const session = await make(50);
      const { who, enrollment } = await member();
      const op = await operator();
      await f.owner("DELETE FROM ranking_repair WHERE event_id = $1", [event]);
      expect(await checkIn(op, session, who)).toMatchObject({ outcome: "checked_in", points: 50 });
      expect(await entries(enrollment)).toEqual([
        expect.objectContaining({
          kind: "session",
          score_delta: "50",
          balance_delta: "50",
          operator_id: op,
          session_id: session,
        }),
      ]);
      expect(await scoreOf(enrollment)).toEqual({ score: "50", balance: "50" });
      expect(await checkIn(op, session, who)).toMatchObject({ outcome: "already", points: 50 });
      expect(await entries(enrollment)).toHaveLength(1);
      expect(await f.count("ranking_repair WHERE event_id = $1", [event])).toBe(1);
      expect(await f.count("xp_entry WHERE player_id = $1", [who])).toBe(0);
      expect(await f.count("event_streak_day WHERE enrollment_id = $1", [enrollment])).toBe(0);
      const [today] = await f.owner<{ n: string }>(
        "SELECT awarded_today(e, $2, NULL) AS n FROM event e WHERE e.id = $1",
        [event, op],
      );
      expect(today?.n).toBe("0");
    });

    it("writes no entry for a session without points", async () => {
      const session = await make(0);
      const { who, enrollment } = await member();
      expect(await checkIn(await operator(), session, who)).toMatchObject({
        outcome: "checked_in",
        points: 0,
      });
      expect(await entries(enrollment)).toEqual([]);
    });

    it("checks in a staff member who may not play with 0 points", async () => {
      const session = await make(30);
      const { who, enrollment } = await member();
      await f.owner(
        `INSERT INTO staff_assignment (organizer_id, event_id, player_id, can_play)
         SELECT organizer_id, id, $2, false FROM event WHERE id = $1`,
        [event, who],
      );
      expect(await checkIn(await operator(), session, who)).toMatchObject({
        outcome: "checked_in",
        points: 0,
      });
      expect(await entries(enrollment)).toEqual([]);
    });

    it("a removed payment is never paid again: the re-scan answers 0 and attendance stays", async () => {
      const session = await make(40);
      const { who, enrollment } = await member();
      const op = await operator();
      await checkIn(op, session, who);
      const [paid] = await entries(enrollment);
      await remove(paid?.id ?? "");
      const after = await entries(enrollment);
      expect(after).toHaveLength(2);
      expect(after[1]).toMatchObject({ kind: "removal", score_delta: "-40", session_id: session });
      expect(await f.count("xp_entry WHERE player_id = $1", [who])).toBe(0);
      expect(await checkIn(op, session, who)).toMatchObject({ outcome: "already", points: 0 });
      expect(await entries(enrollment)).toHaveLength(2);
      expect(await f.count("session_attendance WHERE session_id = $1", [session])).toBe(1);
    });

    it("names the session on the player's history and the team's ledger, the removal too", async () => {
      const session = await make(20, { titleEn: "Closing talk", titleAr: "الختام" });
      const { who, enrollment } = await member();
      await checkIn(await operator(), session, who);
      const ledger = () =>
        f.run<{ kind: string; title_en: string; removable: boolean; removed: boolean }>(
          f.team(),
          "SELECT kind, title_en, removable, removed FROM member_ledger($1, $2, NULL, 50)",
          [event, enrollment],
        );
      expect(await ledger()).toEqual([
        { kind: "session", title_en: "Closing talk", removable: true, removed: false },
      ]);
      const [paid] = await entries(enrollment);
      await remove(paid?.id ?? "");
      expect(await ledger()).toEqual([
        { kind: "removal", title_en: "Closing talk", removable: false, removed: false },
        { kind: "session", title_en: "Closing talk", removable: false, removed: true },
      ]);
      const history = await f.run<{ kind: string; title_ar: string; title_en: string }>(
        { playerId: who },
        "SELECT kind, title_ar, title_en FROM member_activity($1, NULL, 25)",
        [event],
      );
      expect(history).toEqual([
        { kind: "removal", title_ar: "الختام", title_en: "Closing talk" },
        { kind: "session", title_ar: "الختام", title_en: "Closing talk" },
      ]);
    });
  });

  describe("the door refuses", () => {
    it("refuses outside the play phase and while the agenda is off", async () => {
      const scheduled = await f.newEvent({ phase: "scheduled" });
      const early = await make(
        10,
        { startsAt: minutes(60 * 30), endsAt: minutes(60 * 31) },
        scheduled,
      );
      await f.owner("UPDATE event_session SET starts_at = $2, ends_at = $3 WHERE id = $1", [
        early,
        minutes(10),
        minutes(70),
      ]);
      const real = await member(scheduled);
      expect(await refusal(checkIn(await operator(scheduled), early, real.who))).toBe(
        "QN403:event_not_live",
      );
      const session = await make(10);
      const { who } = await member();
      const op = await operator();
      await setFeature(event, false);
      try {
        expect(await refusal(checkIn(op, session, who))).toBe("AG403:feature_off");
        expect(
          await refusal(f.run({ playerId: op }, "SELECT operator_sessions($1)", [event])),
        ).toBe("AG403:feature_off");
      } finally {
        await setFeature(event, true);
      }
      await f.owner("UPDATE player SET status = 'banned' WHERE id = $1", [who]);
      expect(await refusal(checkIn(op, session, who))).toBe("QC403:account");
    });

    it("refuses an ended and an archived event", async () => {
      for (const status of ["ended", "archived"] as const) {
        const over = await f.newEvent({ phase: "live" });
        const session = await make(10, {}, over);
        const { who } = await member(over);
        const op = await operator(over);
        await f.owner(
          status === "ended"
            ? "UPDATE event SET ends_at = now() - interval '1 minute' WHERE id = $1"
            : "UPDATE event SET status = 'archived' WHERE id = $1",
          [over],
        );
        expect(await refusal(checkIn(op, session, who)), status).toBe("QN403:event_not_live");
      }
    });

    it("pays a rehearsal account before go-live, and the go-live wipe takes it", async () => {
      const draft = await f.newEvent({ phase: "scheduled" });
      const session = await make(
        15,
        { startsAt: minutes(60 * 30), endsAt: minutes(60 * 31) },
        draft,
      );
      await f.owner("UPDATE event_session SET starts_at = $2, ends_at = $3 WHERE id = $1", [
        session,
        minutes(10),
        minutes(70),
      ]);
      const [opened] = await f.run<{ code: string }>(
        f.team(),
        "SELECT open_rehearsal($1, $2) AS code",
        [draft, newRehearsalCode()],
      );
      const tester = await f.newPlayer();
      const [joined] = await f.run<{ enrollment_id: string }>(
        { playerId: tester },
        "SELECT * FROM join_rehearsal($1, '1')",
        [opened?.code],
      );
      const op = await operator(draft);
      expect(await checkIn(op, session, tester)).toMatchObject({
        outcome: "checked_in",
        points: 15,
      });
      expect(await entries(joined?.enrollment_id ?? "")).toHaveLength(1);
      await f.owner("UPDATE event SET status = 'live' WHERE id = $1", [draft]);
      await f.run({}, "SELECT ensure_rehearsal_wiped($1)", [draft]);
      expect(await f.count("ledger_entry WHERE session_id = $1", [session])).toBe(0);
      expect(await f.count("session_attendance WHERE session_id = $1", [session])).toBe(0);
      expect(
        await f.run<{ n: number }>(f.team(), "SELECT session_delete($1, $2, $3) AS n", [
          draft,
          session,
          randomUUID(),
        ]),
      ).toEqual([{ n: 0 }]);
    });

    it("keeps a paid session and refuses an archived event's delete", async () => {
      const session = await make(5);
      const { who } = await member();
      await checkIn(await operator(), session, who);
      expect(
        await refusal(
          f.run(f.team(), "SELECT session_delete($1, $2, $3)", [event, session, randomUUID()]),
        ),
      ).toBe("PS409:has_attendance");
      const archived = await f.newEvent({ phase: "live" });
      const gone = await make(0, {}, archived);
      await f.owner("UPDATE event SET status = 'archived' WHERE id = $1", [archived]);
      expect(
        await refusal(
          f.run(f.team(), "SELECT session_delete($1, $2, $3)", [archived, gone, randomUUID()]),
        ),
      ).toBe("PE409:event_closed");
    });

    it("refuses cancelling a registration once checked in", async () => {
      const session = await make(5, { access: "registration", startsAt: minutes(30) });
      const { who } = await member();
      await f.run({ playerId: who }, "SELECT session_register($1, $2, false)", [event, session]);
      await checkIn(await operator(), session, who);
      expect(
        await refusal(f.run({ playerId: who }, "SELECT session_cancel($1, $2)", [event, session])),
      ).toBe("PS409:checked_in");
    });

    it("audits a change of the points with the value before and after", async () => {
      const session = await make(10);
      await f.run(f.team(), "SELECT session_save($1, $2::jsonb, $3, $4)", [
        event,
        JSON.stringify({
          kind: "talk",
          titleEn: "Keynote",
          startsAt: minutes(10),
          endsAt: minutes(70),
          access: "open",
          points: 25,
        }),
        session,
        randomUUID(),
      ]);
      const [row] = await f.owner<{ before: unknown; after: Record<string, unknown> }>(
        `SELECT before, after FROM audit_log WHERE action = 'session.save' AND target_id = $1
         ORDER BY id DESC LIMIT 1`,
        [session],
      );
      expect(row?.before).toEqual({ points: 10 });
      expect(row?.after).toMatchObject({ created: false, points: 25 });
    });
  });

  describe("races (two connections at once)", () => {
    it("two operators scanning one player: one pays, the other answers the same points", async () => {
      const session = await make(60);
      const { who, enrollment } = await member();
      const sql = "SELECT session_check_in($1, $2, 1) AS r";
      const result = await f.crossed(
        { context: { playerId: await operator() }, sql, values: [session, who] },
        { context: { playerId: await operator() }, sql, values: [session, who] },
      );
      expect(result.waited).toBe(true);
      expect(result.first).toMatchObject({ r: { outcome: "checked_in", points: 60 } });
      expect(result.second).toMatchObject({ r: { outcome: "already", points: 60 } });
      expect(await entries(enrollment)).toHaveLength(1);
    });

    it("a check-in and a delete: the delete waits and is refused, or the check-in finds no session", async () => {
      const sql = "SELECT session_check_in($1, $2, 1) AS r";
      const drop = "SELECT session_delete($1, $2, $3)";
      const first = await make(5);
      const one = await member();
      const after = await f.crossed(
        { context: { playerId: await operator() }, sql, values: [first, one.who] },
        { context: f.team(), sql: drop, values: [event, first, randomUUID()] },
      );
      expect(after.waited).toBe(true);
      expect(after.second).toMatchObject({ code: "PS409", detail: "has_attendance" });
      const second = await make(5);
      const two = await member();
      const before = await f.crossed(
        { context: f.team(), sql: drop, values: [event, second, randomUUID()] },
        { context: { playerId: await operator() }, sql, values: [second, two.who] },
      );
      expect(before.waited).toBe(true);
      expect(before.second).toMatchObject({ code: "SS404" });
    });

    it("a check-in waiting on a points edit pays the value the edit committed", async () => {
      const session = await make(10);
      const { who, enrollment } = await member();
      const result = await f.crossed(
        {
          context: f.team(),
          sql: "SELECT session_save($1, $2::jsonb, $3, $4)",
          values: [
            event,
            JSON.stringify({
              kind: "talk",
              titleEn: "Keynote",
              startsAt: minutes(10),
              endsAt: minutes(70),
              access: "open",
              points: 80,
            }),
            session,
            randomUUID(),
          ],
        },
        {
          context: { playerId: await operator() },
          sql: "SELECT session_check_in($1, $2, 1) AS r",
          values: [session, who],
        },
      );
      expect(result.waited).toBe(true);
      expect(result.second).toMatchObject({ r: { outcome: "checked_in", points: 80 } });
      expect((await entries(enrollment))[0]?.score_delta).toBe("80");
    });

    it("a check-in and a cancel never leave an attendance without its registration", async () => {
      const session = await make(5, { access: "registration", startsAt: minutes(30) });
      const sql = "SELECT session_check_in($1, $2, 1) AS r";
      const cancel = "SELECT session_cancel($1, $2)";
      const one = await member();
      await f.run({ playerId: one.who }, "SELECT session_register($1, $2, false)", [
        event,
        session,
      ]);
      const first = await f.crossed(
        { context: { playerId: await operator() }, sql, values: [session, one.who] },
        { context: { playerId: one.who }, sql: cancel, values: [event, session] },
      );
      expect(first.second).toMatchObject({ code: "PS409", detail: "checked_in" });
      const two = await member();
      await f.run({ playerId: two.who }, "SELECT session_register($1, $2, false)", [
        event,
        session,
      ]);
      const second = await f.crossed(
        { context: { playerId: two.who }, sql: cancel, values: [event, session] },
        { context: { playerId: await operator() }, sql, values: [session, two.who] },
      );
      expect(second.waited).toBe(true);
      expect(second.second).toMatchObject({ r: { outcome: "not_registered" } });
    });
  });

  describe("the session bulk target", () => {
    it("reaches the attendees through the award's filter, minus removed payments", async () => {
      const session = await make(10);
      const op = await operator();
      const [kept, removed, staff] = [await member(), await member(), await member()];
      for (const one of [kept, removed, staff]) await checkIn(op, session, one.who);
      await f.owner(
        `INSERT INTO staff_assignment (organizer_id, event_id, player_id, can_play)
         SELECT organizer_id, id, $2, false FROM event WHERE id = $1`,
        [event, staff.who],
      );
      const [paid] = await entries(removed.enrollment);
      await remove(paid?.id ?? "");
      await member();
      expect(await preview(session)).toEqual({ count: 1, earlier: 0 });
      await f.owner("DELETE FROM ranking_repair WHERE event_id = $1", [event]);
      const key = randomUUID();
      const [done] = await bulk(session, 7, key);
      expect(done).toMatchObject({ awarded: 1, skipped: 0, replayed: false });
      expect((await entries(kept.enrollment)).map((row) => row.kind)).toEqual(["session", "award"]);
      expect(await f.count("ranking_repair WHERE event_id = $1", [event])).toBe(1);
      expect(await preview(session)).toEqual({ count: 1, earlier: 1 });
      expect((await bulk(session, 7, key))[0]).toMatchObject({
        bulk_id: done?.bulk_id,
        replayed: true,
      });
      const other = await make(10);
      expect(await refusal(bulk(other, 7, key))).toBe("AK422");
      const [audit] = await f.owner<{ after: Record<string, unknown> }>(
        "SELECT after FROM audit_log WHERE action = 'event.bulk_award' AND target_id = $1",
        [done?.bulk_id],
      );
      expect(audit?.after).toMatchObject({ session, awarded: 1 });
    });

    it("refuses two targets, a session of another event and an editor over the cap", async () => {
      const session = await make(0);
      expect(
        await refusal(
          f.run(f.team(), "SELECT * FROM bulk_award($1, $2, NULL, $3, 5, 'x', $4, $5)", [
            event,
            [randomUUID()],
            session,
            randomUUID(),
            randomUUID(),
          ]),
        ),
      ).toBe("AB400");
      const elsewhere = await make(0, {}, await f.newEvent({ phase: "live" }));
      expect(await refusal(bulk(elsewhere, 5))).toBe("SS404");
      expect(await refusal(preview(elsewhere))).toBe("SS404");
      expect(await refusal(bulk(session, 500, randomUUID(), f.team(editor)))).toBe("AC409:each");
    });

    it("a late check-in during a bulk award: the record's count is what was written, nobody twice", async () => {
      const session = await make(0);
      const op = await operator();
      const early = await member();
      await checkIn(op, session, early.who);
      const late = await member();
      const [result] = await Promise.all([bulk(session, 3), checkIn(op, session, late.who)]);
      const notes = await f.owner<{ enrollment_id: string }>(
        `SELECT l.enrollment_id FROM ledger_note n JOIN ledger_entry l ON l.id = n.entry_id
         WHERE n.bulk_id = $1`,
        [result[0]?.bulk_id],
      );
      expect(notes).toHaveLength(result[0]?.awarded ?? -1);
      expect(new Set(notes.map((row) => row.enrollment_id)).size).toBe(notes.length);
    });
  });
});
