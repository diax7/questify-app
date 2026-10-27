import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "#src/db/context";
import { questifyFixture, type QuestifyFixture } from "#test/support/questify";
import { blocked } from "#test/support/souvenirs";
import { TEST_DATABASE_URL, addMember } from "#test/support/test-db";

type Member = { player: string; enrollment: string };
type Kind = "reward" | "rank_prize" | "quest_item";

const refusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
    return "none";
  } catch (error) {
    const pg = error as { code?: string; detail?: string };
    return pg.detail === undefined || pg.detail === "" ? `${pg.code}` : `${pg.code}:${pg.detail}`;
  }
};

/** Ends a held transaction and gives its connection back. */
const finish = async (client: PoolClient, end: "COMMIT" | "ROLLBACK") => {
  try {
    await client.query(end);
  } finally {
    client.release();
  }
};

/**
 * Archiving ended events in the database (T-411, migration 0075, ADR-337 (5), ADR-341): the tick's last step moves an
 * ended event to archived only when its shop is closed, no redemption of any kind is reserved, its results are revealed
 * or 60 days have passed, and no ticket of it is open; audited, idempotent, safe with two runs at once and with a door
 * in flight in either order; final for every role; and what the player keeps still reads.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("archiving ended events (database)", () => {
  let f: QuestifyFixture;
  let editor = "";

  beforeAll(async () => {
    f = await questifyFixture();
    editor = await addMember(f.db.owner, f.ids.orgA, "editor");
  });
  afterAll(async () => {
    await f.close();
  });

  /** One run of the step as the API's tick calls it (no context). */
  const tick = async () =>
    (await f.run<{ n: number }>({}, "SELECT archive_ended_events() AS n"))[0]?.n;
  const statusOf = async (event: string) =>
    (await f.owner<{ status: string }>("SELECT status FROM event WHERE id = $1", [event]))[0]
      ?.status;
  const archiveRows = (event: string) =>
    f.owner(
      `SELECT actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before, after, request_id
       FROM audit_log WHERE event_id = $1 AND after ->> 'status' = 'archived'`,
      [event],
    );

  const revealed = (event: string) =>
    f.owner(
      `INSERT INTO event_result (event_id, organizer_id, revealed_at, claim_until)
       SELECT id, organizer_id, now(), now() + interval '1 day' FROM event WHERE id = $1`,
      [event],
    );
  type Spec = { endedAgo?: string; days?: number; results?: "revealed" | "confirmed" | "none" };
  /**
   * An ended event of organizer A (public, a desk), its end `endedAgo` back (31 days: past the help desk's 30-day
   * sending window, so due unless something holds it); results revealed unless said.
   */
  const endedEvent = async (spec: Spec = {}): Promise<string> => {
    const event = await f.newEvent({ phase: "ended" });
    await f.owner(
      `UPDATE event SET status = 'ended', starts_at = now() - $2::interval - interval '1 day',
                        ends_at = now() - $2::interval, shop_days_after = $3
       WHERE id = $1`,
      [event, spec.endedAgo ?? "31 days", spec.days ?? 3],
    );
    const results = spec.results ?? "revealed";
    if (results === "revealed") {
      await revealed(event);
    } else if (results === "confirmed") {
      await f.owner(
        "INSERT INTO event_result (event_id, organizer_id) SELECT id, organizer_id FROM event WHERE id = $1",
        [event],
      );
    }
    return event;
  };
  const member = async (event: string): Promise<Member> => {
    const player = await f.newPlayer();
    return { player, enrollment: await f.join(event, player, "code") };
  };

  /** A reserved redemption of `kind` in `event`, written as its door writes it (the owner, past the doors' checks). */
  const hold = async (event: string, who: Member, kind: Kind): Promise<string> => {
    const [source] =
      kind === "reward"
        ? await f.owner<{ id: string }>(
            "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, 'item', 'Cap', 5, 5) RETURNING id",
            [event],
          )
        : kind === "rank_prize"
          ? await f.owner<{ id: string }>(
              `INSERT INTO rank_prize (organizer_id, event_id, rank_from, rank_to, kind, name_en)
               SELECT organizer_id, id, 1, 1, 'experience', 'Stage tour' FROM event WHERE id = $1 RETURNING id`,
              [event],
            )
          : await f.owner<{ id: string }>(
              "INSERT INTO quest_item (event_id, name_en, stock_total) VALUES ($1, 'Pin', 5) RETURNING id",
              [event],
            );
    const [made] = await f.owner<{ id: string }>(
      `INSERT INTO redemption (organizer_id, event_id, enrollment_id, reward_id, rank_prize_id, quest_item_id, price,
                               idempotency_key, reserved_until, source_category_id, source_period)
       SELECT e.organizer_id, e.id, $2, $3, $4, $5, $6, $7, now() + interval '1 hour', $8,
              CASE WHEN $8::uuid IS NOT NULL THEN now() END
       FROM event e WHERE e.id = $1 RETURNING id`,
      [
        event,
        who.enrollment,
        kind === "reward" ? source?.id : null,
        kind === "rank_prize" ? source?.id : null,
        kind === "quest_item" ? source?.id : null,
        kind === "reward" ? 5 : 0,
        `${kind} ${randomUUID()}`,
        kind === "quest_item"
          ? (
              await f.owner<{ id: string }>("SELECT id FROM category WHERE event_id = $1 LIMIT 1", [
                event,
              ])
            )[0]?.id
          : null,
      ],
    );
    return made?.id ?? "";
  };
  /** An open ticket of `event` sent by `who`, in the event team's queue or escalated to Questify's. */
  const ticket = async (event: string, who: Member, queue: "event" | "questify" = "event") =>
    (
      await f.owner<{ id: string }>(
        `INSERT INTO ticket (player_id, organizer_id, event_id, enrollment_id, kind, body, idempotency_key, queue,
                             escalated_at, escalated_by_staff, escalation_note)
         SELECT $2, organizer_id, id, $3, 'question', 'Where is the stage?', $4, $5,
                CASE WHEN $5 = 'questify' THEN now() END, CASE WHEN $5 = 'questify' THEN $6::uuid END,
                CASE WHEN $5 = 'questify' THEN 'We tried' END
         FROM event WHERE id = $1 RETURNING id`,
        [event, who.player, who.enrollment, randomUUID(), queue, f.ownerA],
      )
    )[0]?.id ?? "";
  const openTicket = (player: string, event: string, client?: PoolClient) => {
    const sql = "SELECT * FROM open_ticket($1, 'question', NULL, NULL, 'Is the shop closed?', $2)";
    const values = [event, randomUUID()];
    return client === undefined
      ? f.asPlayer(player, sql, values)
      : client.query(sql, values).then((result) => result.rows);
  };

  /** A held transaction on its own connection as `context`; the caller commits or rolls back and releases it. */
  const held = async (context: RequestContext): Promise<PoolClient> => {
    const client = await f.pool.connect();
    await client.query("BEGIN");
    for (const [key, value] of Object.entries({
      "app.player_id": context.playerId,
      "app.organizer_id": context.organizerId,
      "app.staff_user_id": context.staffUserId,
    })) {
      if (value !== undefined) await client.query("SELECT set_config($1, $2, true)", [key, value]);
    }
    return client;
  };

  /**
   * A member's transaction begun just before the boundary where the step may first archive: the end is moved to 30
   * days before its start, plus 1 µs, with a 30-day shop window, so for it the shop and the help desk's sending are
   * still open, and for any later transaction both have closed and the event (revealed, nothing held) is due.
   */
  const beganBeforeTheBoundary = async () => {
    const event = await endedEvent({ endedAgo: "1 day", days: 3 });
    const who = await member(event);
    await f.earn(event, who.enrollment, { points: 50 });
    const [reward] = await f.owner<{ id: string }>(
      "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, 'item', 'Cap', 5, 5) RETURNING id",
      [event],
    );
    const door = await held({ playerId: who.player });
    try {
      const [start] = (await door.query<{ at: string }>("SELECT now()::text AS at")).rows;
      await f.owner(
        `UPDATE event SET starts_at = $2::timestamptz - interval '31 days',
                          ends_at = $2::timestamptz - interval '30 days' + interval '1 microsecond',
                          shop_days_after = 30
         WHERE id = $1`,
        [event, start?.at],
      );
      const [open] = (
        await door.query(
          `SELECT shop_state(status, starts_at, ends_at, shop_days_after) AS shop,
                  ends_at + interval '30 days' > now() AS sending
           FROM event WHERE id = $1`,
          [event],
        )
      ).rows;
      expect(open).toEqual({ shop: "open", sending: true });
    } catch (error) {
      await finish(door, "ROLLBACK");
      throw error;
    }
    const reserve = () =>
      door.query("SELECT * FROM reserve_reward($1, $2)", [reward?.id, randomUUID()]);
    const send = () => openTicket(who.player, event, door);
    return { event, who, door, reserve, send };
  };
  /**
   * Runs the step on its own held connection (past the boundary, it archives the event, uncommitted), starts `work` on
   * the door, waits until the door blocks on the step's lock, commits the step and answers the door's refusal.
   */
  const crossStep = async (event: string, door: PoolClient, work: () => Promise<unknown>) => {
    const step = await held({});
    let pending: Promise<string> | undefined;
    try {
      const [past] = (
        await step.query(
          "SELECT now() >= ends_at + interval '30 days' AS past FROM event WHERE id = $1",
          [event],
        )
      ).rows;
      expect(past).toEqual({ past: true });
      await step.query("SELECT archive_ended_events()");
      const [pid] = (await door.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows;
      pending = refusal(work());
      await blocked(f.db.owner, pid?.pid ?? 0);
    } catch (error) {
      await finish(step, "ROLLBACK");
      await pending;
      throw error;
    }
    await finish(step, "COMMIT");
    return pending;
  };

  /** Moves the end to `days` before now() plus `offset` and runs the step, in one owner transaction (one now()). */
  const endedAt = async (event: string, days: number, offset: string) => {
    await f.owner("BEGIN");
    try {
      await f.owner(
        `UPDATE event SET starts_at = now() - make_interval(days => $2 + 1),
                          ends_at = now() - make_interval(days => $2) + $3::interval WHERE id = $1`,
        [event, days, offset],
      );
      await f.owner("SELECT archive_ended_events()");
      return await statusOf(event);
    } finally {
      await f.owner("COMMIT");
    }
  };

  describe("the conditions", () => {
    it("archives an ended event once its shop is closed, 30 days have passed, results are revealed, nothing is reserved and no ticket is open", async () => {
      const event = await endedEvent();
      await member(event);
      expect(await tick()).toBeGreaterThanOrEqual(1);
      expect(await statusOf(event)).toBe("archived");
    });

    it("keeps it ended while any redemption is reserved: a shop hold, a rank prize or a quest item", async () => {
      for (const kind of ["reward", "rank_prize", "quest_item"] as const) {
        const event = await endedEvent();
        const who = await member(event);
        await hold(event, who, kind);
        await tick();
        expect(await statusOf(event), kind).toBe("ended");
      }
    });

    it("keeps it ended while a ticket of the event is open, in the team's queue or escalated to Questify", async () => {
      for (const queue of ["event", "questify"] as const) {
        const event = await endedEvent();
        await ticket(event, await member(event), queue);
        await tick();
        expect(await statusOf(event), queue).toBe("ended");
      }
    });

    it("keeps it ended inside 60 days while results are not revealed, confirmed or not", async () => {
      for (const results of ["none", "confirmed"] as const) {
        const event = await endedEvent({ endedAgo: "59 days", results });
        await tick();
        expect(await statusOf(event), results).toBe("ended");
      }
    });

    it("keeps it ended while the shop is open (always inside the 30 days), and waits for the lifecycle's move", async () => {
      const open = await endedEvent({ endedAgo: "1 day", days: 3 });
      const notMoved = await endedEvent();
      await f.owner("UPDATE event SET status = 'live' WHERE id = $1", [notMoved]);
      await tick();
      expect([await statusOf(open), await statusOf(notMoved)]).toEqual(["ended", "live"]);
      await f.run({}, "SELECT advance_event_lifecycle()");
      await tick();
      expect([await statusOf(open), await statusOf(notMoved)]).toEqual(["ended", "archived"]);
    });

    it("archives at exactly ends_at + 60 days with no reveal, and not a microsecond before", async () => {
      const event = await endedEvent({ results: "none" });
      expect(await endedAt(event, 60, "1 microsecond")).toBe("ended");
      expect(await endedAt(event, 60, "0")).toBe("archived");
    });

    it("waits out the help desk's 30-day sending window: ended 29 days ago it stays, at 30 days it goes", async () => {
      const event = await endedEvent({ endedAgo: "29 days", days: 0 });
      await tick();
      expect(await statusOf(event)).toBe("ended");
      expect(await endedAt(event, 30, "1 microsecond")).toBe("ended");
      expect(await endedAt(event, 30, "0")).toBe("archived");
    });

    it("archives once the last hold has timed out and the last ticket is answered", async () => {
      const event = await endedEvent({ endedAgo: "1 day", days: 3 });
      const who = await member(event);
      await f.earn(event, who.enrollment, { points: 50 });
      const [reward] = await f.owner<{ id: string }>(
        "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, 'item', 'Cap', 5, 5) RETURNING id",
        [event],
      );
      const [reserved] = await f.asPlayer<{ redemption_id: string; status: string }>(
        who.player,
        "SELECT * FROM reserve_reward($1, $2)",
        [reward?.id, randomUUID()],
      );
      expect(reserved?.status).toBe("reserved");
      const [sent] = (await openTicket(who.player, event)) as { ticket_id: string }[];
      // The shop and the sending window close (the owner connection moves the end back, past every guard).
      await f.owner(
        "UPDATE event SET starts_at = now() - interval '32 days', ends_at = now() - interval '31 days' WHERE id = $1",
        [event],
      );
      await tick();
      expect(await statusOf(event)).toBe("ended");
      await f.owner(
        "UPDATE redemption SET reserved_until = now() - interval '1 minute' WHERE id = $1",
        [reserved?.redemption_id],
      );
      for (let i = 0; i < 20; i += 1) {
        const [row] = await f.run<{ o: string | null }>({}, "SELECT expire_one_reservation() AS o");
        if (row?.o === null) break;
      }
      await tick();
      expect(await statusOf(event)).toBe("ended");
      await f.run(f.team(), "SELECT * FROM staff_answer_ticket($1, $2, NULL, $3, $4)", [
        event,
        sent?.ticket_id,
        randomUUID(),
        randomUUID(),
      ]);
      await tick();
      expect(await statusOf(event)).toBe("archived");
    });
  });

  describe("the move", () => {
    it("writes one audit row like the other lifecycle moves, and a second run changes nothing", async () => {
      const event = await endedEvent();
      await tick();
      await tick();
      expect(await archiveRows(event)).toEqual([
        {
          actor_type: "system",
          actor_id: null,
          organizer_id: f.ids.orgA,
          event_id: event,
          action: "event.lifecycle",
          target_type: "event",
          target_id: event,
          before: { status: "ended" },
          after: { status: "archived" },
          request_id: null,
        },
      ]);
      expect(await statusOf(event)).toBe("archived");
    });

    it("lets two runs at once archive an event once: the second passes it by without waiting", async () => {
      const event = await endedEvent();
      const first = await held({});
      const second = await held({});
      try {
        await first.query("SELECT archive_ended_events()");
        // A wait on the first run's lock would fail here, not hang: SKIP LOCKED never waits.
        await second.query("SET LOCAL lock_timeout = '2s'");
        await second.query("SELECT archive_ended_events()");
        expect(await statusOf(event)).toBe("ended");
      } finally {
        await finish(second, "COMMIT");
        await finish(first, "COMMIT");
      }
      expect(await statusOf(event)).toBe("archived");
      expect(await archiveRows(event)).toHaveLength(1);
    });
  });

  describe("a door in flight during the step", () => {
    it("keeps the event ended when a ticket was sent first, before or after it commits", async () => {
      const { event, door, send } = await beganBeforeTheBoundary();
      try {
        await send();
        await tick();
        expect(await statusOf(event)).toBe("ended");
      } finally {
        await finish(door, "COMMIT");
      }
      await tick();
      expect(await statusOf(event)).toBe("ended");
    });

    it("refuses a ticket that waited on the step with sending_closed, and leaves none", async () => {
      const { event, door, send } = await beganBeforeTheBoundary();
      try {
        expect(await crossStep(event, door, send)).toBe("HT403:sending_closed");
      } finally {
        await finish(door, "ROLLBACK");
      }
      expect(await statusOf(event)).toBe("archived");
      expect(await f.owner("SELECT id FROM ticket WHERE event_id = $1", [event])).toEqual([]);
    });

    it("keeps the event ended when a reservation was made first, before or after it commits", async () => {
      const { event, door, reserve } = await beganBeforeTheBoundary();
      try {
        expect((await reserve()).rows[0]).toMatchObject({ status: "reserved" });
        await tick();
        expect(await statusOf(event)).toBe("ended");
      } finally {
        await finish(door, "COMMIT");
      }
      await tick();
      expect(await statusOf(event)).toBe("ended");
    });

    it("refuses a reservation that waited on the step with the shop's closed, and leaves none", async () => {
      const { event, who, door, reserve } = await beganBeforeTheBoundary();
      try {
        expect(await crossStep(event, door, reserve)).toBe("RS403:closed");
      } finally {
        await finish(door, "ROLLBACK");
      }
      expect(await statusOf(event)).toBe("archived");
      expect(
        await f.owner("SELECT id FROM redemption WHERE enrollment_id = $1", [who.enrollment]),
      ).toEqual([]);
    });
  });

  describe("nothing new in an archived event", () => {
    it("refuses every kind of redemption and an event ticket with the door's own refusal, for every role", async () => {
      const event = await endedEvent();
      const who = await member(event);
      await tick();
      expect(await statusOf(event)).toBe("archived");
      expect(await refusal(hold(event, who, "reward"))).toBe("RS403:closed");
      expect(await refusal(hold(event, who, "rank_prize"))).toBe("RF409:not_ended");
      expect(await refusal(hold(event, who, "quest_item"))).toBe("QN403:ended");
      expect(await refusal(ticket(event, who))).toBe("HT403:sending_closed");
      expect(await refusal(openTicket(who.player, event))).toBe("HT403:sending_closed");
    });
  });

  describe("archived is final", () => {
    it("refuses the owner and an editor archiving or un-archiving by a direct update", async () => {
      const archived = await endedEvent();
      await tick();
      expect(await statusOf(archived)).toBe("archived");
      const pending = await endedEvent({ endedAgo: "1 day" });
      for (const staff of [f.ownerA, editor]) {
        for (const [id, status] of [
          [pending, "archived"],
          [archived, "ended"],
          [archived, "live"],
        ] as const) {
          expect(
            await refusal(
              f.run(f.team(staff), "UPDATE event SET status = $2 WHERE id = $1", [id, status]),
            ),
          ).toBe("42501");
        }
      }
      expect([await statusOf(archived), await statusOf(pending)]).toEqual(["archived", "ended"]);
    });

    it("lets no door end it again, and no role move it out of archived", async () => {
      const event = await endedEvent();
      await tick();
      expect(await refusal(f.run(f.team(), "SELECT end_event_early($1, NULL)", [event]))).toBe(
        "QE409",
      );
      for (const status of ["ended", "live", "scheduled", "draft"]) {
        expect(
          await refusal(f.owner("UPDATE event SET status = $2 WHERE id = $1", [event, status])),
        ).toBe("QE409:archived");
      }
      await f.owner("UPDATE event SET status = 'archived', name_en = 'Renamed' WHERE id = $1", [
        event,
      ]);
      expect(await statusOf(event)).toBe("archived");
    });

    it("archives only by the rules when an organizer runs the step: it takes no event", async () => {
      const open = await endedEvent({ endedAgo: "1 day" });
      await f.run(f.team(), "SELECT archive_ended_events()");
      await f.run(f.team(f.ownerA, f.ids.orgB), "SELECT archive_ended_events()");
      expect(await statusOf(open)).toBe("ended");
    });
  });

  describe("what the player keeps", () => {
    it("still reads the passport, the recap, the public stamp and the profile after archiving", async () => {
      const event = await endedEvent({ results: "none" });
      const who = await member(event);
      await f.earn(event, who.enrollment, { points: 40 });
      expect(await f.confirm(event)).toBe("confirmed");
      expect(await f.reveal(event)).toBe("revealed");
      const read = async () => ({
        passport: await f.asPlayer(
          who.player,
          "SELECT event_status, score, played, rank, rank_state FROM own_events(false, NULL, NULL, 50) WHERE event_id = $1",
          [event],
        ),
        recap: await f.asPlayer(
          who.player,
          "SELECT rank, rank_state, quests_done FROM event_recap($1)",
          [event],
        ),
        stamps: (
          await f.owner<{ p: unknown[] }>("SELECT public_passport($1) AS p", [who.player])
        )[0]?.p,
        xp: await f.owner("SELECT * FROM player_xp WHERE player_id = $1", [who.player]),
      });
      const before = await read();
      await tick();
      expect(await statusOf(event)).toBe("archived");
      const after = await read();
      expect(after.passport).toEqual([
        { event_status: "archived", score: "40", played: true, rank: 1, rank_state: "final" },
      ]);
      expect(after.recap).toEqual([{ rank: 1, rank_state: "final", quests_done: 1 }]);
      expect(after.stamps).toHaveLength(1);
      expect(after.xp).toEqual(before.xp);
      expect({ ...before.passport[0], event_status: "archived" }).toEqual(after.passport[0]);
      expect(before.recap).toEqual(after.recap);
      expect(before.stamps).toEqual(after.stamps);
    });
  });
});
