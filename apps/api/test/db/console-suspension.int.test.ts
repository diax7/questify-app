import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext, type RequestContext } from "#src/db/context";
import { pushFixture, type PushFixture } from "#test/support/push";
import { TEST_DATABASE_URL, type TestDatabase } from "#test/support/test-db";

type Row = Record<string, unknown>;

/**
 * Suspension in the database (T-701, migration 0114, ADR-406): admin-only doors, an overlay that changes nothing else,
 * and the walls: the ledger by kind (every kind, and the doors that write a hand-over or a sale), joining, the public
 * reads; the payer, the settler, the invitation claim and the push claim skip a suspended event.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("suspension (database)", () => {
  let f: PushFixture;
  let db: TestDatabase;
  let ids: PushFixture["ids"];
  let ownerA: string;
  let admin: string;
  let disabledAdmin: string;
  let enrollmentA: string;

  beforeAll(async () => {
    f = await pushFixture();
    ({ db, ids, ownerA } = f);
    const made = await db.owner.query<{ id: string }>(
      `INSERT INTO staff_user (email, password_hash, platform_role, status)
       VALUES ('admin@questify.test', 'h', 'admin', 'active'), ('gone@questify.test', 'h', 'admin', 'disabled')
       RETURNING id`,
    );
    admin = made.rows[0]?.id ?? "";
    disabledAdmin = made.rows[1]?.id ?? "";
    await db.owner.query(
      "UPDATE event SET access = 'public', join_methods = ARRAY['public_list', 'code'] WHERE id = $1",
      [ids.eventA],
    );
    const enrolled = await db.owner.query<{ id: string }>(
      "SELECT id FROM enrollment WHERE event_id = $1",
      [ids.eventA],
    );
    enrollmentA = enrolled.rows[0]?.id ?? "";
  });
  afterAll(async () => {
    await f.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const as = async <T extends Row>(context: RequestContext, sql: string, values: unknown[] = []) =>
    withRequestContext(db.app, context, async () => (await db.app.query<T>(sql, values)).rows);
  const adminSeat = (): RequestContext => ({ isAdmin: true, staffUserId: admin });
  const memberSeat = (): RequestContext => ({ organizerId: ids.orgA, staffUserId: ownerA });
  const reason = "Reported fraud on the prize desk";
  const suspendEvent = (event = ids.eventA, seat = adminSeat(), why = reason) =>
    as(seat, "SELECT admin_suspend_event($1, $2, $3)", [event, why, randomUUID()]);
  const reactivateEvent = (event = ids.eventA, why: string | null = null) =>
    as(adminSeat(), "SELECT admin_reactivate_event($1, $2, $3)", [event, randomUUID(), why]);
  let counter = 0;
  /** A new live event of organizer A with a join link, so a scenario owns its event and can suspend it alone. */
  const newEvent = async (confirm: "collect_first" | "desk_offer" = "collect_first") => {
    counter += 1;
    const [made] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, access, join_methods, handover_confirm,
                          desk_location_en, starts_at, ends_at)
       VALUES ($1, $2, 'Held Fest', 'live', 'public', ARRAY['link'], $3, 'Hall B', now() - interval '1 hour',
               now() + interval '2 days') RETURNING id`,
      [ids.orgA, `SUSP${counter}`, confirm],
    );
    return made?.id ?? "";
  };
  /** A new player in an event (joined while it is open), so each welcome entry is the first of its enrollment. */
  const newMember = async (event = ids.eventA) => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`held_${counter}`],
    );
    const [made] = await owner<{ id: string }>(
      "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3) RETURNING id",
      [ids.orgA, event, player?.id],
    );
    return { player: player?.id ?? "", enrollment: made?.id ?? "" };
  };
  const freshEnrollment = async () => (await newMember()).enrollment;
  const welcome = (enrollment: string, event = ids.eventA, points = 10) =>
    owner<{ id: string }>(
      `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor)
       VALUES ($1, $2, $3, 'welcome', $4, $4, 'system') RETURNING id`,
      [ids.orgA, event, enrollment, points],
    );
  const ledgerTotals = async () =>
    (
      await owner<{ n: string; score: string; balance: string }>(
        `SELECT count(*) AS n, coalesce(sum(score_delta), 0) AS score, coalesce(sum(balance_delta), 0) AS balance
         FROM ledger_entry WHERE event_id = $1`,
        [ids.eventA],
      )
    )[0];

  const scene = async (confirm: "collect_first" | "desk_offer") => {
    const event = await newEvent(confirm);
    const buyer = await newMember(event);
    await welcome(buyer.enrollment, event, 1000);
    const staff = await newMember(event);
    await owner(
      "INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities) VALUES ($1, $2, $3, ARRAY['hand_over'])",
      [ids.orgA, event, staff.player],
    );
    const [reward] = await owner<{ id: string }>(
      "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, 'item', 'Hoodie', 200, 5) RETURNING id",
      [event],
    );
    return {
      event,
      buyer: buyer.player,
      enrollment: buyer.enrollment,
      desk: staff.player,
      reward: reward?.id ?? "",
    };
  };
  type Scene = Awaited<ReturnType<typeof scene>>;
  const asPlayer = <T extends Row>(player: string, sql: string, values: unknown[] = []) =>
    as<T>({ playerId: player }, sql, values);
  const reserve = async (s: Scene) =>
    (
      await asPlayer<{ redemption_id: string }>(s.buyer, "SELECT * FROM reserve_reward($1, $2)", [
        s.reward,
        randomUUID(),
      ])
    )[0]?.redemption_id ?? "";
  const state = async (s: Scene) =>
    (
      await owner<{ redemptions: string; handed: string; balance: string }>(
        `SELECT count(*) AS redemptions, count(*) FILTER (WHERE status = 'handed_over') AS handed,
                  (SELECT balance FROM enrollment WHERE id = $2) AS balance
           FROM redemption WHERE enrollment_id = $2 AND event_id = $1`,
        [s.event, s.enrollment],
      )
    )[0];
  const status = async (player: string, sql: string, target: string | undefined) =>
    (await asPlayer<{ status: string }>(player, sql, [target]))[0]?.status;

  /** A finished goal with one due payout for a new member of the event, created `ageMinutes` ago. */
  const dueRow = async (event: string, ageMinutes: number) => {
    const { enrollment } = await newMember(event);
    const [goal] = await owner<{ id: string }>(
      `INSERT INTO community_goal (organizer_id, event_id, title_en, measure, target, starts_at, ends_at, status,
                                   final_at)
       VALUES ($1, $2, 'Tower', 'points', 100, now() - interval '2 hours', now() - interval '1 hour', 'reached',
               now())
       RETURNING id`,
      [ids.orgA, event],
    );
    const [step] = await owner<{ id: string }>(
      `INSERT INTO community_step (event_id, goal_id, threshold, is_goal, reward, points)
       VALUES ($1, $2, 100, true, 'points', 20) RETURNING id`,
      [event, goal?.id],
    );
    await owner(
      `INSERT INTO community_payout (step_id, enrollment_id, event_id, created_at)
       VALUES ($1, $2, $3, now() - $4::interval)`,
      [step?.id, enrollment, event, `${ageMinutes} minutes`],
    );
    return { step: step?.id ?? "", enrollment };
  };
  const payoutStatus = async (row: { step: string; enrollment: string }) =>
    (
      await owner<{ status: string }>(
        "SELECT status FROM community_payout WHERE step_id = $1 AND enrollment_id = $2",
        [row.step, row.enrollment],
      )
    )[0]?.status;

  describe("the doors", () => {
    it("refuse anyone but an active platform admin with the request flag", async () => {
      const seats: RequestContext[] = [
        { isAdmin: true, staffUserId: ownerA },
        { isAdmin: true, staffUserId: disabledAdmin },
        { staffUserId: admin },
        memberSeat(),
        { playerId: ids.playerA },
        {},
      ];
      for (const seat of seats) {
        await expect(suspendEvent(ids.eventA, seat)).rejects.toMatchObject({ code: "QE403" });
        await expect(
          as(seat, "SELECT admin_suspend_organizer($1, $2, $3)", [ids.orgA, reason, randomUUID()]),
        ).rejects.toMatchObject({ code: "QE403" });
      }
    });

    it("want a reason of 10 to 300 characters and refuse the same state twice", async () => {
      await expect(suspendEvent(ids.eventA, adminSeat(), "too short")).rejects.toMatchObject({
        code: "SU400",
      });
      await expect(suspendEvent(ids.eventA, adminSeat(), "x".repeat(301))).rejects.toMatchObject({
        code: "SU400",
      });
      await expect(reactivateEvent()).rejects.toMatchObject({ code: "SU409" });
      await suspendEvent();
      await expect(suspendEvent()).rejects.toMatchObject({ code: "SU409" });
      await reactivateEvent();
      await expect(
        as(adminSeat(), "SELECT admin_suspend_event($1, $2, $3)", [randomUUID(), reason, null]),
      ).rejects.toMatchObject({ code: "QA404" });
    });

    it("audit each change as the admin, with the reason, where the organizer's rows are", async () => {
      await suspendEvent();
      await reactivateEvent();
      const rows = await owner<{ action: string; actor_type: string; organizer_id: string }>(
        `SELECT action, actor_type, organizer_id, after, before FROM audit_log
         WHERE event_id = $1 AND action IN ('event.suspend', 'event.reactivate') ORDER BY id DESC LIMIT 2`,
        [ids.eventA],
      );
      expect(rows.map((row) => row.action)).toEqual(["event.reactivate", "event.suspend"]);
      expect(rows[1]).toMatchObject({
        actor_type: "admin",
        organizer_id: ids.orgA,
        after: { reason },
      });
      expect(rows[0]).toMatchObject({ before: { reason } });
    });
  });

  describe("lifting", () => {
    it("records an optional reason, refuses a bad one and leaves the suspension in place", async () => {
      await suspendEvent();
      await expect(reactivateEvent(ids.eventA, "short")).rejects.toMatchObject({ code: "SU400" });
      expect(
        (
          await owner("SELECT 1 FROM event WHERE id = $1 AND suspended_at IS NOT NULL", [
            ids.eventA,
          ])
        ).length,
      ).toBe(1);
      await reactivateEvent(ids.eventA, "The prize desk review is finished");
      await suspendEvent();
      await reactivateEvent();
      const rows = await owner<{ after: unknown }>(
        "SELECT after FROM audit_log WHERE event_id = $1 AND action = 'event.reactivate' ORDER BY id DESC LIMIT 2",
        [ids.eventA],
      );
      expect(rows.map((row) => row.after)).toEqual([
        null,
        { reason: "The prize desk review is finished" },
      ]);
      await as(adminSeat(), "SELECT admin_suspend_organizer($1, $2, $3)", [ids.orgA, reason, null]);
      await as(adminSeat(), "SELECT admin_reactivate_organizer($1, $2, $3)", [
        ids.orgA,
        null,
        "Cleared after the audit",
      ]);
      const [organizer] = await owner<{ after: unknown }>(
        "SELECT after FROM audit_log WHERE organizer_id = $1 AND action = 'organizer.reactivate'",
        [ids.orgA],
      );
      expect(organizer?.after).toEqual({ reason: "Cleared after the audit" });
    });
  });

  describe("the walls", () => {
    describe("the ledger, by kind", () => {
      const REFUSED = [
        "quest",
        "redeem",
        "welcome",
        "handover",
        "award",
        "bonus",
        "community",
        "first_bonus",
        "streak",
        "session",
        "adjust",
      ];
      const ALLOWED = ["redeem_return", "removal"];
      let held: string;
      let welcomeEntry: string;
      let reservation: string;

      beforeAll(async () => {
        held = await freshEnrollment();
        welcomeEntry = (await welcome(held))[0]?.id ?? "";
        const [reward] = await owner<{ id: string }>(
          "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, 'item', 'Cap', 50, 5) RETURNING id",
          [ids.eventA],
        );
        const [made] = await owner<{ id: string }>(
          `INSERT INTO redemption (organizer_id, event_id, enrollment_id, reward_id, price, idempotency_key,
                                   reserved_until)
           VALUES ($1, $2, $3, $4, 50, $5, now() + interval '1 hour') RETURNING id`,
          [ids.orgA, ids.eventA, held, reward?.id, randomUUID()],
        );
        reservation = made?.id ?? "";
        await suspendEvent();
      });
      afterAll(async () => {
        await reactivateEvent();
      });

      /** The wall fires before the table's shape checks, so a refused kind needs no valid row; an allowed one does. */
      const insertKind = (kind: string) =>
        owner(
          `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor,
                                     staff_user_id, reverses, redemption_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          kind === "removal"
            ? [ids.orgA, ids.eventA, held, kind, -10, -10, "staff", ownerA, welcomeEntry, null]
            : kind === "redeem_return"
              ? [ids.orgA, ids.eventA, held, kind, 0, 50, "system", null, null, reservation]
              : [ids.orgA, ids.eventA, held, kind, 10, 10, "system", null, null, null],
        );

      it("covers every kind the table allows", async () => {
        const [row] = await owner<{ def: string }>(
          `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
           WHERE conname = 'ledger_entry_kind_check' AND conrelid = 'ledger_entry'::regclass`,
        );
        const kinds = [...(row?.def ?? "").matchAll(/'([a-z_]+)'::text/g)].map((match) => match[1]);
        expect(kinds.toSorted()).toEqual([...REFUSED, ...ALLOWED].toSorted());
      });

      it.each(REFUSED)(
        "refuses a %s entry from any writer, leaving the totals put",
        async (kind) => {
          const before = await ledgerTotals();
          await expect(insertKind(kind)).rejects.toMatchObject({ code: "ES423" });
          expect(await ledgerTotals()).toEqual(before);
        },
      );

      it("refuses the staff award door", async () => {
        const before = await ledgerTotals();
        await expect(
          as(memberSeat(), "SELECT * FROM staff_award($1, $2, NULL, 5, 'Helped', $3, $4)", [
            ids.eventA,
            enrollmentA,
            randomUUID(),
            randomUUID(),
          ]),
        ).rejects.toMatchObject({ code: "ES423" });
        expect(await ledgerTotals()).toEqual(before);
      });

      it.each(ALLOWED)("lets a %s entry through", async (kind) => {
        const before = Number((await ledgerTotals())?.n);
        await insertKind(kind);
        expect(Number((await ledgerTotals())?.n)).toBe(before + 1);
      });
    });

    describe("the desk doors", () => {
      it("refuse the hand-over of a collected prize, and finish it once the suspension is lifted", async () => {
        const s = await scene("collect_first");
        const id = await reserve(s);
        await asPlayer(s.buyer, "SELECT start_collect($1)", [id]);
        await suspendEvent(s.event);
        await expect(
          asPlayer(s.desk, "SELECT * FROM desk_hand_over($1)", [id]),
        ).rejects.toMatchObject({ code: "ES423" });
        expect(await state(s)).toMatchObject({ handed: "0", balance: "800" });
        await reactivateEvent(s.event);
        expect(await status(s.desk, "SELECT * FROM desk_hand_over($1)", id)).toBe("handed_over");
      });

      it("refuse the player's accept of a desk offer, and finish it once the suspension is lifted", async () => {
        const s = await scene("desk_offer");
        const id = await reserve(s);
        expect(await status(s.desk, "SELECT * FROM desk_hand_over($1)", id)).toBe("offered");
        await suspendEvent(s.event);
        await expect(
          asPlayer(s.buyer, "SELECT * FROM accept_handover($1)", [id]),
        ).rejects.toMatchObject({ code: "ES423" });
        expect(await state(s)).toMatchObject({ handed: "0" });
        await reactivateEvent(s.event);
        expect(await status(s.buyer, "SELECT * FROM accept_handover($1)", id)).toBe("handed_over");
      });

      it("refuse the player's pay of a desk sale, charging nothing, and finish it once lifted", async () => {
        const s = await scene("collect_first");
        await owner("UPDATE event SET reservation_on = false WHERE id = $1", [s.event]);
        const [version] = await owner<{ v: number }>(
          "SELECT my_qr_version AS v FROM player WHERE id = $1",
          [s.buyer],
        );
        const [sale] = await asPlayer<{ sale_id: string }>(
          s.desk,
          "SELECT * FROM desk_offer_sale($1, $2, $3, $4, $5)",
          [s.event, s.buyer, version?.v, s.reward, randomUUID()],
        );
        await suspendEvent(s.event);
        await expect(
          asPlayer(s.buyer, "SELECT * FROM accept_desk_sale($1)", [sale?.sale_id]),
        ).rejects.toMatchObject({ code: "ES423" });
        expect(await state(s)).toMatchObject({ redemptions: "0", balance: "1000" });
        const [offered] = await owner<{ status: string }>(
          "SELECT status FROM desk_sale WHERE id = $1",
          [sale?.sale_id],
        );
        expect(offered?.status).toBe("offered");
        await reactivateEvent(s.event);
        expect(await status(s.buyer, "SELECT * FROM accept_desk_sale($1)", sale?.sale_id)).toBe(
          "accepted",
        );
        expect(await state(s)).toMatchObject({ redemptions: "1", balance: "800" });
      });
    });

    it("refuse every statement that starts after the suspension commits", async () => {
      const held = await freshEnrollment();
      await db.owner.query("BEGIN");
      try {
        await db.owner.query("SELECT 1 FROM event WHERE id = $1", [ids.eventA]);
        await suspendEvent();
        await expect(welcome(held)).rejects.toMatchObject({ code: "ES423" });
      } finally {
        await db.owner.query("ROLLBACK");
      }
      await reactivateEvent();
    });

    it("refuse joining and leave the event out of the public reads", async () => {
      const code = (
        await owner<{ code: string }>("SELECT join_code AS code FROM event WHERE id = $1", [
          ids.eventA,
        ])
      )[0]?.code;
      const [player] = await owner<{ id: string }>(
        "INSERT INTO player (username) VALUES ('late_joiner') RETURNING id",
      );
      const reads = async () => ({
        list: (await as<{ id: string }>({}, "SELECT id FROM public_events(NULL, 100)")).map(
          (row) => row.id,
        ),
        card: (await as({}, "SELECT * FROM public_event($1)", [code])).length,
        quests: (await as({}, "SELECT * FROM public_event_quests($1)", [code])).length,
        rules: (await as({}, "SELECT * FROM public_event_join_rules($1)", [code])).length,
        terms: (await as<{ r: unknown }>({}, "SELECT public_event_rules($1) AS r", [code]))[0]?.r,
      });
      const open = await reads();
      expect(open.list).toContain(ids.eventA);
      expect(open.card).toBe(1);
      await suspendEvent();
      const closed = await reads();
      expect(closed).toMatchObject({ card: 0, quests: 0, rules: 0, terms: null });
      expect(closed.list).not.toContain(ids.eventA);
      await expect(
        owner("INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)", [
          ids.orgA,
          ids.eventA,
          player?.id,
        ]),
      ).rejects.toMatchObject({ code: "ES423" });
      await reactivateEvent();
      expect((await reads()).card).toBe(1);
    });

    it("cover every event of a suspended organizer, and nothing of another organizer", async () => {
      const held = await freshEnrollment();
      await as(adminSeat(), "SELECT admin_suspend_organizer($1, $2, $3)", [
        ids.orgA,
        reason,
        randomUUID(),
      ]);
      const [ids1] = await as<{ ids: string[] }>({}, "SELECT suspended_ids() AS ids");
      expect(ids1?.ids).toContain(ids.eventA);
      expect(ids1?.ids).not.toContain(ids.eventB);
      await expect(welcome(held)).rejects.toMatchObject({ code: "ES423" });
      const [org] = await owner<{ status: string; suspension_reason: string }>(
        "SELECT status, suspension_reason FROM organizer WHERE id = $1",
        [ids.orgA],
      );
      expect(org).toEqual({ status: "paused", suspension_reason: reason });
      await expect(
        as(adminSeat(), "SELECT admin_suspend_organizer($1, $2, $3)", [ids.orgA, reason, null]),
      ).rejects.toMatchObject({ code: "SU409" });
      await as(adminSeat(), "SELECT admin_reactivate_organizer($1, $2)", [ids.orgA, randomUUID()]);
      await welcome(held);
      const [ids2] = await as<{ ids: string[] }>({}, "SELECT suspended_ids() AS ids");
      expect(ids2?.ids).not.toContain(ids.eventA);
    });
  });

  describe("organizer rows (review BLOCKER 1)", () => {
    it("are read-only to the API role: no member can lift a suspension", async () => {
      const [grants] = await owner<{ select: boolean; insert: boolean; update: boolean }>(
        `SELECT has_table_privilege('questify_app', 'organizer', 'SELECT') AS select,
                has_table_privilege('questify_app', 'organizer', 'INSERT') AS insert,
                has_any_column_privilege('questify_app', 'organizer', 'UPDATE') AS update`,
      );
      expect(grants).toEqual({ select: true, insert: false, update: false });
      await as(adminSeat(), "SELECT admin_suspend_organizer($1, $2, $3)", [ids.orgA, reason, null]);
      await expect(
        as(memberSeat(), "UPDATE organizer SET status = 'active' WHERE id = $1", [ids.orgA]),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        as(adminSeat(), "UPDATE organizer SET status = 'active' WHERE id = $1", [ids.orgA]),
      ).rejects.toMatchObject({ code: "42501" });
      await as(adminSeat(), "SELECT admin_reactivate_organizer($1, $2)", [ids.orgA, null]);
    });

    it("keep the suspension columns of an event out of the API's write grant", async () => {
      const [grant] = await owner<{ any: boolean }>(
        `SELECT bool_or(has_column_privilege('questify_app', 'event', c, 'UPDATE')) AS any
         FROM unnest(ARRAY['suspended_at', 'suspended_by', 'suspension_reason']) c`,
      );
      expect(grant?.any).toBe(false);
    });
  });

  describe("batches skip a suspended event", () => {
    it("the community payer leaves a suspended event's due row due and pays another event's in the same batch", async () => {
      const [held, open] = [await newEvent(), await newEvent()];
      const heldRow = await dueRow(held, 30);
      const openRow = await dueRow(open, 5);
      await suspendEvent(held);
      const batch = await as({}, "SELECT * FROM pay_community_batch(500, NULL)");
      expect(batch).toEqual([{ step_id: openRow.step, paid: 1, skipped: 0 }]);
      expect(await payoutStatus(heldRow)).toBe("due");
      expect(await payoutStatus(openRow)).toBe("paid");
      await reactivateEvent(held);
      await as({}, "SELECT * FROM pay_community_batch(500, NULL)");
      expect(await payoutStatus(heldRow)).toBe("paid");
    });

    it("settle_goal answers busy for a suspended event and settles it once lifted", async () => {
      const event = await newEvent();
      const [goal] = await owner<{ id: string }>(
        `INSERT INTO community_goal (organizer_id, event_id, title_en, measure, target, starts_at, ends_at)
         VALUES ($1, $2, 'Tower', 'points', 100, now() - interval '10 minutes', now() + interval '1 hour')
         RETURNING id`,
        [ids.orgA, event],
      );
      const settle = async () =>
        (await as<{ s: string }>({}, "SELECT settle_goal($1) AS s", [goal?.id]))[0]?.s;
      const settledUntil = async () =>
        (
          await owner<{ at: Date | null }>(
            "SELECT settled_until AS at FROM community_goal WHERE id = $1",
            [goal?.id],
          )
        )[0]?.at;
      await suspendEvent(event);
      expect(await settle()).toBe("busy");
      expect(await settledUntil()).toBeNull();
      await reactivateEvent(event);
      expect(await settle()).not.toBe("busy");
      expect(await settledUntil()).not.toBeNull();
    });

    it("the invitation claim holds a suspended event's campaign untouched and claims another's", async () => {
      const [held, open] = [await newEvent(), await newEvent()];
      const campaign = async (event: string) =>
        (
          await owner<{ id: string }>(
            `INSERT INTO invitation_campaign (organizer_id, event_id, request_id, fingerprint, size, state, channels,
                                              cap, send_at, name_en)
             VALUES ($1, $2, gen_random_uuid(), 'f', 50, 'sending', ARRAY['push'], 50, now(), 'Spring')
             RETURNING id`,
            [ids.orgA, event],
          )
        )[0]?.id ?? "";
      const [heldCampaign, openCampaign] = [await campaign(held), await campaign(open)];
      const claim = async () =>
        (
          await owner<{ ids: string[] }>("SELECT invitation_claim_campaigns($1) AS ids", [
            [heldCampaign, openCampaign],
          ])
        )[0]?.ids;
      await suspendEvent(held);
      expect(await claim()).toEqual([openCampaign]);
      const [still] = await owner<{ state: string; end_reason: string | null }>(
        "SELECT state, end_reason FROM invitation_campaign WHERE id = $1",
        [heldCampaign],
      );
      expect(still).toEqual({ state: "sending", end_reason: null });
      await reactivateEvent(held);
      expect((await claim())?.toSorted()).toEqual([heldCampaign, openCampaign].toSorted());
    });

    it("the push claim skips a suspended event's notice and sends another's", async () => {
      await f.switchPush(true);
      await f.drain();
      const kind = await f.kind({ class: "event" });
      const [held, open] = [
        await f.newEvent({ phase: "live" }),
        await f.newEvent({ phase: "live" }),
      ];
      const [heldPhone, openPhone] = [await f.playerWithPhone(), await f.playerWithPhone()];
      await f.join(held, heldPhone.who);
      await f.join(open, openPhone.who);
      const heldNotice = await f.notice(kind, { event: held });
      const openNotice = await f.notice(kind, { event: open });
      await f.fanOut();
      await suspendEvent(held);
      expect(await f.claim()).toHaveLength(1);
      const codes = async (id: string | null) =>
        (await f.sends(id)).map((row) => `${row.state}:${row.code}`);
      expect(await codes(heldNotice)).toEqual(["skipped:suspended"]);
      expect(await codes(openNotice)).toEqual(["sending:null"]);
    });
  });
});
