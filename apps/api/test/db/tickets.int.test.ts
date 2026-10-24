import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
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
type Opened = {
  ticket_id: string;
  status: string;
  created_at: Date;
  marked: boolean;
  replayed: boolean;
};
type Answered = { ticket_id: string; outcome: string; replayed: boolean };

const codeOf = (result: PromiseSettledResult<unknown>) =>
  result.status === "rejected"
    ? `${(result.reason as { code?: string }).code}:${(result.reason as { detail?: string }).detail ?? ""}`
    : "ok";

/** A promise and the function that settles it. */
const signal = () => {
  const settles: (() => void)[] = [];
  const promise = new Promise<void>((settle) => {
    settles.push(settle);
  });
  return { promise, resolve: () => settles.forEach((settle) => settle()) };
};

const ago = (minutes: number) => `now() - interval '${minutes} minutes'`;

const refusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
    return "none";
  } catch (error) {
    const pg = error as { code?: string; detail?: string };
    return pg.detail === undefined || pg.detail === "" ? `${pg.code}` : `${pg.code}:${pg.detail}`;
  }
};

/**
 * The help desk in the database (T-310, migration 0059, ADR-246 to ADR-248): who may send and the caps, the answer and
 * its replays, who reads what (the sender, the team, operators by their limit, never another player), the merged
 * inbox, erasure, the rehearsal wipe, the retention sweep, the crossed locks, and the closed doors.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("help desk tickets (database)", () => {
  let db: TestDatabase;
  let pool: Pool;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let ownerA = "";
  let ownerB = "";
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new Pool({ connectionString: db.appUrl, max: 8 });
    ids = await seedTwoTenants(db.owner);
    ownerA = await addMember(db.owner, ids.orgA, "owner");
    ownerB = await addMember(db.owner, ids.orgB, "owner");
    await db.owner.query(
      "INSERT INTO username_word (word, match, language) VALUES ('qxbad', 'word', 'en')",
    );
  });
  afterAll(async () => {
    await pool.end();
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const query = async <T extends Row>(
    context: RequestContext,
    sql: string,
    values: unknown[] = [],
  ) => {
    const client: PoolClient = await pool.connect();
    try {
      return await withRequestContext(
        client,
        context,
        async () => (await client.query<T>(sql, values)).rows,
      );
    } finally {
      client.release();
    }
  };
  const team = (staff = ownerA, org = ids.orgA): RequestContext => ({
    organizerId: org,
    staffUserId: staff,
  });

  const newEvent = async (
    options: { status?: string; endsIn?: string; config?: Row } = {},
  ): Promise<string> => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at, config)
       VALUES ($1, $2, 'Help Fest', $3, least(now() - interval '2 hours', now() + $4::interval - interval '1 hour'),
               now() + $4::interval, $5) RETURNING id`,
      [
        ids.orgA,
        `HELP${counter}`,
        options.status ?? "live",
        options.endsIn ?? "1 day",
        JSON.stringify(options.config ?? {}),
      ],
    );
    return event?.id ?? "";
  };
  const newQuest = async (event: string): Promise<string> => {
    const [category] = await owner<{ id: string }>(
      "INSERT INTO category (event_id, name_en) VALUES ($1, 'General') RETURNING id",
      [event],
    );
    const [quest] = await owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
       VALUES ($1, $2, 'enter_code', 'Find the code', 10, '{"code": "ABCD"}') RETURNING id`,
      [event, category?.id],
    );
    return quest?.id ?? "";
  };
  const newPlayer = async (): Promise<string> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`help_player_${counter}`],
    );
    return player?.id ?? "";
  };
  const enroll = async (player: string, event: string, via = "code"): Promise<string> => {
    const [made] = await owner<{ id: string }>(
      "INSERT INTO enrollment (organizer_id, event_id, player_id, joined_via) VALUES ($1, $2, $3, $4) RETURNING id",
      [ids.orgA, event, player, via],
    );
    return made?.id ?? "";
  };
  const member = async (event: string) => {
    const player = await newPlayer();
    return { player, enrollment: await enroll(player, event) };
  };
  const operator = async (event: string, abilities = ["help_desk"], quests: string[] = []) => {
    const player = await newPlayer();
    const [made] = await owner<{ id: string }>(
      `INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities) VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [ids.orgA, event, player, abilities],
    );
    for (const quest of quests) {
      await owner(
        "INSERT INTO staff_assignment_quest (assignment_id, event_id, quest_id) VALUES ($1, $2, $3)",
        [made?.id, event, quest],
      );
    }
    return player;
  };
  const open = async (
    player: string,
    event: string,
    options: { kind?: string; quest?: string | null; body?: string; key?: string } = {},
  ) =>
    (
      await query<Opened>(
        { playerId: player },
        "SELECT * FROM open_ticket($1, $2, $3, NULL, $4, $5)",
        [
          event,
          options.kind ?? "question",
          options.quest ?? null,
          options.body ?? "Where is the stage?",
          options.key ?? randomUUID(),
        ],
      )
    )[0] as Opened;
  const staffAnswer = async (
    event: string,
    ticket: string,
    reply: string | null = "Behind hall B",
    key = randomUUID(),
    staff = ownerA,
  ) =>
    (
      await query<Answered>(team(staff), "SELECT * FROM staff_answer_ticket($1, $2, $3, $4, $5)", [
        event,
        ticket,
        reply,
        key,
        randomUUID(),
      ])
    )[0] as Answered;
  const opAnswer = async (
    op: string,
    event: string,
    ticket: string,
    reply: string | null = "On my way",
    key = randomUUID(),
  ) =>
    (
      await query<Answered>(
        { playerId: op },
        "SELECT * FROM operator_answer_ticket($1, $2, $3, $4)",
        [event, ticket, reply, key],
      )
    )[0] as Answered;
  const ticketRow = async (ticket: string) =>
    (await owner<Row>("SELECT * FROM ticket WHERE id = $1", [ticket]))[0];
  const ownTickets = (player: string, event: string | null) =>
    query<Row>({ playerId: player }, "SELECT * FROM own_tickets($1)", [event]);
  const inbox = (
    op: string,
    event: string,
    cursor: [string, string, string] | null = null,
    page = 30,
  ) =>
    query<Row>({ playerId: op }, "SELECT * FROM operator_inbox($1, $2, $3, $4, $5)", [
      event,
      cursor?.[0] ?? null,
      cursor?.[1] ?? null,
      cursor?.[2] ?? null,
      page,
    ]);
  const mark = (who: string, event: string | null, list: string[]) =>
    query<{ n: number }>({ playerId: who }, "SELECT mark_tickets_seen($1, $2::bigint[]) AS n", [
      event,
      list,
    ]);
  const purge = (batch: number) =>
    query<{ n: number }>({}, "SELECT purge_ended_tickets($1) AS n", [batch]);
  /** Waits until some session of this database waits on a lock (at most 5 seconds). */
  const lockWait = async (): Promise<void> => {
    for (let tries = 0; tries < 250; tries += 1) {
      const [row] = await owner<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
      );
      if ((row?.n ?? 0) > 0) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("No session waited on a lock.");
  };
  const inboxCount = async (op: string, event: string) =>
    (await query<Row>({ playerId: op }, "SELECT * FROM operator_inbox_count($1)", [event]))[0];

  describe("sending", () => {
    it("opens a question and a problem, with and without a quest, cleaned and unmarked", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const { player, enrollment } = await member(event);
      const question = await open(player, event, { body: "  Where is the stage?  " });
      expect(question).toMatchObject({ status: "open", replayed: false });
      const problem = await open(player, event, { kind: "problem", quest, body: "No QR here" });
      expect(await ticketRow(question.ticket_id)).toMatchObject({
        player_id: player,
        enrollment_id: enrollment,
        organizer_id: ids.orgA,
        kind: "question",
        quest_id: null,
        queue: "event",
        body: "Where is the stage?",
        marked: false,
        status: "open",
        outcome: null,
      });
      expect(await ticketRow(problem.ticket_id)).toMatchObject({
        kind: "problem",
        quest_id: quest,
      });
    });

    it("refuses another event's quest, a bad kind and bad text; marks a watch-list word", async () => {
      const event = await newEvent();
      const other = await newEvent();
      const foreign = await newQuest(other);
      const { player } = await member(event);
      expect(await refusal(open(player, event, { quest: foreign }))).toBe("HQ404");
      expect(await refusal(open(player, event, { quest: randomUUID() }))).toBe("HQ404");
      expect(await refusal(open(player, event, { kind: "praise" }))).toBe("HK422");
      expect(await refusal(open(player, event, { body: "   " }))).toBe("SV422:empty");
      expect(await refusal(open(player, event, { body: "x".repeat(1001) }))).toBe("SV422:too_long");
      expect(await refusal(open(player, event, { body: "bad‮word" }))).toBe("SV422:characters");
      expect(await refusal(open(player, event, { body: "bell\u0007" }))).toBe("SV422:characters");
      const marked = await open(player, event, { body: "this is QXBAD" });
      expect((await ticketRow(marked.ticket_id))?.["marked"]).toBe(true);
    });

    it("lets only active members send; anyone else is not_member", async () => {
      const event = await newEvent();
      for (const status of ["pending", "left", "removed", "banned"]) {
        const { player, enrollment } = await member(event);
        await owner("UPDATE enrollment SET status = $2 WHERE id = $1", [enrollment, status]);
        expect(await refusal(open(player, event)), status).toBe("HT403:not_member");
      }
      const waiting = await member(event);
      await owner("UPDATE enrollment SET status = 'pending', waitlisted = true WHERE id = $1", [
        waiting.enrollment,
      ]);
      expect(await refusal(open(waiting.player, event))).toBe("HT403:not_member");
      expect(await refusal(open(await newPlayer(), event))).toBe("HT403:not_member");
      expect(await refusal(open(await newPlayer(), randomUUID()))).toBe("HT403:not_member");
      const gone = await member(event);
      await owner(
        "UPDATE player SET status = 'deleted', deleted_at = now(), username = NULL WHERE id = $1",
        [gone.player],
      );
      expect(await refusal(open(gone.player, event))).toBe("HT403:not_member");
    });

    it("closes sending in a draft or archived event and 30 days after the end", async () => {
      const draft = await newEvent({ status: "draft" });
      const inDraft = await member(draft);
      expect(await refusal(open(inDraft.player, draft))).toBe("HT403:sending_closed");
      const archived = await newEvent({ status: "archived" });
      const inArchived = await member(archived);
      expect(await refusal(open(inArchived.player, archived))).toBe("HT403:sending_closed");
      const recent = await newEvent({ endsIn: "-29 days" });
      const late = await member(recent);
      expect(await open(late.player, recent)).toMatchObject({ status: "open" });
      const old = await newEvent({ endsIn: "-31 days" });
      const tooLate = await member(old);
      expect(await refusal(open(tooLate.player, old))).toBe("HT403:sending_closed");
    });

    it("lets a member of a scheduled event and a rehearsal account send", async () => {
      counter += 1;
      const [scheduled] = await owner<{ id: string }>(
        `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
         VALUES ($1, $2, 'Soon', 'scheduled', now() + interval '1 day', now() + interval '2 days') RETURNING id`,
        [ids.orgA, `SOON${counter}`],
      );
      const event = scheduled?.id ?? "";
      await owner(
        "INSERT INTO event_rehearsal (event_id, organizer_id, code) VALUES ($1, $2, 'HELP-REHE')",
        [event, ids.orgA],
      );
      const early = await member(event);
      expect(await open(early.player, event)).toMatchObject({ status: "open" });
      const tester = await newPlayer();
      await enroll(tester, event, "rehearsal");
      expect(await open(tester, event)).toMatchObject({ status: "open" });
    });

    it("refuses sending with the event's helpDesk switch off", async () => {
      const event = await newEvent({ config: { features: { helpDesk: false } } });
      const { player } = await member(event);
      expect(await refusal(open(player, event))).toBe("HT403:feature_off");
    });

    it("holds three open per player and event; a closed one frees a place", async () => {
      const event = await newEvent();
      const { player } = await member(event);
      const first = await open(player, event);
      await open(player, event);
      await open(player, event);
      expect(await refusal(open(player, event))).toBe("HT409:too_many_open");
      const elsewhere = await newEvent();
      await enroll(player, elsewhere);
      expect(await open(player, elsewhere)).toMatchObject({ status: "open" });
      await staffAnswer(event, first.ticket_id, null);
      expect(await open(player, event)).toMatchObject({ status: "open" });
    });

    it("holds ten a day, with the seconds until the oldest of the ten leaves the window", async () => {
      const event = await newEvent();
      const { player, enrollment } = await member(event);
      await owner(
        `INSERT INTO ticket (player_id, organizer_id, event_id, enrollment_id, kind, body, status, outcome,
                             answered_by_staff, answer_key, closed_at, idempotency_key, created_at)
         SELECT $1, $2, $3, $4, 'question', 'old', 'closed', 'solved', $5, 'k' || g, now(), 'seed' || g,
                now() - interval '23 hours' + g * interval '1 minute'
         FROM generate_series(1, 9) g`,
        [player, ids.orgA, event, enrollment, ownerA],
      );
      await owner(
        `INSERT INTO ticket (player_id, organizer_id, event_id, enrollment_id, kind, body, status, outcome,
                             answered_by_staff, answer_key, closed_at, idempotency_key, created_at)
         VALUES ($1, $2, $3, $4, 'question', 'older', 'closed', 'solved', $5, 'k0', now(), 'seed0',
                 now() - interval '25 hours')`,
        [player, ids.orgA, event, enrollment, ownerA],
      );
      const tenth = await open(player, event);
      expect(tenth.replayed).toBe(false);
      const refused = await refusal(open(player, event));
      const [code, seconds] = refused.split(":");
      expect(code).toBe("HT429");
      expect(Number(seconds)).toBeGreaterThan(55 * 60);
      expect(Number(seconds)).toBeLessThanOrEqual(61 * 60);
    });

    it("replays a key with the first ticket and the caps counted once; refuses it for another ticket", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const { player } = await member(event);
      const key = randomUUID();
      const first = await open(player, event, { quest, kind: "problem", key });
      await open(player, event);
      await open(player, event);
      expect(await open(player, event, { quest, kind: "problem", key })).toMatchObject({
        ticket_id: first.ticket_id,
        replayed: true,
      });
      expect(await refusal(open(player, event, { quest, kind: "question", key }))).toBe("QK422");
      expect(await refusal(open(player, event, { kind: "problem", key }))).toBe("QK422");
      const other = await newEvent();
      await enroll(player, other);
      expect(await refusal(open(player, other, { quest, kind: "problem", key }))).toBe("QK422");
      expect(
        await owner("SELECT count(*)::int AS n FROM ticket WHERE player_id = $1", [player]),
      ).toEqual([{ n: 3 }]);
      expect(await refusal(open(player, event, { key: "" }))).toBe("QK422");
    });
  });

  describe("answering", () => {
    it("lets an owner reply or solve, audited with no text, and replays the key", async () => {
      const event = await newEvent();
      const { player } = await member(event);
      const asked = await open(player, event);
      const key = randomUUID();
      const request = randomUUID();
      const [answered] = await query<Answered>(
        team(),
        "SELECT * FROM staff_answer_ticket($1, $2, $3, $4, $5)",
        [event, asked.ticket_id, "  Behind hall B  ", key, request],
      );
      expect(answered).toEqual({
        ticket_id: asked.ticket_id,
        outcome: "answered",
        replayed: false,
      });
      expect(await staffAnswer(event, asked.ticket_id, "Behind hall B", key)).toEqual({
        ...answered,
        replayed: true,
      });
      expect(await refusal(staffAnswer(event, asked.ticket_id, null, key))).toBe("QK422");
      expect(await ticketRow(asked.ticket_id)).toMatchObject({
        status: "closed",
        outcome: "answered",
        reply: "Behind hall B",
        answered_by_staff: ownerA,
        answered_by_operator: null,
        answer_key: key,
      });
      const audit = await owner<Row>(
        "SELECT action, target_type, target_id, after, before, request_id FROM audit_log WHERE target_type = 'ticket' AND target_id = $1",
        [asked.ticket_id],
      );
      expect(audit).toEqual([
        {
          action: "event.ticket_answered",
          target_type: "ticket",
          target_id: asked.ticket_id,
          after: { outcome: "answered" },
          before: null,
          request_id: request,
        },
      ]);
      const other = await open(player, event);
      expect(await staffAnswer(event, other.ticket_id, null)).toMatchObject({ outcome: "solved" });
      expect(await ticketRow(other.ticket_id)).toMatchObject({ reply: null, outcome: "solved" });
      expect(
        await owner(
          "SELECT action FROM audit_log WHERE target_type = 'ticket' AND target_id = $1",
          [other.ticket_id],
        ),
      ).toEqual([{ action: "event.ticket_solved" }]);
    });

    it("refuses a second answer, a key on another ticket, bad reply text and an archived event", async () => {
      const event = await newEvent();
      const { player } = await member(event);
      const first = await open(player, event);
      const second = await open(player, event);
      const key = randomUUID();
      await staffAnswer(event, first.ticket_id, "Yes", key);
      expect(await refusal(staffAnswer(event, second.ticket_id, "Yes", key))).toBe("QK422");
      const editor = await addMember(db.owner, ids.orgA, "editor");
      expect(await refusal(staffAnswer(event, first.ticket_id, "Me too", key, editor))).toBe(
        "HT409:already_closed",
      );
      expect(await refusal(staffAnswer(event, second.ticket_id, "  "))).toBe("SV422:empty");
      expect(await refusal(staffAnswer(event, second.ticket_id, "x".repeat(1001)))).toBe(
        "SV422:too_long",
      );
      expect(await refusal(staffAnswer(event, second.ticket_id, "a‮b"))).toBe("SV422:characters");
      expect(await refusal(staffAnswer(event, "999999999", "Hi"))).toBe("HT404");
      await owner("UPDATE event SET status = 'archived' WHERE id = $1", [event]);
      expect(await refusal(staffAnswer(event, second.ticket_id, "Hi"))).toBe("HT409:event_closed");
    });

    it("keeps editors to their event limit and organizers to their tenant", async () => {
      const event = await newEvent();
      const other = await newEvent();
      const { player } = await member(event);
      const asked = await open(player, event);
      const scoped = await addMember(db.owner, ids.orgA, "editor", [other]);
      expect(await refusal(staffAnswer(event, asked.ticket_id, "Hi", randomUUID(), scoped))).toBe(
        "AN404",
      );
      const inScope = await addMember(db.owner, ids.orgA, "editor", [event]);
      expect(await staffAnswer(event, asked.ticket_id, "Hi", randomUUID(), inScope)).toMatchObject({
        outcome: "answered",
      });
      for (const sql of [
        "SELECT * FROM event_tickets($1, 'open', NULL, NULL, 50)",
        "SELECT * FROM event_ticket_counts($1)",
      ]) {
        expect(await refusal(query(team(ownerB, ids.orgB), sql, [event])), sql).toBe("AN404");
        expect(await refusal(query(team(scoped), sql, [event])), sql).toBe("AN404");
      }
      const next = await open(player, event);
      expect(
        await refusal(
          query(
            team(ownerB, ids.orgB),
            "SELECT * FROM staff_answer_ticket($1, $2, 'x', 'k', NULL)",
            [event, next.ticket_id],
          ),
        ),
      ).toBe("AN404");
      expect(
        await refusal(
          query(
            team(ownerB, ids.orgB),
            "SELECT * FROM staff_answer_ticket($1, $2, 'x', 'k', NULL)",
            [ids.eventB, next.ticket_id],
          ),
        ),
      ).toBe("HT404");
    });

    it("lets a help-desk operator answer inside their limit, recorded on the row with no audit", async () => {
      const event = await newEvent();
      const inside = await newQuest(event);
      const outside = await newQuest(event);
      const { player } = await member(event);
      const free = await operator(event);
      const limited = await operator(event, ["help_desk"], [inside]);
      const wide = await open(player, event);
      const insideTicket = await open(player, event, { kind: "problem", quest: inside });
      const outsideTicket = await open(player, event, { kind: "problem", quest: outside });
      expect(await refusal(opAnswer(limited, event, outsideTicket.ticket_id))).toBe(
        "HT403:outside_quests",
      );
      expect(await opAnswer(limited, event, insideTicket.ticket_id)).toMatchObject({
        outcome: "answered",
      });
      expect(await opAnswer(limited, event, wide.ticket_id, null)).toMatchObject({
        outcome: "solved",
      });
      expect(await opAnswer(free, event, outsideTicket.ticket_id)).toMatchObject({
        outcome: "answered",
      });
      expect(await ticketRow(insideTicket.ticket_id)).toMatchObject({
        answered_by_operator: limited,
        answered_by_staff: null,
        reply: "On my way",
      });
      expect(
        await owner(
          "SELECT count(*)::int AS n FROM audit_log WHERE target_type = 'ticket' AND target_id = ANY ($1)",
          [[wide.ticket_id, insideTicket.ticket_id, outsideTicket.ticket_id]],
        ),
      ).toEqual([{ n: 0 }]);
    });

    it("refuses an operator without help_desk, a non-operator and an operator's own ticket", async () => {
      const event = await newEvent();
      const { player } = await member(event);
      const asked = await open(player, event);
      const reviewer = await operator(event, ["review"]);
      expect(await refusal(opAnswer(reviewer, event, asked.ticket_id))).toBe("OA403");
      expect(await refusal(opAnswer(player, event, asked.ticket_id))).toBe("OP403");
      const playing = await operator(event);
      await enroll(playing, event);
      const mine = await open(playing, event);
      expect(await refusal(opAnswer(playing, event, mine.ticket_id))).toBe("HT403:self_answer");
      const elsewhere = await newEvent();
      const there = await operator(elsewhere);
      expect(await refusal(opAnswer(there, elsewhere, asked.ticket_id))).toBe("HT404");
      expect(await refusal(opAnswer(there, event, asked.ticket_id))).toBe("OP403");
    });

    it("answers a banned sender's ticket; a second answerer with the same key gets already_closed", async () => {
      const event = await newEvent();
      const { player, enrollment } = await member(event);
      const asked = await open(player, event);
      await owner("UPDATE enrollment SET status = 'banned' WHERE id = $1", [enrollment]);
      const op = await operator(event);
      const key = randomUUID();
      expect(await opAnswer(op, event, asked.ticket_id, "Sorry", key)).toMatchObject({
        outcome: "answered",
      });
      expect(await opAnswer(op, event, asked.ticket_id, "Sorry", key)).toMatchObject({
        replayed: true,
      });
      expect(await refusal(staffAnswer(event, asked.ticket_id, "Sorry", key))).toBe(
        "HT409:already_closed",
      );
    });
  });

  describe("reads", () => {
    it("shows the sender only their own tickets, with no answerer, in any state and with the switch off", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const sender = await member(event);
      const neighbour = await member(event);
      const asked = await open(sender.player, event, { kind: "problem", quest });
      await open(neighbour.player, event);
      await staffAnswer(event, asked.ticket_id, "Fixed");
      const rows = await ownTickets(sender.player, event);
      expect(rows).toEqual([
        {
          id: asked.ticket_id,
          event_id: event,
          event_name_ar: null,
          event_name_en: "Help Fest",
          kind: "problem",
          quest_id: quest,
          quest_title_ar: null,
          quest_title_en: "Find the code",
          body: "Where is the stage?",
          status: "closed",
          outcome: "answered",
          reply: "Fixed",
          closed_at: expect.any(Date),
          created_at: expect.any(Date),
          unread: true,
          with_questify: false,
          answered_by_team: "event",
          reported_username: null,
        },
      ]);
      expect((await ownTickets(neighbour.player, event)).map((row) => row["id"])).not.toContain(
        asked.ticket_id,
      );
      expect(await ownTickets(await newPlayer(), event)).toEqual([]);
      for (const status of ["left", "removed", "banned"]) {
        await owner("UPDATE enrollment SET status = $2 WHERE id = $1", [sender.enrollment, status]);
        expect(await ownTickets(sender.player, event), status).toHaveLength(1);
      }
      await owner(
        `UPDATE event SET config = jsonb_set(config, '{features}', '{"helpDesk": false}') WHERE id = $1`,
        [event],
      );
      expect(await ownTickets(sender.player, event)).toHaveLength(1);
    });

    it("lists every event's tickets with NULL, and counts and marks only the caller's closed answers", async () => {
      const one = await newEvent();
      const two = await newEvent();
      const player = await newPlayer();
      await enroll(player, one);
      await enroll(player, two);
      const a = await open(player, one);
      const b = await open(player, two);
      const c = await open(player, two);
      await staffAnswer(one, a.ticket_id, "Yes");
      await staffAnswer(two, b.ticket_id, null);
      const all = await ownTickets(player, null);
      expect(all.map((row) => row["id"])).toEqual([c.ticket_id, b.ticket_id, a.ticket_id]);
      expect(all.map((row) => row["event_id"])).toEqual([two, two, one]);
      const unread = async (event: string) =>
        (
          await query<{ n: number }>({ playerId: player }, "SELECT own_unread_tickets($1) AS n", [
            event,
          ])
        )[0]?.n;
      expect(await unread(one)).toBe(1);
      expect(await unread(two)).toBe(1);
      const stranger = await newPlayer();
      expect(await mark(stranger, null, [a.ticket_id, b.ticket_id])).toEqual([{ n: 0 }]);
      expect(await mark(player, one, [b.ticket_id, c.ticket_id])).toEqual([{ n: 0 }]);
      expect(await mark(player, null, [a.ticket_id, b.ticket_id, c.ticket_id])).toEqual([{ n: 2 }]);
      expect(await mark(player, null, [a.ticket_id])).toEqual([{ n: 0 }]);
      expect(await unread(one)).toBe(0);
      expect(await unread(two)).toBe(0);
      expect((await ticketRow(c.ticket_id))?.["player_seen_at"]).toBeNull();
    });

    it("pages the team's tabs, filters by kind and names who answered", async () => {
      const event = await newEvent();
      const { player } = await member(event);
      const op = await operator(event);
      const questions = [await open(player, event), await open(player, event)];
      const problem = await open(player, event, { kind: "problem" });
      const read = (wanted: string, kind: string | null, cursor: string | null, page = 50) =>
        query<Row>(team(), "SELECT * FROM event_tickets($1, $2, $3, $4, $5)", [
          event,
          wanted,
          kind,
          cursor,
          page,
        ]);
      expect((await read("open", null, null, 2)).map((row) => row["id"])).toEqual(
        questions.map((q) => q.ticket_id),
      );
      expect(
        (await read("open", null, questions[1]?.ticket_id ?? null)).map((row) => row["id"]),
      ).toEqual([problem.ticket_id]);
      expect((await read("open", "problem", null)).map((row) => row["id"])).toEqual([
        problem.ticket_id,
      ]);
      await staffAnswer(event, questions[0]?.ticket_id ?? "", "Hi");
      await opAnswer(op, event, questions[1]?.ticket_id ?? "", null);
      const closed = await read("closed", null, null);
      expect(closed.map((row) => [row["id"], row["answered_by"], row["outcome"]])).toEqual([
        [questions[1]?.ticket_id, "operator", "solved"],
        [questions[0]?.ticket_id, "staff", "answered"],
      ]);
      expect(closed[0]?.["answerer"]).toMatch(/^help_player_/);
      expect(closed[1]?.["answerer"]).toMatch(/@team\.test$/);
      expect(closed[0]).toMatchObject({
        username: expect.stringMatching(/^help_player_/),
        body: "Where is the stage?",
      });
      expect(await read("bogus", null, null)).toEqual([]);
      expect(await query(team(), "SELECT * FROM event_ticket_counts($1)", [event])).toEqual([
        { open: 1, with_questify: 0, closed: 2, waiting_by_kind: { problem: 1 } },
      ]);
    });

    it("gives an operator open tickets by the rule, a closed one only where they answered, never the answerer", async () => {
      const event = await newEvent();
      const inside = await newQuest(event);
      const outside = await newQuest(event);
      const { player } = await member(event);
      const limited = await operator(event, ["help_desk"], [inside]);
      const other = await operator(event);
      const wide = await open(player, event);
      const insideTicket = await open(player, event, { kind: "problem", quest: inside });
      const outsideTicket = await open(player, event, { kind: "problem", quest: outside });
      const one = (op: string, ticket: string) =>
        query<Row>({ playerId: op }, "SELECT * FROM operator_ticket($1, $2)", [event, ticket]);
      expect(await one(limited, wide.ticket_id)).toHaveLength(1);
      expect(await one(limited, insideTicket.ticket_id)).toHaveLength(1);
      expect(await refusal(one(limited, outsideTicket.ticket_id))).toBe("HT404");
      await opAnswer(other, event, wide.ticket_id, "Done");
      expect(await refusal(one(limited, wide.ticket_id))).toBe("HT404");
      const mine = await one(other, wide.ticket_id);
      expect(mine).toEqual([expect.objectContaining({ status: "closed", reply: "Done" })]);
      expect(Object.keys(mine[0] ?? {}).filter((key) => key.includes("answer"))).toEqual([]);
      await owner("DELETE FROM quest WHERE id = $1", [outside]);
      expect(await one(limited, outsideTicket.ticket_id)).toHaveLength(1);
      expect(await ticketRow(outsideTicket.ticket_id)).toMatchObject({
        quest_id: null,
        status: "open",
      });
    });

    it("gives a player who staffs one event nothing of another organizer's event", async () => {
      const event = await newEvent();
      const op = await operator(event, ["review", "help_desk"]);
      const [theirs] = await owner<{ id: string }>(
        `INSERT INTO ticket (player_id, organizer_id, event_id, enrollment_id, kind, body, idempotency_key)
         SELECT n.player_id, n.organizer_id, n.event_id, n.id, 'question', 'Theirs', 'b-side'
         FROM enrollment n WHERE n.event_id = $1 RETURNING id`,
        [ids.eventB],
      );
      expect(
        await refusal(
          query({ playerId: op }, "SELECT * FROM operator_ticket($1, $2)", [event, theirs?.id]),
        ),
      ).toBe("HT404");
      expect(
        await refusal(
          query({ playerId: op }, "SELECT * FROM operator_ticket($1, $2)", [
            ids.eventB,
            theirs?.id,
          ]),
        ),
      ).toBe("OP403");
      expect(await refusal(inbox(op, ids.eventB))).toBe("OP403");
      expect(await refusal(opAnswer(op, event, theirs?.id ?? ""))).toBe("HT404");
      expect(await ownTickets(op, null)).toEqual([]);
      expect(await ownTickets(ids.playerA, ids.eventB)).toEqual([]);
    });

    it("merges submissions and tickets into one inbox, oldest first, paged, by abilities", async () => {
      const event = await newEvent();
      const [category] = await owner<{ id: string }>(
        "INSERT INTO category (event_id, name_en) VALUES ($1, 'Subs') RETURNING id",
        [event],
      );
      const [subQuest] = await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, type_config)
         VALUES ($1, $2, 'submission', 'Tell us', 10, 5, '{"accepts": ["text"]}') RETURNING id`,
        [event, category?.id],
      );
      const { player } = await member(event);
      const both = await operator(event, ["review", "help_desk"]);
      await enroll(both, event);
      const subs: string[] = [];
      for (const minutes of [50, 30, 10]) {
        const sender = await member(event);
        const [made] = await owner<{ id: string }>(
          `INSERT INTO submission (organizer_id, event_id, enrollment_id, quest_id, kind, body, points, status,
                                   idempotency_key, created_at)
           VALUES ($1, $2, $3, $4, 'text', 'My answer', 10, 'pending', $5, ${ago(minutes)}) RETURNING id`,
          [ids.orgA, event, sender.enrollment, subQuest?.id, randomUUID()],
        );
        subs.push(made?.id ?? "");
      }
      const tickets: string[] = [];
      for (const minutes of [40, 20]) {
        const made = await open(player, event, { body: "x".repeat(200) });
        await owner(`UPDATE ticket SET created_at = ${ago(minutes)} WHERE id = $1`, [
          made.ticket_id,
        ]);
        tickets.push(made.ticket_id);
      }
      await open(both, event);
      const list = await inbox(both, event);
      expect(list.map((row) => [row["kind"], row["id"]])).toEqual([
        ["submission", subs[0]],
        ["ticket", tickets[0]],
        ["submission", subs[1]],
        ["ticket", tickets[1]],
        ["submission", subs[2]],
      ]);
      expect(list[1]).toMatchObject({
        ticket_kind: "question",
        preview: "x".repeat(120),
        marked: false,
      });
      expect(await inboxCount(both, event)).toEqual({
        submissions: 3,
        tickets: 2,
        review: true,
        help: true,
      });
      const page = await inbox(both, event, null, 2);
      const last = page[1] ?? {};
      const rest = await inbox(both, event, [
        String(last["position"]),
        String(last["kind"]),
        String(last["id"]),
      ]);
      expect([...page, ...rest].map((row) => row["id"])).toEqual(list.map((row) => row["id"]));
      const reviewer = await operator(event, ["review"]);
      expect((await inbox(reviewer, event)).map((row) => row["kind"])).toEqual([
        "submission",
        "submission",
        "submission",
      ]);
      const helper = await operator(event, ["help_desk"]);
      expect((await inbox(helper, event)).map((row) => row["kind"])).toEqual([
        "ticket",
        "ticket",
        "ticket",
      ]);
      expect(await inboxCount(helper, event)).toMatchObject({ submissions: 0, tickets: 3 });
      const neither = await operator(event, ["award"]);
      expect(await refusal(inbox(neither, event))).toBe("OA403");
      expect(await refusal(inboxCount(neither, event))).toBe("OA403");
      expect(await refusal(inbox(player, event))).toBe("OP403");
    });
  });

  describe("lifecycle", () => {
    it("erases every ticket the account sent and keeps answers by an erased operator", async () => {
      const one = await newEvent();
      const two = await newEvent();
      const player = await newPlayer();
      const first = await enroll(player, one);
      const second = await enroll(player, two);
      await open(player, one);
      await open(player, two);
      const asker = await member(one);
      const op = await operator(one);
      const asked = await open(asker.player, one);
      await opAnswer(op, one, asked.ticket_id, "Here");
      await owner("SELECT erase_rows($1, ARRAY[$2, $3]::uuid[], NULL)", [player, first, second]);
      expect(
        await owner("SELECT count(*)::int AS n FROM ticket WHERE player_id = $1", [player]),
      ).toEqual([{ n: 0 }]);
      await owner("SELECT erase_rows($1, ARRAY[]::uuid[], NULL)", [op]);
      expect(await ticketRow(asked.ticket_id)).toMatchObject({
        reply: "Here",
        answered_by_operator: op,
      });
      const [row] = await query<Row>(
        team(),
        "SELECT * FROM event_tickets($1, 'closed', NULL, NULL, 50)",
        [one],
      );
      expect(row).toMatchObject({
        answered_by: "operator",
        answerer: null,
        answerer_deleted: true,
      });
      expect(await ownTickets(player, null)).toEqual([]);
    });

    it("deletes rehearsal tickets with the rehearsal and counts them", async () => {
      const event = await newEvent({ status: "scheduled" });
      await owner("UPDATE event SET starts_at = now() + interval '1 hour' WHERE id = $1", [event]);
      await owner(
        "INSERT INTO event_rehearsal (event_id, organizer_id, code) VALUES ($1, $2, 'HELP-WKMN')",
        [event, ids.orgA],
      );
      const tester = await newPlayer();
      await enroll(tester, event, "rehearsal");
      const real = await member(event);
      await open(tester, event);
      await open(tester, event);
      const kept = await open(real.player, event);
      const [wiped] = await owner<{ counts: Row }>(
        "SELECT wipe_rehearsal($1, 'go_live', $2) AS counts",
        [event, randomUUID()],
      );
      expect(wiped?.counts).toMatchObject({ accounts: 1, tickets: 2 });
      expect(await owner("SELECT id FROM ticket WHERE event_id = $1", [event])).toEqual([
        { id: kept.ticket_id },
      ]);
    });

    it("cascades with the enrollment and the event, and clears only the quest on a quest delete", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const { player } = await member(event);
      const about = await open(player, event, { kind: "problem", quest });
      const [category] = await owner<{ category_id: string }>(
        "SELECT category_id FROM quest WHERE id = $1",
        [quest],
      );
      await query(team(), "DELETE FROM quest WHERE category_id = $1", [category?.category_id]);
      expect(await ticketRow(about.ticket_id)).toMatchObject({
        quest_id: null,
        event_id: event,
        kind: "problem",
        status: "open",
      });
      await owner("DELETE FROM enrollment WHERE event_id = $1", [event]);
      expect(await ticketRow(about.ticket_id)).toBeUndefined();
      expect(
        await owner<{ ref: string; action: string }>(
          `SELECT confrelid::regclass::text AS ref, confdeltype AS action FROM pg_constraint
           WHERE conrelid = 'ticket'::regclass AND contype = 'f' ORDER BY 1, 2`,
        ),
      ).toEqual([
        { ref: "enrollment", action: "c" },
        { ref: "enrollment", action: "n" },
        { ref: "event", action: "c" },
        { ref: "player", action: "a" },
        { ref: "player", action: "c" },
        { ref: "quest", action: "n" },
        { ref: "staff_user", action: "a" },
        { ref: "staff_user", action: "a" },
        { ref: "staff_user", action: "a" },
        { ref: "staff_user", action: "a" },
      ]);
    });

    it("purges 90 days after the later of the end and the sending, in batches, not a day before", async () => {
      const ended = await newEvent({ endsIn: "-200 days" });
      const { player } = await member(ended);
      const seed = async (sentDaysAgo: number) => {
        const [made] = await owner<{ id: string }>(
          `INSERT INTO ticket (player_id, organizer_id, event_id, enrollment_id, kind, body, idempotency_key, created_at)
           SELECT $1, $2, $3, n.id, 'question', 'old', $4, now() - $5 * interval '1 day'
           FROM enrollment n WHERE n.player_id = $1 AND n.event_id = $3 RETURNING id`,
          [player, ids.orgA, ended, randomUUID(), sentDaysAgo],
        );
        return made?.id ?? "";
      };
      const due = [await seed(195), await seed(91), await seed(92)];
      const fresh = await seed(89);
      const live = await newEvent();
      const current = await member(live);
      const kept = await open(current.player, live);
      expect(await purge(2)).toEqual([{ n: 2 }]);
      expect(await purge(1000)).toEqual([{ n: 1 }]);
      expect(await purge(1000)).toEqual([{ n: 0 }]);
      for (const id of due) {
        expect(await ticketRow(id)).toBeUndefined();
      }
      expect(await ticketRow(fresh)).toBeDefined();
      expect(await ticketRow(kept.ticket_id)).toBeDefined();
    });

    it("refuses the API role any direct read or write of the table", async () => {
      const event = await newEvent();
      const { player, enrollment } = await member(event);
      const asked = await open(player, event);
      for (const sql of [
        "SELECT * FROM ticket",
        `INSERT INTO ticket (player_id, organizer_id, event_id, enrollment_id, kind, body, idempotency_key)
         VALUES ('${player}', '${ids.orgA}', '${event}', '${enrollment}', 'question', 'x', 'k')`,
        `UPDATE ticket SET status = 'closed' WHERE id = ${asked.ticket_id}`,
        `DELETE FROM ticket WHERE id = ${asked.ticket_id}`,
      ]) {
        expect(await refusal(query({ playerId: player }, sql)), sql).toBe("42501");
        expect(await refusal(query(team(), sql)), sql).toBe("42501");
      }
    });
  });

  /** Runs `first` in a transaction and holds it open until `second` waits on a lock, then commits it. */
  const crossed = async (
    first: [RequestContext, string, unknown[]],
    second: () => Promise<unknown>,
    blocks = true,
  ): Promise<[PromiseSettledResult<unknown>, PromiseSettledResult<unknown>]> => {
    const client = await pool.connect();
    const gate = signal();
    const started = signal();
    const held = withRequestContext(client, first[0], async () => {
      const rows = (await client.query(first[1], first[2])).rows;
      started.resolve();
      await gate.promise;
      return rows;
    }).finally(() => client.release());
    await started.promise;
    const waiting = second();
    if (blocks) {
      await lockWait();
    } else {
      await waiting.catch(() => undefined);
    }
    gate.resolve();
    const settled = await Promise.allSettled([held, waiting]);
    return [
      settled[0] as PromiseSettledResult<unknown>,
      settled[1] as PromiseSettledResult<unknown>,
    ];
  };

  describe("crossed locks", () => {
    it("gives two answerers at once one answer; the other is already_closed", async () => {
      const event = await newEvent();
      const { player } = await member(event);
      const asked = await open(player, event);
      const op = await operator(event);
      const [first, second] = await crossed(
        [
          { playerId: op },
          "SELECT * FROM operator_answer_ticket($1, $2, 'Mine', $3)",
          [event, asked.ticket_id, randomUUID()],
        ],
        () => staffAnswer(event, asked.ticket_id, "Ours"),
      );
      expect(first.status).toBe("fulfilled");
      expect(codeOf(second)).toBe("HT409:already_closed");
      expect(await ticketRow(asked.ticket_id)).toMatchObject({ reply: "Mine" });
    });

    it("refuses one answerer's key on two tickets at once: the second waits, then QK422", async () => {
      const event = await newEvent();
      const { player } = await member(event);
      const first = await open(player, event);
      const second = await open(player, event);
      const key = randomUUID();
      const [held, waited] = await crossed(
        [
          team(),
          "SELECT * FROM staff_answer_ticket($1, $2, 'Hi', $3, NULL)",
          [event, first.ticket_id, key],
        ],
        () => staffAnswer(event, second.ticket_id, "Hi", key),
      );
      expect(held.status).toBe("fulfilled");
      expect(codeOf(waited)).toBe("QK422:");
      expect(await ticketRow(second.ticket_id)).toMatchObject({ status: "open" });
    });

    it("replays one answerer's key that waited on the lock", async () => {
      const event = await newEvent();
      const { player } = await member(event);
      const asked = await open(player, event);
      const key = randomUUID();
      const [, second] = await crossed(
        [
          team(),
          "SELECT * FROM staff_answer_ticket($1, $2, 'Hi', $3, NULL)",
          [event, asked.ticket_id, key],
        ],
        () => staffAnswer(event, asked.ticket_id, "Hi", key),
      );
      expect(second).toMatchObject({
        status: "fulfilled",
        value: { replayed: true, outcome: "answered" },
      });
    });

    it("lets one of two sends at the open cap through", async () => {
      const event = await newEvent();
      const { player } = await member(event);
      await open(player, event);
      await open(player, event);
      const [first, second] = await crossed(
        [
          { playerId: player },
          "SELECT * FROM open_ticket($1, 'question', NULL, NULL, 'Third', $2)",
          [event, randomUUID()],
        ],
        () => open(player, event, { body: "Fourth" }),
      );
      expect(first.status).toBe("fulfilled");
      expect(codeOf(second)).toBe("HT409:too_many_open");
    });

    it("makes the same key sent twice at once one ticket, the second a replay", async () => {
      const event = await newEvent();
      const { player } = await member(event);
      const key = randomUUID();
      const [first, second] = await crossed(
        [
          { playerId: player },
          "SELECT * FROM open_ticket($1, 'question', NULL, NULL, 'Hello', $2)",
          [event, key],
        ],
        () => open(player, event, { body: "Hello", key }),
      );
      expect(first.status).toBe("fulfilled");
      expect(second).toMatchObject({ status: "fulfilled", value: { replayed: true } });
      expect(
        await owner("SELECT count(*)::int AS n FROM ticket WHERE player_id = $1", [player]),
      ).toEqual([{ n: 1 }]);
    });

    it("leaves no ticket after an erasure an answer waited on", async () => {
      const event = await newEvent();
      const { player, enrollment } = await member(event);
      const asked = await open(player, event);
      await db.owner.query("BEGIN");
      await db.owner.query("SELECT erase_rows($1, ARRAY[$2]::uuid[], NULL)", [player, enrollment]);
      const waiting = refusal(staffAnswer(event, asked.ticket_id, "Late"));
      await lockWait();
      await db.owner.query("COMMIT");
      expect(await waiting).toBe("HT404");
    });

    it("skips a ticket an answer holds in the sweep; the late answer gives it 90 more days", async () => {
      const ended = await newEvent({ endsIn: "-120 days" });
      const { player, enrollment } = await member(ended);
      const [made] = await owner<{ id: string }>(
        `INSERT INTO ticket (player_id, organizer_id, event_id, enrollment_id, kind, body, idempotency_key, created_at)
         VALUES ($1, $2, $3, $4, 'question', 'old', 'sweep', now() - interval '100 days') RETURNING id`,
        [player, ids.orgA, ended, enrollment],
      );
      const [, swept] = await crossed(
        [
          team(),
          "SELECT * FROM staff_answer_ticket($1, $2, 'Hi', $3, NULL)",
          [ended, made?.id, randomUUID()],
        ],
        () => query<{ n: number }>({}, "SELECT purge_ended_tickets(1000) AS n"),
        false,
      );
      expect(swept).toMatchObject({ status: "fulfilled", value: [{ n: 0 }] });
      // The late answer restarts the clock (T-312, CTO 5): 90 days after the closing.
      expect(await query<{ n: number }>({}, "SELECT purge_ended_tickets(1000) AS n")).toEqual([
        { n: 0 },
      ]);
      await owner("UPDATE ticket SET closed_at = now() - interval '91 days' WHERE id = $1", [
        made?.id,
      ]);
      expect(await query<{ n: number }>({}, "SELECT purge_ended_tickets(1000) AS n")).toEqual([
        { n: 1 },
      ]);
    });
  });

  describe("closed doors", () => {
    it("grants the API role only the entry points (the outsider suite proves PUBLIC holds none)", async () => {
      const rows = await owner<{ proname: string; app: boolean }>(
        `SELECT p.proname, has_function_privilege('questify_app', p.oid, 'EXECUTE') AS app
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = ANY ($1) ORDER BY 1`,
        [
          [
            "help_desk_on",
            "operator_sees_ticket",
            "help_operator",
            "open_ticket",
            "own_tickets",
            "own_unread_tickets",
            "mark_tickets_seen",
            "answer_core",
            "staff_answer_ticket",
            "operator_answer_ticket",
            "event_tickets",
            "event_ticket_counts",
            "operator_ticket",
            "inbox_abilities",
            "inbox_rows",
            "operator_inbox",
            "operator_inbox_count",
            "purge_ended_tickets",
            "open_platform_ticket",
            "ticket_device_fact",
            "staff_escalate_ticket",
            "ticket_admin",
            "console_tickets",
            "console_ticket_counts",
            "console_ticket",
            "admin_answer_ticket",
            "admin_return_ticket",
          ],
        ],
      );
      expect(rows.filter((row) => row.app).map((row) => row.proname)).toEqual([
        "admin_answer_ticket",
        "admin_return_ticket",
        "console_ticket",
        "console_ticket_counts",
        "console_tickets",
        "event_ticket_counts",
        "event_tickets",
        "mark_tickets_seen",
        "open_platform_ticket",
        "open_ticket",
        "operator_answer_ticket",
        "operator_inbox",
        "operator_inbox_count",
        "operator_ticket",
        "own_tickets",
        "own_unread_tickets",
        "purge_ended_tickets",
        "staff_answer_ticket",
        "staff_escalate_ticket",
      ]);
      expect(rows).toHaveLength(27);
    });
  });
});
