import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "#src/db/context";
import { TEST_DATABASE_URL } from "#test/support/test-db";
import { pushFixture, type PushFixture } from "#test/support/push";

type Item = Record<string, unknown> & { id: string };
type Draft = Record<string, unknown>;

const minutes = (count: number): string => new Date(Date.now() + count * 60_000).toISOString();

const GOOD_MESSAGE = {
  titleAr: "تغيير القاعة",
  titleEn: "Room change",
  bodyAr: "انتقلت الورشة إلى القاعة 3.",
  bodyEn: "The workshop moved to hall 3.",
  pushBodyAr: "انتقلت الورشة إلى القاعة 3.",
  pushBodyEn: "The workshop moved to hall 3.",
};

const workshop = (over: Draft = {}): Draft => ({
  kind: "workshop",
  titleAr: "ورشة الذكاء",
  titleEn: "AI workshop",
  startsAt: minutes(120),
  endsAt: minutes(180),
  access: "registration",
  seats: 2,
  ...over,
});

/** A call's SQLSTATE and detail ("PS409:full"), or "none". */
const refusal = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "none",
    (error: { code?: string; detail?: string }) =>
      error.detail === undefined || error.detail === ""
        ? `${error.code}`
        : `${error.code}:${error.detail}`,
  );

/**
 * Agenda sessions in the database (T-505, migration 0086; plan docs/plans/2026-10-30-t-505-agenda-sessions.md, ADR-373):
 * the team writes sessions inside its event, a player registers while a seat is left (the last seat goes to one of two
 * who press at once), cancelling frees the seat, an overlap is warned and not blocked, the door records attendance, a
 * reminder and a message go to registrants only, and a session without a registration is never offered one.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("sessions (database)", () => {
  let f: PushFixture;
  let event: string;
  beforeAll(async () => {
    f = await pushFixture();
    event = await f.newEvent({ phase: "live" });
  });
  afterAll(async () => {
    await f.close();
  });

  const save = (over: Draft = {}, target: string | null = null, seat: RequestContext = f.team()) =>
    f.run<{ r: Item }>(seat, "SELECT session_save($1, $2::jsonb, $3, $4) AS r", [
      event,
      JSON.stringify(workshop(over)),
      target,
      randomUUID(),
    ]);
  const make = async (over: Draft = {}): Promise<string> => (await save(over))[0]?.r.id ?? "";
  const list = async (seat: RequestContext = f.team()) =>
    (await f.run<{ r: Item[] }>(seat, "SELECT session_list($1) AS r", [event]))[0]?.r ?? [];
  const itemOf = async (id: string) => (await list()).find((row) => row.id === id) as Item;
  const register = (who: string, session: string, confirm = false) =>
    f.run<{ r: Record<string, unknown> }>(
      { playerId: who },
      "SELECT session_register($1, $2, $3) AS r",
      [event, session, confirm],
    );
  const cancel = (who: string, session: string) =>
    f.run({ playerId: who }, "SELECT session_cancel($1, $2)", [event, session]);
  const agenda = async (who: string) =>
    (await f.run<{ r: Item[] }>({ playerId: who }, "SELECT member_sessions($1) AS r", [event]))[0]
      ?.r ?? [];
  const member = async () => {
    const who = await f.newPlayer();
    await f.join(event, who);
    return who;
  };
  const moveStart = (id: string, starts: string, ends: string) =>
    f.owner("UPDATE event_session SET starts_at = $2, ends_at = $3 WHERE id = $1", [
      id,
      starts,
      ends,
    ]);
  const operator = async (extra: Record<string, unknown> = {}) => {
    const who = await f.newPlayer();
    await f.owner(
      `INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities)
       VALUES ($1, $2, $3, $4)`,
      [f.ids.orgA, event, who, extra["abilities"] ?? ["scan_quests"]],
    );
    return who;
  };
  const checkIn = (op: string, session: string, scanned: string, version = 1) =>
    f.run<{ r: { outcome: string; walkIn?: boolean; player: { username: string } } }>(
      { playerId: op },
      "SELECT session_check_in($1, $2, $3) AS r",
      [session, scanned, version],
    );

  const sentTo = async (kind: string) =>
    (
      await f.owner<{ player_id: string; params: Record<string, unknown>; dedupe: string }>(
        "SELECT player_id, params, dedupe FROM notice WHERE event_id = $1 AND kind = $2",
        [event, kind],
      )
    ).map((row) => row);
  const remind = async () =>
    (await f.owner<{ n: number }>("SELECT push_due_session(500) AS n"))[0]?.n ?? 0;

  const importRows = (sent: unknown[]) =>
    f.run<{ n: number }>(f.team(), "SELECT session_import($1, $2::jsonb, $3) AS n", [
      event,
      JSON.stringify(sent),
      randomUUID(),
    ]);

  const bad = async (over: Draft) =>
    refusal(save(over)).then((result) => result.replace(/^PS422:/, ""));

  describe("writing sessions", () => {
    it("saves a session and answers it with its numbers; a title in one language is enough", async () => {
      const [row] = await save({ titleAr: null });
      expect(row?.r).toMatchObject({
        kind: "workshop",
        titleEn: "AI workshop",
        titleAr: null,
        seats: 2,
        registered: 0,
        attended: 0,
        noShows: 0,
        registrationOpen: true,
        reminderMinutes: 15,
      });
    });

    it("refuses a bad field and names it", async () => {
      expect(await bad({ kind: "party" })).toBe("kind");
      expect(await bad({ titleAr: null, titleEn: null })).toBe("title");
      expect(await bad({ endsAt: minutes(100) })).toBe("endsAt:before_start");
      expect(await bad({ endsAt: minutes(120 + 25 * 60) })).toBe("endsAt:too_long");
      expect(
        await bad({ startsAt: minutes(-60 * 24 * 5), endsAt: minutes(-60 * 24 * 5 + 30) }),
      ).toBe("startsAt:outside_event");
      expect(await bad({ startsAt: "tomorrow" })).toBe("startsAt");
      expect(await bad({ access: "paid" })).toBe("access");
      expect(await bad({ seats: 0 })).toBe("seats");
      expect(await bad({ speakers: Array.from({ length: 11 }, () => "A") })).toBe("speakers");
      expect(await bad({ closesAt: minutes(121) })).toBe("closesAt");
      expect(await bad({ questId: randomUUID() })).toBe("questId");
      expect(await bad({ reminderMinutes: 2000 })).toBe("reminderMinutes");
    });

    it("an open session carries no seats and no walk-ins", async () => {
      const [row] = await save({ access: "open", seats: 50, walkIns: true });
      expect(row?.r).toMatchObject({ access: "open", seats: null, walkIns: false });
    });

    it("links a quest of the same event and not one of another", async () => {
      const [quest] = await f.owner<{ id: string }>(
        `INSERT INTO quest (organizer_id, event_id, category_id, type, title_en, points)
         SELECT e.organizer_id, e.id, c.id, 'scan_qr', 'Rate this session', 10
         FROM event e JOIN category c ON c.event_id = e.id WHERE e.id = $1 LIMIT 1 RETURNING id`,
        [event],
      );
      const [row] = await save({ questId: quest?.id });
      expect(row?.r["questId"]).toBe(quest?.id);
      const other = await f.newEvent({ phase: "live", organizer: f.ids.orgB });
      const [foreign] = await f.owner<{ id: string }>(
        `INSERT INTO quest (organizer_id, event_id, category_id, type, title_en, points)
         SELECT e.organizer_id, e.id, c.id, 'scan_qr', 'Other', 10
         FROM event e JOIN category c ON c.event_id = e.id WHERE e.id = $1 LIMIT 1 RETURNING id`,
        [other],
      );
      expect(await refusal(save({ questId: foreign?.id }))).toBe("PS422:questId");
    });

    it("lowering the seats below the registered number is refused naming it; raising works at once", async () => {
      const id = await make({ seats: 5 });
      for (let n = 0; n < 3; n += 1) await register(await member(), id);
      expect(await refusal(save({ seats: 2 }, id))).toBe("PS409:seats_below:3");
      expect(
        await refusal(
          f.run(f.team(), "SELECT session_registration_set($1, $2, true, 2, $3)", [
            event,
            id,
            randomUUID(),
          ]),
        ),
      ).toBe("PS409:seats_below:3");
      const raised = await f.run<{ r: Item }>(
        f.team(),
        "SELECT session_registration_set($1, $2, true, 60, $3) AS r",
        [event, id, randomUUID()],
      );
      expect(raised[0]?.r).toMatchObject({ seats: 60, registered: 3 });
      expect((await agenda(await member())).find((row) => row.id === id)).toMatchObject({
        seatsLeft: 57,
      });
    });

    it("refuses turning a session with registrations into an open one", async () => {
      const id = await make();
      await register(await member(), id);
      expect(await refusal(save({ access: "open" }, id))).toBe("PS409:has_registrations");
    });

    it("an import writes every row or none", async () => {
      const before = (await list()).length;
      const rows = [workshop({ titleEn: "One" }), workshop({ titleEn: "Two" })];
      expect((await importRows(rows))[0]?.n).toBe(2);
      expect(await refusal(importRows([...rows, workshop({ kind: "nope" })]))).toBe("PS422:kind");
      expect((await list()).length).toBe(before + 2);
      expect(await refusal(importRows([]))).toBe("PS422:rows");
    });

    it("deletes a session with its registrations unless someone was checked in", async () => {
      const id = await make();
      const who = await member();
      await register(who, id);
      const gone = await f.run<{ n: number }>(f.team(), "SELECT session_delete($1, $2, $3) AS n", [
        event,
        id,
        randomUUID(),
      ]);
      expect(gone[0]?.n).toBe(1);
      expect((await list()).some((row) => row.id === id)).toBe(false);
      const kept = await make({ startsAt: minutes(30), endsAt: minutes(90) });
      await register(who, kept);
      await checkIn(await operator(), kept, who);
      expect(
        await refusal(
          f.run(f.team(), "SELECT session_delete($1, $2, $3)", [event, kept, randomUUID()]),
        ),
      ).toBe("PS409:has_attendance");
    });
  });

  describe("registering", () => {
    it("the last seat goes to one of two players who press at once", async () => {
      const id = await make({ seats: 1 });
      const [one, two] = [await member(), await member()];
      const results = await Promise.all([register(one, id), register(two, id)].map(refusal));
      expect(results.toSorted()).toEqual(["PS409:full", "none"]);
      expect((await itemOf(id))["registered"]).toBe(1);
    });

    it("shows full, closed and registered states to the player and never another's registration", async () => {
      const id = await make({ seats: 1 });
      const [one, two] = [await member(), await member()];
      await register(one, id);
      const mine = (await agenda(one)).find((row) => row.id === id);
      const theirs = (await agenda(two)).find((row) => row.id === id);
      expect(mine).toMatchObject({ status: "registered", registered: true, seatsLeft: 0 });
      expect(theirs).toMatchObject({ status: "full", registered: false, cancellable: false });
      await f.run(f.team(), "SELECT session_registration_set($1, $2, false, 5, $3)", [
        event,
        id,
        randomUUID(),
      ]);
      expect((await agenda(two)).find((row) => row.id === id)).toMatchObject({ status: "closed" });
      expect(await refusal(register(two, id))).toBe("PS409:closed");
    });

    it("refuses an open session, a started session and registration after the closing time", async () => {
      const open = await make({ access: "open" });
      expect(await refusal(register(await member(), open))).toBe("PS409:not_required");
      const closing = await make({ closesAt: minutes(60) });
      await f.owner(
        "UPDATE event_session SET closes_at = now() - interval '1 minute' WHERE id = $1",
        [closing],
      );
      expect(await refusal(register(await member(), closing))).toBe("PS409:closed");
      const started = await make({ startsAt: minutes(1), endsAt: minutes(60) });
      await moveStart(started, minutes(-5), minutes(55));
      expect(await refusal(register(await member(), started))).toBe("PS409:closed");
    });

    it("registering twice is a retry, not a second seat", async () => {
      const id = await make({ seats: 3 });
      const who = await member();
      await register(who, id);
      expect((await register(who, id))[0]?.r).toMatchObject({
        outcome: "registered",
        replayed: true,
      });
      expect((await itemOf(id))["registered"]).toBe(1);
    });

    it("warns about an overlap without blocking and keeps both when confirmed", async () => {
      const first = await make({ titleEn: "First", startsAt: minutes(300), endsAt: minutes(360) });
      const second = await make({
        titleEn: "Second",
        startsAt: minutes(330),
        endsAt: minutes(390),
      });
      const who = await member();
      await register(who, first);
      const warned = (await register(who, second))[0]?.r as {
        outcome: string;
        overlaps: { id: string; title: { en: string } }[];
      };
      expect(warned.outcome).toBe("overlap");
      expect(warned.overlaps.map((row) => row.title.en)).toEqual(["First"]);
      expect((await agenda(who)).find((row) => row.id === second)?.["registered"]).toBe(false);
      expect((await register(who, second, true))[0]?.r).toMatchObject({ outcome: "registered" });
      expect((await agenda(who)).filter((row) => row["registered"]).length).toBeGreaterThanOrEqual(
        2,
      );
    });

    it("cancelling frees the seat at once and is refused after the start", async () => {
      const id = await make({ seats: 1 });
      const [one, two] = [await member(), await member()];
      await register(one, id);
      await cancel(one, id);
      expect((await itemOf(id))["registered"]).toBe(0);
      await register(two, id);
      await moveStart(id, minutes(-5), minutes(55));
      expect(await refusal(cancel(two, id))).toBe("PS409:started");
    });

    it("only an active member of the event reads the agenda or registers", async () => {
      const id = await make();
      const outsider = await f.newPlayer();
      expect(await refusal(agenda(outsider))).toBe("AM403");
      expect(await refusal(register(outsider, id))).toBe("AM403");
      const elsewhere = await f.newEvent({ phase: "live" });
      const visitor = await f.newPlayer();
      await f.join(elsewhere, visitor);
      expect(
        await refusal(
          f.run({ playerId: visitor }, "SELECT session_register($1, $2, false)", [elsewhere, id]),
        ),
      ).toBe("SS404");
    });

    it("a registration goes with the enrollment (the rehearsal wipe, a deleted account)", async () => {
      const id = await make();
      const who = await member();
      await register(who, id);
      await f.owner("DELETE FROM enrollment WHERE event_id = $1 AND player_id = $2", [event, who]);
      expect((await itemOf(id))["registered"]).toBe(0);
    });
  });

  describe("the door", () => {
    it("records attendance once, shows who was scanned and counts the no-shows", async () => {
      const id = await make({ startsAt: minutes(10), endsAt: minutes(70), seats: 5 });
      const [here, absent] = [await member(), await member()];
      await register(here, id);
      await register(absent, id);
      const op = await operator();
      const first = (await checkIn(op, id, here))[0]?.r;
      expect(first).toMatchObject({ outcome: "checked_in", walkIn: false });
      expect(first?.player.username).toBe(await f.usernameOf(here));
      expect((await checkIn(op, id, here))[0]?.r.outcome).toBe("already");
      await moveStart(id, minutes(-5), minutes(55));
      expect(await itemOf(id)).toMatchObject({
        registered: 2,
        attended: 1,
        walkInCount: 0,
        noShows: 1,
      });
      expect((await agenda(here)).find((row) => row.id === id)?.["checkedIn"]).toBe(true);
    });

    it("a player who did not register is 'not registered' unless the organizer allows walk-ins", async () => {
      const strict = await make({ startsAt: minutes(10), endsAt: minutes(70) });
      const loose = await make({ startsAt: minutes(10), endsAt: minutes(70), walkIns: true });
      const stranger = await member();
      const op = await operator();
      expect((await checkIn(op, strict, stranger))[0]?.r.outcome).toBe("not_registered");
      expect(
        await f.owner("SELECT 1 FROM session_attendance WHERE session_id = $1", [strict]),
      ).toEqual([]);
      expect((await checkIn(op, loose, stranger))[0]?.r).toMatchObject({
        outcome: "checked_in",
        walkIn: true,
      });
      expect(await itemOf(loose)).toMatchObject({ attended: 1, walkInCount: 1 });
    });

    it("an open session checks in any member; the time window runs from an hour before to the end", async () => {
      const op = await operator();
      const who = await member();
      const open = await make({ access: "open", startsAt: minutes(30), endsAt: minutes(90) });
      expect((await checkIn(op, open, who))[0]?.r.outcome).toBe("checked_in");
      const later = await make({ startsAt: minutes(200), endsAt: minutes(260), walkIns: true });
      expect((await checkIn(op, later, who))[0]?.r.outcome).toBe("too_early");
      const over = await make({ startsAt: minutes(30), endsAt: minutes(90), walkIns: true });
      await moveStart(over, minutes(-90), minutes(-30));
      expect((await checkIn(op, over, who))[0]?.r.outcome).toBe("ended");
    });

    it("refuses what the station scan refuses", async () => {
      const id = await make({ startsAt: minutes(10), endsAt: minutes(70), walkIns: true });
      const who = await member();
      const op = await operator();
      expect(await refusal(checkIn(await f.newPlayer(), id, who))).toBe("OP403");
      expect(await refusal(checkIn(await operator({ abilities: ["award"] }), id, who))).toBe(
        "OA403",
      );
      expect(await refusal(checkIn(op, id, op))).toBe("OY409");
      expect(await refusal(checkIn(op, id, who, 7))).toBe("OM422");
      expect(await refusal(checkIn(op, id, await f.newPlayer()))).toBe("QC404");
      expect(await refusal(checkIn(op, randomUUID(), who))).toBe("SS404");
      const limited = await operator();
      const [quest] = await f.owner<{ id: string }>(
        `INSERT INTO quest (organizer_id, event_id, category_id, type, title_en, points)
         SELECT e.organizer_id, e.id, c.id, 'scan_qr', 'Station', 5
         FROM event e JOIN category c ON c.event_id = e.id WHERE e.id = $1 LIMIT 1 RETURNING id`,
        [event],
      );
      await f.owner(
        `INSERT INTO staff_assignment_quest (assignment_id, event_id, quest_id)
         SELECT sa.id, sa.event_id, $2 FROM staff_assignment sa WHERE sa.player_id = $1`,
        [limited, quest?.id],
      );
      expect(await refusal(checkIn(limited, id, who))).toBe("OS403");
      await f.owner(
        "UPDATE enrollment SET status = 'left' WHERE event_id = $1 AND player_id = $2",
        [event, who],
      );
      expect(await refusal(checkIn(op, id, who))).toBe("QC403:left");
    });

    it("an operator of another event cannot check in to this one", async () => {
      const id = await make({ startsAt: minutes(10), endsAt: minutes(70), walkIns: true });
      const elsewhere = await f.newEvent({ phase: "live" });
      const op = await f.newPlayer();
      await f.owner(
        "INSERT INTO staff_assignment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)",
        [f.ids.orgA, elsewhere, op],
      );
      expect(await refusal(checkIn(op, id, await member()))).toBe("OP403");
    });
  });

  describe("pushes to registrants", () => {
    it("reminds each registrant once, at the organizer's time, and never someone who cancelled", async () => {
      const id = await make({ startsAt: minutes(60), endsAt: minutes(120), reminderMinutes: 15 });
      const [kept, left] = [await member(), await member()];
      await register(kept, id);
      await register(left, id);
      await cancel(left, id);
      const before = (await sentTo("session_reminder")).filter((row) => row.dedupe.includes(id));
      await remind();
      expect(
        (await sentTo("session_reminder")).filter((row) => row.dedupe.includes(id)),
      ).toHaveLength(before.length);
      await moveStart(id, minutes(10), minutes(70));
      await remind();
      await remind();
      const rows = (await sentTo("session_reminder")).filter((row) => row.dedupe.includes(id));
      expect(rows.map((row) => row.player_id)).toEqual([kept]);
      expect(rows[0]?.params).toMatchObject({ session: { en: "AI workshop" } });
    });

    it("a message reaches the registrants only, once per key, inside the rate limit", async () => {
      const fresh = await f.newEvent({ phase: "live" });
      const send = (key: string, session: string, seat: RequestContext = f.team()) =>
        f.run<{ id: string; recipients: number; replayed: boolean }>(
          seat,
          "SELECT * FROM session_message($1, $2, $3::jsonb, $4, $5)",
          [fresh, session, JSON.stringify(GOOD_MESSAGE), key, randomUUID()],
        );
      const [made] = await f.owner<{ id: string }>(
        `INSERT INTO event_session (organizer_id, event_id, kind, title_en, starts_at, ends_at, access, created_by)
         SELECT e.organizer_id, e.id, 'workshop', 'Msg', now() + interval '1 hour', now() + interval '2 hours',
                'registration', gen_random_uuid() FROM event e WHERE e.id = $1 RETURNING id`,
        [fresh],
      );
      const session = made?.id ?? "";
      expect(await refusal(send("k0", session))).toBe("PT409:nobody");
      const joined = [await f.newPlayer(), await f.newPlayer(), await f.newPlayer()];
      for (const who of joined) {
        const enrollment = await f.join(fresh, who);
        await f.owner(
          `INSERT INTO session_registration (organizer_id, event_id, session_id, enrollment_id, player_id)
           SELECT e.organizer_id, e.id, $2, $3, $4 FROM event e WHERE e.id = $1`,
          [fresh, session, enrollment, who],
        );
      }
      await f.owner(
        "UPDATE enrollment SET status = 'left' WHERE event_id = $1 AND player_id = $2",
        [fresh, joined[2]],
      );
      const first = await send("k1", session);
      expect(first[0]?.replayed).toBe(false);
      const replay = await send("k1", session);
      expect(replay[0]).toMatchObject({ id: first[0]?.id, replayed: true });
      const notices = await f.owner<{ player_id: string }>(
        "SELECT player_id FROM notice WHERE event_id = $1 AND kind = 'session_message'",
        [fresh],
      );
      expect(first[0]?.recipients).toBe(2);
      expect(notices.map((row) => row.player_id).toSorted()).toEqual(
        [joined[0], joined[1]].toSorted(),
      );
      await send("k2", session);
      await send("k3", session);
      expect(await refusal(send("k4", session))).toBe("PL429:hour");
    });
  });

  describe("the team's seat", () => {
    it("lists nothing and writes nothing for another organizer's event", async () => {
      const other = f.team(undefined, f.ids.orgB);
      expect(await refusal(f.run(other, "SELECT session_list($1)", [event]))).toBe("AN404");
      expect(await refusal(save({}, null, other))).toBe("AN404");
    });
  });
});
