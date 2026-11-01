import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { questifyFixture, type QuestifyFixture } from "#test/support/questify";
import { addMember, TEST_DATABASE_URL } from "#test/support/test-db";

type Inbox = {
  tickets: { question: number; problem: number; prize: number; report_player: number };
  withQuestify: number;
  joinRequests: { pending: number; private: boolean };
  submissions: number;
  flags: number;
};

const NOTHING: Inbox = {
  tickets: { question: 0, problem: 0, prize: 0, report_player: 0 },
  withQuestify: 0,
  joinRequests: { pending: 0, private: false },
  submissions: 0,
  flags: 0,
};

/** A call's SQLSTATE, or "none". */
const refusal = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "none",
    (error: { code?: string }) => `${error.code}`,
  );

/**
 * The owner's Inbox counts in the database (T-616, migration 0110): open help requests by kind (the Help desk's Open
 * tab), the ones Questify holds, join requests, submissions waiting and open flags; for the event's own team only.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("event inbox (database)", () => {
  let f: QuestifyFixture;
  beforeAll(async () => {
    f = await questifyFixture();
  });
  afterAll(async () => {
    await f.close();
  });

  const inbox = async (ev: string, seat = f.team()): Promise<Inbox> =>
    (await f.run<{ answer: Inbox }>(seat, "SELECT event_inbox($1) AS answer", [ev]))[0]
      ?.answer as Inbox;
  const organizerOf = async (ev: string): Promise<string | undefined> =>
    (
      await f.owner<{ organizer_id: string }>("SELECT organizer_id FROM event WHERE id = $1", [ev])
    )[0]?.organizer_id;
  const member = async (ev: string, status = "active", joinedVia: string | null = null) => {
    const player = await f.newPlayer();
    const enrollment = await f.join(ev, player, joinedVia);
    if (status !== "active") {
      await f.owner("UPDATE enrollment SET status = $2 WHERE id = $1", [enrollment, status]);
    }
    return { player, enrollment };
  };
  const ticket = async (
    ev: string,
    who: Readonly<{ player: string; enrollment: string }>,
    kind: string,
    state: "open" | "closed" | "questify" = "open",
  ) => {
    const id = (
      await f.owner<{ id: string }>(
        `INSERT INTO ticket (player_id, organizer_id, event_id, enrollment_id, kind, body, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, 'Help please', $6) RETURNING id`,
        [who.player, await organizerOf(ev), ev, who.enrollment, kind, randomUUID()],
      )
    )[0]?.id;
    if (state === "closed") {
      await f.owner(
        `UPDATE ticket SET status = 'closed', outcome = 'solved', closed_at = now(), answer_key = 'k',
                           answered_by_staff = $2 WHERE id = $1`,
        [id, f.ownerA],
      );
    }
    if (state === "questify") {
      await f.owner(
        `UPDATE ticket SET queue = 'questify', escalated_at = now(), escalated_by_staff = $2,
                           escalation_note = 'We tried' WHERE id = $1`,
        [id, f.ownerA],
      );
    }
  };
  const submission = async (ev: string, enrollment: string, status: string) => {
    const [quest] = await f.owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, visible)
       SELECT $1, id, 'scan_qr', 'Station', 10, 3, true FROM category WHERE event_id = $1 LIMIT 1 RETURNING id`,
      [ev],
    );
    await f.owner(
      `INSERT INTO submission (organizer_id, event_id, enrollment_id, quest_id, kind, body, points, status,
                               reason, reviewed_by_staff, idempotency_key)
       VALUES ($1, $2, $3, $4, 'text', 'My answer', 10, $5, $6, $7, $8)`,
      [
        await organizerOf(ev),
        ev,
        enrollment,
        quest?.id,
        status,
        status === "pending" ? null : "Off topic",
        status === "pending" ? null : f.ownerA,
        randomUUID(),
      ],
    );
  };
  const flag = async (ev: string, enrollment: string, open: boolean) =>
    f.owner(
      open
        ? `INSERT INTO flag (organizer_id, event_id, enrollment_id, kind, status)
           VALUES ($1, $2, $3, 'burst', 'open')`
        : `INSERT INTO flag (organizer_id, event_id, enrollment_id, kind, status, resolution, resolved_at)
           VALUES ($1, $2, $3, 'burst', 'cleared', 'cleared', now())`,
      [await organizerOf(ev), ev, enrollment],
    );

  it("counts nothing for a quiet event", async () => {
    expect(await inbox(await f.newEvent({ phase: "live" }))).toEqual(NOTHING);
  });

  it("counts the open help requests by kind, and only those of the event's own queue", async () => {
    const ev = await f.newEvent({ phase: "live" });
    const other = await f.newEvent({ phase: "live" });
    const first = await member(ev);
    const second = await member(ev);
    for (const kind of ["question", "question", "problem", "prize", "report_player"]) {
      await ticket(ev, kind === "question" ? first : second, kind);
    }
    await ticket(ev, first, "prize", "closed");
    await ticket(ev, first, "report_player", "questify");
    await ticket(other, await member(other), "question");
    expect(await inbox(ev)).toMatchObject({
      tickets: { question: 2, problem: 1, prize: 1, report_player: 1 },
      withQuestify: 1,
    });
  });

  it("answers the same numbers the Help desk's Open tab and kind filter list", async () => {
    const ev = await f.newEvent({ phase: "live" });
    const player = await member(ev);
    for (const kind of ["prize", "prize", "prize", "report_player", "problem"]) {
      await ticket(ev, player, kind);
    }
    await ticket(ev, player, "prize", "closed");
    const counted = (await inbox(ev)).tickets;
    for (const [kind, n] of Object.entries(counted)) {
      const listed = await f.run(
        f.team(),
        "SELECT * FROM event_tickets($1, 'open', $2, NULL, 100)",
        [ev, kind],
      );
      expect(listed, kind).toHaveLength(n);
    }
    const open = await f.run<{ open: number; with_questify: number }>(
      f.team(),
      "SELECT * FROM event_ticket_counts($1)",
      [ev],
    );
    expect(open[0]?.open).toBe(Object.values(counted).reduce((sum, n) => sum + n, 0));
  });

  it("counts pending requests and the waiting list, not declined, active or rehearsal accounts", async () => {
    const ev = await f.newEvent({ phase: "live", access: "private" });
    await member(ev, "pending");
    await member(ev, "pending");
    await f.owner("UPDATE enrollment SET waitlisted = true WHERE id = $1", [
      (await member(ev, "pending")).enrollment,
    ]);
    await member(ev, "declined");
    await member(ev, "active");
    await member(ev, "pending", "rehearsal");
    expect((await inbox(ev)).joinRequests).toEqual({ pending: 3, private: true });
    expect((await inbox(await f.newEvent({ phase: "live" }))).joinRequests.private).toBe(false);
    expect(
      (await inbox(await f.newEvent({ phase: "live", access: "unlisted" }))).joinRequests.private,
    ).toBe(false);
  });

  it("counts the submissions waiting for review and the open flags", async () => {
    const ev = await f.newEvent({ phase: "live" });
    const first = await member(ev);
    const second = await member(ev);
    await submission(ev, first.enrollment, "pending");
    await submission(ev, second.enrollment, "pending");
    await submission(ev, second.enrollment, "rejected");
    await flag(ev, first.enrollment, true);
    await flag(ev, second.enrollment, false);
    expect(await inbox(ev)).toMatchObject({ submissions: 2, flags: 1 });
  });

  it("is the event's own team only: another organizer, a player, a stranger and an unknown event are refused", async () => {
    const ev = await f.newEvent({ phase: "live" });
    const stranger = await addMember(f.db.owner, f.ids.orgB, "owner");
    const player = await f.newPlayer();
    const sql = "SELECT event_inbox($1)";
    expect(await refusal(f.run(f.team(stranger, f.ids.orgB), sql, [ev]))).toBe("AN404");
    expect(await refusal(f.run(f.team(f.ownerA, f.ids.orgB), sql, [ev]))).toBe("AN404");
    expect(await refusal(f.run({ playerId: player }, sql, [ev]))).toBe("AN404");
    expect(await refusal(f.run({}, sql, [ev]))).toBe("AN404");
    expect(await refusal(f.run(f.team(), sql, [randomUUID()]))).toBe("AN404");
    expect(await refusal(f.run(f.team(), sql, [ev]))).toBe("none");
  });

  it("keeps an editor to the events in their limit", async () => {
    const inside = await f.newEvent({ phase: "live" });
    const outside = await f.newEvent({ phase: "live" });
    const editor = await addMember(f.db.owner, f.ids.orgA, "editor", [inside]);
    const seat = f.team(editor);
    expect(await refusal(f.run(seat, "SELECT event_inbox($1)", [inside]))).toBe("none");
    expect(await refusal(f.run(seat, "SELECT event_inbox($1)", [outside]))).toBe("AN404");
  });

  it("answers counts only, with no player, name or text", async () => {
    const ev = await f.newEvent({ phase: "live" });
    const player = await member(ev);
    await ticket(ev, player, "report_player");
    const answer = JSON.stringify(await inbox(ev));
    expect(answer).not.toContain(await f.usernameOf(player.player));
    expect(answer).not.toContain("Help please");
  });

  it("reads the event's open rows from their own indexes, not a walk of the table", async () => {
    const ev = await f.newEvent({ phase: "live" });
    const reads = [
      [
        `SELECT count(*) FILTER (WHERE t.queue = 'event' AND t.kind = 'prize'),
                count(*) FILTER (WHERE t.queue = 'questify')
         FROM ticket t WHERE t.event_id = $1 AND t.status = 'open'`,
        "ticket_event_open_idx",
      ],
      [
        `SELECT count(*) FROM enrollment n WHERE n.event_id = $1 AND n.status = 'pending'
         AND n.joined_via IS DISTINCT FROM 'rehearsal'`,
        "enrollment_requests_idx",
      ],
      [
        `SELECT count(*) FROM submission s WHERE s.event_id = $1 AND s.status = 'pending'`,
        "Index Only Scan using submission_queue_idx|Index Scan using submission_one_pending",
      ],
      [
        `SELECT count(*) FROM flag f WHERE f.event_id = $1 AND f.status = 'open'`,
        "flag_event_open_idx",
      ],
    ] as const;
    await f.owner("BEGIN");
    try {
      await f.owner("SET LOCAL enable_seqscan = off");
      for (const [sql, index] of reads) {
        const plan = await f.owner<Record<string, unknown>>(`EXPLAIN ${sql}`, [ev]);
        expect(plan.map((line) => String(line["QUERY PLAN"])).join(" "), sql).toMatch(
          new RegExp(index),
        );
      }
    } finally {
      await f.owner("ROLLBACK");
    }
  });
});
