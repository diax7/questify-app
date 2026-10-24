import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext, type RequestContext } from "#src/db/context";
import { REHEARSAL_CAP, newRehearsalCode } from "#src/rehearsal/rehearsal";
import {
  TEST_DATABASE_URL,
  addMember,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

type Row = Record<string, unknown>;

const noop = (): void => undefined;

/** Waits until a start set a second ahead on the clock has passed. */
const startPasses = () => new Promise((resolve) => setTimeout(resolve, 1200));

const refusal = async (work: Promise<unknown>): Promise<{ code: string; detail?: string }> => {
  try {
    await work;
  } catch (error) {
    const { code, detail } = error as { code: string; detail?: string };
    return detail === undefined ? { code } : { code, detail };
  }
  throw new Error("expected a refusal");
};

/**
 * Rehearsal mode in the database (T-211, migration 0032): who joins, every writer in rehearsal, the go-live wipe and
 * the team's erase, the ledger's one exception, the races at the start, and the guards that keep later tables and
 * writers inside the design.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("rehearsal mode (database)", () => {
  let db: TestDatabase;
  let pool: Pool;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let ownerA = "";
  let editorA = "";
  let ownerB = "";
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new Pool({ connectionString: db.appUrl, max: 8 });
    ids = await seedTwoTenants(db.owner);
    ownerA = await addMember(db.owner, ids.orgA, "owner");
    editorA = await addMember(db.owner, ids.orgA, "editor");
    ownerB = await addMember(db.owner, ids.orgB, "owner");
  });
  afterAll(async () => {
    await pool.end();
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  const run = async <T extends Row>(
    context: RequestContext,
    sql: string,
    values: unknown[] = [],
  ) => {
    const client = await pool.connect();
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
  const call = <T extends Row>(player: string, sql: string, values: unknown[] = []) =>
    run<T>({ playerId: player }, sql, values);
  const team = (staff: string, organizer = ids.orgA): RequestContext => ({
    organizerId: organizer,
    staffUserId: staff,
  });

  /** A Draft (or Scheduled) event starting tomorrow, with a desk whose only hours are the day after. */
  const newEvent = async (status = "draft", organizer = ids.orgA): Promise<string> => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at, desk_location_en,
                          desk_hours)
       VALUES ($1, $2, 'Rehearsal Fest', $3, now() + interval '1 day', now() + interval '3 days', 'Hall B',
               tstzmultirange(tstzrange(now() + interval '2 days', now() + interval '2 days 2 hours')))
       RETURNING id`,
      [organizer, `REH${counter}`, status],
    );
    return event?.id ?? "";
  };

  const newQuest = async (event: string, points = 10): Promise<string> => {
    const [quest] = await owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, visible, type_config)
       SELECT $1, id, 'scan_qr', 'Lion', $2, 100, true, '{}' FROM category WHERE event_id = $1 LIMIT 1
       RETURNING id`,
      [event, points],
    );
    return quest?.id ?? "";
  };

  const newReward = async (event: string, kind = "item", stock = 5): Promise<string> =>
    (
      await owner<{ id: string }>(
        `INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, $2, 'Hoodie', 10, $3)
         RETURNING id`,
        [event, kind, stock],
      )
    )[0]?.id ?? "";

  const newPlayer = async (): Promise<string> => {
    counter += 1;
    return (
      (
        await owner<{ id: string }>("INSERT INTO player (username) VALUES ($1) RETURNING id", [
          `reh_player_${counter}`,
        ])
      )[0]?.id ?? ""
    );
  };

  const open = async (event: string, staff = ownerA): Promise<string> =>
    (
      await run<{ code: string }>(team(staff), "SELECT open_rehearsal($1, $2) AS code", [
        event,
        newRehearsalCode(),
      ])
    )[0]?.code ?? "";

  const join = (player: string, code: string) =>
    call<{ outcome: string; enrollment_id: string | null; event_id: string | null }>(
      player,
      "SELECT * FROM join_rehearsal($1, '1')",
      [code],
    );

  /** A player who joined the event's rehearsal; the rehearsal is opened when needed. */
  const rehearser = async (event: string) => {
    const code = (
      await owner<{ code: string }>("SELECT code FROM event_rehearsal WHERE event_id = $1", [event])
    )[0]?.code;
    const player = await newPlayer();
    const [row] = await join(player, code ?? (await open(event)));
    return { player, enrollment: row?.enrollment_id ?? "" };
  };

  /** A real member, joined by code (scheduled events only allow that before go-live). */
  const realPlayer = async (event: string) => {
    const player = await newPlayer();
    const [row] = await owner<{ id: string }>(
      `INSERT INTO enrollment (organizer_id, event_id, player_id, joined_via, card_version)
       SELECT organizer_id, id, $2, 'code', '1' FROM event WHERE id = $1 RETURNING id`,
      [event, player],
    );
    return { player, enrollment: row?.id ?? "" };
  };

  const scan = (player: string, quest: string, device: string | null = null) =>
    call<{ completion_id: string; score: string }>(
      player,
      "SELECT * FROM complete_quest($1, 'qr', 1, NULL, $2, $3)",
      [quest, randomUUID(), device],
    );

  const reserve = async (player: string, reward: string) =>
    (
      await call<{ redemption_id: string; status: string; code_cipher: Buffer | null }>(
        player,
        "SELECT * FROM reserve_reward($1, $2)",
        [reward, randomUUID()],
      )
    )[0];

  /** The event goes live as the tick moves it (the start is in the future, so only the stored status says live). */
  const goLive = (event: string) =>
    owner("UPDATE event SET status = 'live' WHERE id = $1", [event]);

  const ensure = async (event: string) =>
    (await run<{ wiped: boolean }>({}, "SELECT ensure_rehearsal_wiped($1) AS wiped", [event]))[0]
      ?.wiped;

  const rehearsalRows = async (event: string) =>
    (
      await owner<{
        entries: string;
        accounts: string;
        completions: string;
        redemptions: string;
        flags: string;
      }>(
        `SELECT (SELECT count(*) FROM ledger_entry WHERE event_id = $1 AND rehearsal) AS entries,
                (SELECT count(*) FROM enrollment WHERE event_id = $1 AND joined_via = 'rehearsal') AS accounts,
                (SELECT count(*) FROM quest_completion c JOIN enrollment n ON n.id = c.enrollment_id
                 WHERE c.event_id = $1 AND n.joined_via = 'rehearsal') AS completions,
                (SELECT count(*) FROM redemption WHERE event_id = $1) AS redemptions,
                (SELECT count(*) FROM flag WHERE event_id = $1) AS flags`,
        [event],
      )
    )[0];

  const dueWipes = async () =>
    (await run<{ due_rehearsal_wipes: string }>({}, "SELECT * FROM due_rehearsal_wipes()")).map(
      (row) => row.due_rehearsal_wipes,
    );

  /** Runs one statement as the owner with the wipe's setting naming `setting`, and rolls it back. */
  const withWipeSetting = async (setting: string, sql: string, id: string | undefined) => {
    await db.owner.query("BEGIN");
    try {
      await db.owner.query("SELECT set_config('questify.rehearsal_wipe', $1, true)", [setting]);
      await db.owner.query(sql, [id]);
    } finally {
      await db.owner.query("ROLLBACK");
    }
  };

  describe("joining", () => {
    it("opens one code per event, which the team reads again", async () => {
      const event = await newEvent();
      const code = await open(event);
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
      expect(await open(event, editorA)).toBe(code);
      const [card] = await run<{ code: string; accounts: number; status_now: string }>(
        team(editorA),
        "SELECT * FROM rehearsal_card($1)",
        [event],
      );
      expect(card).toMatchObject({ code, accounts: 0, status_now: "draft" });
    });

    it("joins a Draft as a rehearsal account, once, with no welcome points and no seat", async () => {
      const event = await newEvent();
      await owner(
        "UPDATE event SET welcome_points = 50, player_limit_mode = 'hard', player_limit = 1 WHERE id = $1",
        [event],
      );
      const code = await open(event);
      const player = await newPlayer();
      const [first] = await join(player, code.toLowerCase());
      expect(first).toMatchObject({ outcome: "joined", event_id: event });
      expect((await join(player, code))[0]).toMatchObject({
        outcome: "already",
        enrollment_id: first?.enrollment_id,
      });
      await join(await newPlayer(), code);
      const [row] = await owner<{ joined_via: string; score: string; seats: number }>(
        "SELECT joined_via, score, event_seats($2) AS seats FROM enrollment WHERE id = $1",
        [first?.enrollment_id, event],
      );
      expect(row).toMatchObject({ joined_via: "rehearsal", score: "0", seats: 0 });
    });

    it("answers closed for a wrong code, a rotated one and a live event, and already_player for a member", async () => {
      const event = await newEvent("scheduled");
      const code = await open(event);
      expect((await join(await newPlayer(), "ZZZZ-ZZZZ"))[0]?.outcome).toBe("closed");
      const member = await realPlayer(event);
      expect((await join(member.player, code))[0]?.outcome).toBe("already_player");
      const [rotated] = await run<{ code: string }>(
        team(editorA),
        "SELECT rotate_rehearsal_code($1, $2, $3) AS code",
        [event, newRehearsalCode(), randomUUID()],
      );
      expect((await join(await newPlayer(), code))[0]?.outcome).toBe("closed");
      expect((await join(await newPlayer(), rotated?.code ?? ""))[0]?.outcome).toBe("joined");
      await goLive(event);
      expect((await join(await newPlayer(), rotated?.code ?? ""))[0]?.outcome).toBe("closed");
      const [audit] = await owner<{ n: string }>(
        "SELECT count(*) AS n FROM audit_log WHERE event_id = $1 AND action = 'event.rehearsal_code'",
        [event],
      );
      expect(audit?.n).toBe("1");
    });

    it("lets a rehearsal account that left come back, and refuses a banned one", async () => {
      const event = await newEvent();
      const code = await open(event);
      const left = await rehearser(event);
      await call(left.player, "UPDATE enrollment SET status = 'left' WHERE id = $1", [
        left.enrollment,
      ]);
      expect((await join(left.player, code))[0]).toMatchObject({
        outcome: "joined",
        enrollment_id: left.enrollment,
      });
      const banned = await rehearser(event);
      await owner("UPDATE enrollment SET status = 'banned' WHERE id = $1", [banned.enrollment]);
      expect((await join(banned.player, code))[0]?.outcome).toBe("not_allowed");
    });

    it("stops at the cap", async () => {
      const event = await newEvent();
      const code = await open(event);
      for (let i = 0; i < REHEARSAL_CAP; i += 1) {
        expect((await join(await newPlayer(), code))[0]?.outcome).toBe("joined");
      }
      expect((await join(await newPlayer(), code))[0]?.outcome).toBe("full");
    });

    it("tells a rehearsal account that joins for real or as an operator to wait for the start", async () => {
      const event = await newEvent("scheduled");
      const [row] = await owner<{ join_code: string }>(
        "SELECT join_code FROM event WHERE id = $1",
        [event],
      );
      const { player } = await rehearser(event);
      const [real] = await call<{ outcome: string }>(
        player,
        "SELECT * FROM join_event($1, 'code', '1')",
        [row?.join_code],
      );
      expect(real?.outcome).toBe("rehearsing");
      await owner(
        "INSERT INTO staff_assignment (organizer_id, event_id, player_id, can_play) VALUES ($1, $2, $3, true)",
        [ids.orgA, event, player],
      );
      const [operator] = await call<{ outcome: string }>(
        player,
        "SELECT * FROM enroll_operator($1, '1')",
        [event],
      );
      expect(operator?.outcome).toBe("rehearsing");
      const [kept] = await owner<{ joined_via: string }>(
        "SELECT joined_via FROM enrollment WHERE event_id = $1 AND player_id = $2",
        [event, player],
      );
      expect(kept?.joined_via).toBe("rehearsal");
    });

    it("keeps a rehearsal account one, and a real one real", async () => {
      const event = await newEvent("scheduled");
      const rehearsal = await rehearser(event);
      const real = await realPlayer(event);
      expect(
        await refusal(
          owner("UPDATE enrollment SET joined_via = 'code' WHERE id = $1", [rehearsal.enrollment]),
        ),
      ).toMatchObject({ code: "42501" });
      expect(
        await refusal(
          owner("UPDATE enrollment SET joined_via = 'rehearsal' WHERE id = $1", [real.enrollment]),
        ),
      ).toMatchObject({ code: "42501" });
    });

    it("shows the event a code opens to signed-in players only, and nothing once live", async () => {
      const event = await newEvent("scheduled");
      const code = await open(event);
      const player = await newPlayer();
      expect(
        await call(player, "SELECT id FROM rehearsal_event($1)", [code.toLowerCase()]),
      ).toEqual([{ id: event }]);
      expect(await run({}, "SELECT id FROM rehearsal_event($1)", [code])).toEqual([]);
      await goLive(event);
      expect(await call(player, "SELECT id FROM rehearsal_event($1)", [code])).toEqual([]);
    });
  });

  describe("playing in rehearsal", () => {
    it("completes quests on a Draft, stamped rehearsal, while a real member waits for the start", async () => {
      const event = await newEvent("scheduled");
      const quest = await newQuest(event, 30);
      const { player, enrollment } = await rehearser(event);
      expect((await scan(player, quest))[0]?.score).toBe("30");
      const [entry] = await owner<{ rehearsal: boolean }>(
        "SELECT rehearsal FROM ledger_entry WHERE enrollment_id = $1",
        [enrollment],
      );
      expect(entry?.rehearsal).toBe(true);
      const real = await realPlayer(event);
      expect(await refusal(scan(real.player, quest))).toMatchObject({
        code: "QN403",
        detail: "event_not_live",
      });
    });

    it("lets an operator who may not play rehearse, and a station scan and awards reach rehearsal accounts", async () => {
      const event = await newEvent();
      const operator = await newPlayer();
      await owner(
        "INSERT INTO staff_assignment (organizer_id, event_id, player_id, can_play) VALUES ($1, $2, $3, false)",
        [ids.orgA, event, operator],
      );
      const code = await open(event);
      const [joined] = await join(operator, code);
      const quest = await newQuest(event);
      await owner("UPDATE quest SET verification = ARRAY['quest_qr', 'my_qr'] WHERE id = $1", [
        quest,
      ]);
      expect((await scan(operator, quest))[0]?.score).toBe("10");
      const target = await rehearser(event);
      const [station] = await call<{ points: string }>(
        operator,
        "SELECT * FROM operator_complete_quest($1, $2, 1, $3)",
        [quest, target.player, randomUUID()],
      );
      expect(station?.points).toBe("10");
      const [award] = await run<{ points: string }>(
        team(ownerA),
        "SELECT * FROM staff_award($1, $2, NULL, 25, 'Test', $3, $4)",
        [event, target.enrollment, randomUUID(), randomUUID()],
      );
      expect(award?.points).toBe("25");
      const [bulk] = await run<{ awarded: number; bulk_id: string }>(
        team(ownerA),
        "SELECT * FROM bulk_award($1, $2, NULL, 5, 'Test', $3, $4)",
        [event, [target.enrollment, joined?.enrollment_id], randomUUID(), randomUUID()],
      );
      expect(bulk?.awarded).toBe(2);
      const [marked] = await owner<{ rehearsal: boolean }>(
        "SELECT rehearsal FROM bulk_award WHERE id = $1",
        [bulk?.bulk_id],
      );
      expect(marked?.rehearsal).toBe(true);
      const [credit] = await owner<{ id: string }>(
        "SELECT id FROM ledger_entry WHERE enrollment_id = $1 AND kind = 'award' ORDER BY id LIMIT 1",
        [target.enrollment],
      );
      const [removed] = await run<{ score_delta: string }>(
        team(editorA),
        "SELECT * FROM remove_award($1, $2, 'Oops', $3, $4)",
        [event, credit?.id, randomUUID(), randomUUID()],
      );
      expect(removed?.score_delta).toBe("-25");
    });

    it("refuses a bulk award before go-live when the list holds no rehearsal account", async () => {
      const event = await newEvent("scheduled");
      const real = await realPlayer(event);
      expect(
        await refusal(
          run(team(ownerA), "SELECT * FROM bulk_award($1, $2, NULL, 5, 'Test', $3, $4)", [
            event,
            [real.enrollment],
            randomUUID(),
            randomUUID(),
          ]),
        ),
      ).toMatchObject({ code: "QN403" });
    });

    it("opens the shop and the desk for rehearsal accounts, whatever the desk's hours", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, 100);
      const desk = await newPlayer();
      await owner(
        "INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities) VALUES ($1, $2, $3, ARRAY['hand_over'])",
        [ids.orgA, event, desk],
      );
      const { player } = await rehearser(event);
      await scan(player, quest);
      const [shop] = await call<{ state: string; desk_state: string }>(
        player,
        "SELECT * FROM event_shop($1)",
        [event],
      );
      expect(shop).toMatchObject({ state: "open", desk_state: "open" });
      const reward = await newReward(event);
      const reservation = await reserve(player, reward);
      expect(reservation?.status).toBe("reserved");
      await call(player, "SELECT start_collect($1)", [reservation?.redemption_id]);
      const [handed] = await call<{ status: string }>(desk, "SELECT * FROM desk_hand_over($1)", [
        reservation?.redemption_id,
      ]);
      expect(handed?.status).toBe("handed_over");
      const [header] = await call<{ desk_state: string }>(desk, "SELECT * FROM operator_desk($1)", [
        event,
      ]);
      expect(header?.desk_state).toBe("open");
    });

    it("never spends a real code on a digital reward in rehearsal", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, 100);
      const reward = await newReward(event, "digital", 0);
      await owner(
        `INSERT INTO reward_code (organizer_id, event_id, reward_id, code_cipher, code_hash)
         SELECT organizer_id, event_id, id, decode(repeat('00', 29), 'hex'), decode(md5('a') || md5('b'), 'hex')
         FROM reward WHERE id = $1`,
        [reward],
      );
      await owner("UPDATE reward SET stock_total = 1 WHERE id = $1", [reward]);
      const { player } = await rehearser(event);
      await scan(player, quest);
      const reservation = await reserve(player, reward);
      expect(reservation).toMatchObject({ status: "delivered", code_cipher: null });
      const [state] = await owner<{ units_out: number; linked: string }>(
        "SELECT units_out, (SELECT count(*) FROM reward_code WHERE reward_id = $1 AND redemption_id IS NOT NULL) AS linked FROM reward WHERE id = $1",
        [reward],
      );
      expect(state).toMatchObject({ units_out: 0, linked: "0" });
    });

    it("raises flags on rehearsal accounts like on players", async () => {
      const event = await newEvent();
      const device = randomUUID();
      const one = await rehearser(event);
      const two = await rehearser(event);
      await scan(one.player, await newQuest(event), device);
      await scan(two.player, await newQuest(event), device);
      expect((await rehearsalRows(event))?.flags).toBe("2");
    });
  });

  /** A Scheduled event with a real member (holding a welcome) and a full rehearsal behind it. */
  const rehearsed = async () => {
    const event = await newEvent("scheduled");
    await owner("UPDATE event SET welcome_points = 7 WHERE id = $1", [event]);
    const real = await realPlayer(event);
    const quest = await newQuest(event, 100);
    const item = await newReward(event, "item", 3);
    const device = randomUUID();
    const a = await rehearser(event);
    const b = await rehearser(event);
    await scan(a.player, quest, device);
    await scan(b.player, quest, device);
    await reserve(a.player, item);
    const kept = await reserve(b.player, item);
    await call(b.player, "SELECT start_collect($1)", [kept?.redemption_id]);
    await run(team(ownerA), "SELECT * FROM staff_award($1, $2, NULL, 9, 'Test', $3, $4)", [
      event,
      a.enrollment,
      randomUUID(),
      randomUUID(),
    ]);
    await run(team(ownerA), "SELECT * FROM bulk_award($1, $2, NULL, 3, 'Test', $3, $4)", [
      event,
      [a.enrollment, b.enrollment],
      randomUUID(),
      randomUUID(),
    ]);
    await run(team(ownerA), "SELECT set_redeem_pause($1, $2, true, $3)", [
      event,
      a.enrollment,
      randomUUID(),
    ]);
    return { event, real, quest, item, a, b };
  };

  describe("the wipe", () => {
    it("erases every rehearsal row at go-live, restores stock and keeps the real member whole", async () => {
      const state = await rehearsed();
      await goLive(state.event);
      expect(await ensure(state.event)).toBe(true);
      expect(await rehearsalRows(state.event)).toEqual({
        entries: "0",
        accounts: "0",
        completions: "0",
        redemptions: "0",
        flags: "0",
      });
      const [stock] = await owner<{ units_out: number }>(
        "SELECT units_out FROM reward WHERE id = $1",
        [state.item],
      );
      expect(stock?.units_out).toBe(0);
      const [real] = await owner<{ score: string; entries: string }>(
        "SELECT score, (SELECT count(*) FROM ledger_entry WHERE enrollment_id = $1) AS entries FROM enrollment WHERE id = $1",
        [state.real.enrollment],
      );
      expect(real).toEqual({ score: "7", entries: "1" });
      const [row] = await owner<{
        live_wiped_at: Date | null;
        erase_counts: Record<string, number>;
      }>("SELECT live_wiped_at, erase_counts FROM event_rehearsal WHERE event_id = $1", [
        state.event,
      ]);
      expect(row?.live_wiped_at).not.toBeNull();
      expect(row?.erase_counts).toMatchObject({
        accounts: 2,
        completions: 2,
        points: 215,
        reservations: 2,
        flags: 2,
      });
      const [audit] = await owner<{ actor_type: string; after: Record<string, unknown> }>(
        "SELECT actor_type, after FROM audit_log WHERE event_id = $1 AND action = 'event.rehearsal_erased'",
        [state.event],
      );
      expect(audit).toMatchObject({
        actor_type: "system",
        after: { reason: "go_live", accounts: 2 },
      });
      expect(
        await owner("SELECT 1 FROM ranking_repair WHERE event_id = $1", [state.event]),
      ).toHaveLength(1);
      expect(await ensure(state.event)).toBe(false);
    });

    it("recomputes stock from the real holds that remain", async () => {
      const event = await newEvent("scheduled");
      const item = await newReward(event, "item", 5);
      const quest = await newQuest(event, 100);
      const a = await rehearser(event);
      await scan(a.player, quest);
      await reserve(a.player, item);
      const real = await realPlayer(event);
      await goLive(event);
      await scan(real.player, quest);
      await reserve(real.player, item);
      const [stock] = await owner<{ units_out: number; holds: string }>(
        `SELECT units_out, (SELECT count(*) FROM redemption WHERE reward_id = $1
                             AND status IN ('reserved', 'handed_over', 'delivered')) AS holds
         FROM reward WHERE id = $1`,
        [item],
      );
      expect(stock).toEqual({ units_out: 1, holds: "1" });
    });

    it("runs inline at the first live write, before the tick", async () => {
      const state = await rehearsed();
      await goLive(state.event);
      expect((await scan(state.real.player, state.quest))[0]?.score).toBe("107");
      expect((await rehearsalRows(state.event))?.accounts).toBe("0");
      const due = await run<{ due_rehearsal_wipes: string }>(
        {},
        "SELECT * FROM due_rehearsal_wipes()",
      );
      expect(due.map((row) => row.due_rehearsal_wipes)).not.toContain(state.event);
    });

    it("leaves no rehearsal account in the ranking rebuild", async () => {
      const state = await rehearsed();
      await goLive(state.event);
      await ensure(state.event);
      await owner("DELETE FROM ranking_repair WHERE event_id <> $1", [state.event]);
      const claimed = await run<{ claim_ranking_repairs: string }>(
        {},
        "SELECT * FROM claim_ranking_repairs(10)",
      );
      expect(claimed.map((row) => row.claim_ranking_repairs)).toEqual([state.event]);
      const entries = await run<{ enrollment_id: string }>(
        {},
        "SELECT enrollment_id FROM ranking_entries($1)",
        [state.event],
      );
      expect(entries.map((row) => row.enrollment_id)).toEqual([state.real.enrollment]);
    });

    it("keeps a rehearsal bulk award, so its retry after the start replays and awards nothing", async () => {
      const event = await newEvent("scheduled");
      const quest = await newQuest(event);
      const { player } = await rehearser(event);
      await scan(player, quest);
      const key = randomUUID();
      const bulk = (request: string) =>
        run<{ bulk_id: string; awarded: number; replayed: boolean }>(
          team(ownerA),
          "SELECT * FROM bulk_award($1, NULL, $2, 5, 'Test', $3, $4)",
          [event, quest, key, request],
        );
      const [first] = await bulk(randomUUID());
      expect(first).toMatchObject({ awarded: 1, replayed: false });
      await goLive(event);
      const real = await realPlayer(event);
      await scan(real.player, quest);
      const [again] = await bulk(randomUUID());
      expect(again).toEqual({ ...first, replayed: true });
      const [awards] = await owner<{ n: string }>(
        "SELECT count(*) AS n FROM ledger_entry WHERE event_id = $1 AND kind = 'award'",
        [event],
      );
      expect(awards?.n).toBe("0");
      const [kept] = await owner<{ rehearsal: boolean }>(
        "SELECT rehearsal FROM bulk_award WHERE id = $1",
        [first?.bulk_id],
      );
      expect(kept?.rehearsal).toBe(true);
    });

    it("lets a quest named by a kept rehearsal bulk award be deleted after an erase", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const { player } = await rehearser(event);
      await scan(player, quest);
      const [bulk] = await run<{ bulk_id: string }>(
        team(ownerA),
        "SELECT * FROM bulk_award($1, NULL, $2, 5, 'Test', $3, $4)",
        [event, quest, randomUUID(), randomUUID()],
      );
      await run(team(ownerA), "SELECT erase_rehearsal($1, $2)", [event, randomUUID()]);
      await owner("DELETE FROM quest WHERE id = $1", [quest]);
      const [kept] = await owner<{ quest_id: string | null; event_id: string }>(
        "SELECT quest_id, event_id FROM bulk_award WHERE id = $1",
        [bulk?.bulk_id],
      );
      expect(kept).toEqual({ quest_id: null, event_id: event });
    });

    it("lists due events for the tick, and none before go-live", async () => {
      const state = await rehearsed();
      expect(await dueWipes()).not.toContain(state.event);
      await goLive(state.event);
      expect(await dueWipes()).toContain(state.event);
    });

    it("lets a Draft whose start passed keep rehearsing (only activation schedules it)", async () => {
      const event = await newEvent();
      await owner("UPDATE event SET starts_at = now() - interval '1 hour' WHERE id = $1", [event]);
      const { player } = await rehearser(event);
      expect((await scan(player, await newQuest(event)))[0]?.score).toBe("10");
      expect(await ensure(event)).toBe(false);
    });

    it("erases on request by the owner or an editor, and only before go-live", async () => {
      const state = await rehearsed();
      expect(
        await refusal(
          run(team(ownerB, ids.orgB), "SELECT erase_rehearsal($1, $2)", [
            state.event,
            randomUUID(),
          ]),
        ),
      ).toMatchObject({ code: "AN404" });
      const [erased] = await run<{ counts: Record<string, number> }>(
        team(editorA),
        "SELECT erase_rehearsal($1, $2) AS counts",
        [state.event, randomUUID()],
      );
      expect(erased?.counts).toMatchObject({ accounts: 2 });
      const [row] = await owner<{ live_wiped_at: Date | null; first_play_at: Date | null }>(
        "SELECT live_wiped_at, first_play_at FROM event_rehearsal WHERE event_id = $1",
        [state.event],
      );
      expect(row?.live_wiped_at).toBeNull();
      expect(row?.first_play_at).not.toBeNull();
      // A second rehearsal starts clean with the same code.
      expect((await rehearser(state.event)).enrollment).not.toBe("");
      await goLive(state.event);
      expect(
        await refusal(
          run(team(ownerA), "SELECT erase_rehearsal($1, $2)", [state.event, randomUUID()]),
        ),
      ).toMatchObject({ code: "RR409" });
      const never = await newEvent();
      expect(
        await refusal(run(team(ownerA), "SELECT erase_rehearsal($1, $2)", [never, randomUUID()])),
      ).toMatchObject({ code: "RR404" });
    });
  });

  describe("the ledger's one exception", () => {
    it("lets only the wipe of the row's own event delete a rehearsal entry", async () => {
      const event = await newEvent();
      const other = await newEvent();
      const { player, enrollment } = await rehearser(event);
      await scan(player, await newQuest(event));
      const [entry] = await owner<{ id: string }>(
        "SELECT id FROM ledger_entry WHERE enrollment_id = $1",
        [enrollment],
      );
      const realEvent = await newEvent("scheduled");
      const real = await realPlayer(realEvent);
      const [live] = await owner<{ id: string }>(
        `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor,
                                   staff_user_id)
         VALUES ($1, $2, $3, 'award', 1, 1, 'staff', $4) RETURNING id`,
        [ids.orgA, realEvent, real.enrollment, ownerA],
      );
      expect(
        await refusal(owner("DELETE FROM ledger_entry WHERE id = $1", [entry?.id])),
      ).toMatchObject({
        code: "42501",
      });
      expect(
        await refusal(withWipeSetting(other, "DELETE FROM ledger_entry WHERE id = $1", entry?.id)),
      ).toMatchObject({
        code: "42501",
      });
      expect(
        await refusal(
          withWipeSetting(
            event,
            "UPDATE ledger_entry SET score_delta = 1 WHERE id = $1",
            entry?.id,
          ),
        ),
      ).toMatchObject({ code: "42501" });
      expect(
        await refusal(
          withWipeSetting(realEvent, "DELETE FROM ledger_entry WHERE id = $1", live?.id),
        ),
      ).toMatchObject({ code: "42501" });
      expect(
        await refusal(call(player, "DELETE FROM ledger_entry WHERE id = $1", [entry?.id])),
      ).toMatchObject({
        code: "42501",
      });
      await withWipeSetting(event, "DELETE FROM ledger_entry WHERE id = $1", entry?.id);
    });

    it("stamps the flag from the enrollment, whatever the writer sends", async () => {
      const event = await newEvent("scheduled");
      const real = await realPlayer(event);
      const [row] = await owner<{ rehearsal: boolean }>(
        `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor,
                                   staff_user_id, rehearsal)
         VALUES ($1, $2, $3, 'award', 1, 1, 'staff', $4, true) RETURNING rehearsal`,
        [ids.orgA, event, real.enrollment, ownerA],
      );
      expect(row?.rehearsal).toBe(false);
    });
  });

  /**
   * Runs `first` with its transaction held open, then `between` (outside both), then `second`, which may wait for
   * `first`; then lets `first` commit. Both settle, in that order.
   */
  /** A Scheduled event whose start is a second away on the clock, with its rehearsal opened. */
  const startingSoon = async () => {
    const event = await newEvent("scheduled");
    const code = await open(event);
    await owner(
      "UPDATE event SET starts_at = clock_timestamp() + interval '1 second' WHERE id = $1",
      [event],
    );
    return { event, code };
  };

  const race = async (
    first: [RequestContext, string, unknown[]],
    second: [RequestContext, string, unknown[]],
    between: () => Promise<unknown> = async () => undefined,
  ): Promise<PromiseSettledResult<unknown>[]> => {
    const a: PoolClient = await pool.connect();
    const b: PoolClient = await pool.connect();
    let release = noop;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ran = noop;
    const started = new Promise<void>((resolve) => {
      ran = resolve;
    });
    try {
      const firstWork = withRequestContext(a, first[0], async () => {
        const result = await a.query(first[1], first[2]);
        ran();
        await gate;
        return result;
      });
      await Promise.race([started, firstWork]);
      await between();
      const secondWork = Promise.allSettled([
        withRequestContext(b, second[0], () => b.query(second[1], second[2])),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 150));
      release();
      return [...(await Promise.allSettled([firstWork])), ...(await secondWork)];
    } finally {
      a.release();
      b.release();
    }
  };

  describe("races at the start", () => {
    it("a rehearsal scan in flight when the event goes live is waited for and wiped", async () => {
      const event = await newEvent("scheduled");
      const quest = await newQuest(event);
      const { player } = await rehearser(event);
      const settled = await race(
        [
          { playerId: player },
          "SELECT * FROM complete_quest($1, 'qr', 1, NULL, $2, NULL)",
          [quest, randomUUID()],
        ],
        [{}, "SELECT ensure_rehearsal_wiped($1)", [event]],
        () => goLive(event),
      );
      expect(settled.map((s) => s.status)).toEqual(["fulfilled", "fulfilled"]);
      expect(await rehearsalRows(event)).toMatchObject({
        entries: "0",
        accounts: "0",
        completions: "0",
      });
    });

    it("a rehearsal scan arriving during the wipe finds its account gone", async () => {
      const event = await newEvent("scheduled");
      const quest = await newQuest(event);
      const { player } = await rehearser(event);
      await goLive(event);
      const settled = await race(
        [{}, "SELECT ensure_rehearsal_wiped($1)", [event]],
        [
          { playerId: player },
          "SELECT * FROM complete_quest($1, 'qr', 1, NULL, $2, NULL)",
          [quest, randomUUID()],
        ],
      );
      expect(settled[0]?.status).toBe("fulfilled");
      expect(settled[1]).toMatchObject({ status: "rejected", reason: { code: "QC404" } });
    });

    it("two live scans racing the inline wipe both score, and the wipe runs once", async () => {
      const state = await rehearsed();
      const other = await realPlayer(state.event);
      await goLive(state.event);
      const settled = await race(
        [
          { playerId: state.real.player },
          "SELECT * FROM complete_quest($1, 'qr', 1, NULL, $2, NULL)",
          [state.quest, randomUUID()],
        ],
        [
          { playerId: other.player },
          "SELECT * FROM complete_quest($1, 'qr', 1, NULL, $2, NULL)",
          [state.quest, randomUUID()],
        ],
      );
      expect(settled.map((s) => s.status)).toEqual(["fulfilled", "fulfilled"]);
      const [audit] = await owner<{ n: string }>(
        "SELECT count(*) AS n FROM audit_log WHERE event_id = $1 AND action = 'event.rehearsal_erased'",
        [state.event],
      );
      expect(audit?.n).toBe("1");
    });

    it("a join in flight is waited for by the erase, which then removes it", async () => {
      const event = await newEvent();
      const code = await open(event);
      const settled = await race(
        [{ playerId: await newPlayer() }, "SELECT * FROM join_rehearsal($1, '1')", [code]],
        [team(ownerA), "SELECT erase_rehearsal($1, $2)", [event, randomUUID()]],
      );
      expect(settled.map((s) => s.status)).toEqual(["fulfilled", "fulfilled"]);
      expect((await rehearsalRows(event))?.accounts).toBe("0");
    });

    it("a join just before the start is waited for by the go-live wipe, which then removes it", async () => {
      const { event, code } = await startingSoon();
      const settled = await race(
        [{ playerId: await newPlayer() }, "SELECT * FROM join_rehearsal($1, '1')", [code]],
        [{}, "SELECT ensure_rehearsal_wiped($1) AS wiped", [event]],
        startPasses,
      );
      const rows = settled.map((s) => (s as PromiseFulfilledResult<{ rows: Row[] }>).value.rows[0]);
      expect(rows).toEqual([expect.objectContaining({ outcome: "joined" }), { wiped: true }]);
      expect((await rehearsalRows(event))?.accounts).toBe("0");
    });

    it("a join racing the go-live wipe once the start has passed is closed", async () => {
      const { event, code } = await startingSoon();
      await startPasses();
      const settled = await race(
        [{}, "SELECT ensure_rehearsal_wiped($1) AS wiped", [event]],
        [{ playerId: await newPlayer() }, "SELECT * FROM join_rehearsal($1, '1')", [code]],
      );
      const rows = settled.map((s) => (s as PromiseFulfilledResult<{ rows: Row[] }>).value.rows[0]);
      expect(rows).toEqual([
        { wiped: true },
        { outcome: "closed", enrollment_id: null, event_id: null },
      ]);
      expect((await rehearsalRows(event))?.accounts).toBe("0");
    });

    it("two joins cannot both take the last place", async () => {
      const event = await newEvent();
      const code = await open(event);
      for (let i = 1; i < REHEARSAL_CAP; i += 1) {
        await join(await newPlayer(), code);
      }
      const settled = await race(
        [{ playerId: await newPlayer() }, "SELECT * FROM join_rehearsal($1, '1')", [code]],
        [{ playerId: await newPlayer() }, "SELECT * FROM join_rehearsal($1, '1')", [code]],
      );
      const outcomes = settled.map(
        (s) =>
          (s as PromiseFulfilledResult<{ rows: { outcome: string }[] }>).value.rows[0]?.outcome,
      );
      expect(outcomes).toEqual(["joined", "full"]);
      expect((await rehearsalRows(event))?.accounts).toBe(String(REHEARSAL_CAP));
    });
  });

  describe("guards for later work", () => {
    it("handles every table that points at what the wipe deletes", async () => {
      const handled = [
        "enrollment.join_answer",
        "enrollment.quest_completion",
        "enrollment.ledger_entry",
        "enrollment.redemption",
        "enrollment.flag",
        "ledger_entry.ledger_entry",
        "ledger_entry.ledger_note",
        "ledger_entry.manual_award_key",
        "quest_completion.ledger_entry",
        "redemption.ledger_entry",
        "redemption.reward_code",
        "bulk_award.ledger_note",
        // Results need an ended event, so no rehearsal account is ever placed or given a rank prize (T-214).
        "enrollment.result_place",
        "redemption.result_place",
        // A rehearsal entry never pays XP (T-401, ledger_xp skips it), so no XP row points at what the wipe deletes.
        "ledger_entry.xp_entry",
        // Submissions are deleted before the completions they point at (T-301).
        "enrollment.submission",
        "quest_completion.submission",
        // Votes, quiz answers and attempts are deleted before the completions they point at (T-302).
        "enrollment.quest_vote",
        "enrollment.quiz_attempt",
        "quest_completion.quest_vote",
        "quest_completion.quiz_attempt",
        // Survey responses are deleted before the completions they point at (T-303).
        "enrollment.survey_response",
        "quest_completion.survey_response",
        // Bonus rows are deleted before the ledger entries and completions they point at (T-304).
        "enrollment.category_bonus",
        "ledger_entry.category_bonus",
        "quest_completion.category_bonus",
        // Passport stamps are deleted before the completions they point at (T-304b).
        "enrollment.passport_stamp",
        "quest_completion.passport_stamp",
        // Reveals are deleted before the accounts they point at (T-304c).
        "enrollment.category_reveal",
        // Item misses go before the completions and accounts they point at; item reservations (redemptions) go
        // before the completions that gave them (T-304d).
        "enrollment.quest_item_miss",
        "quest_completion.quest_item_miss",
        "quest_completion.redemption",
        // Position rows go with their completions (ON DELETE CASCADE), before the accounts (T-303b).
        "enrollment.completion_position",
        "quest_completion.completion_position",
        // Meetings go with either completion (ON DELETE CASCADE); the accounts' meet codes go after the completions,
        // before the accounts (T-303c).
        "enrollment.meet_pass",
        "enrollment.meeting",
        "quest_completion.meeting",
        // A rehearsal account's game rounds go before its completions (a passed round names its completion) (T-305).
        "enrollment.game_round",
        "quest_completion.game_round",
        // No community row ever names a rehearsal account: rehearsal rows never count and `everyone` leaves rehearsal
        // accounts out, and every community writer runs the go-live wipe first (T-306b, test/db/community).
        "enrollment.community_contributor",
        "enrollment.community_payout",
        "ledger_entry.community_payout",
        // A tap row goes with its completion (ON DELETE CASCADE); the tag stays (T-308, test/db/nfc-tags).
        "quest_completion.nfc_tap",
        // A kiosk scan row goes with its completion (ON DELETE CASCADE) (T-309b, test/db/kiosks).
        "quest_completion.kiosk_scan",
        // A rehearsal account's tickets go before its account, and with it (ON DELETE CASCADE) (T-310, test/db/tickets).
        "enrollment.ticket",
      ];
      const rows = await owner<{ edge: string }>(
        `SELECT DISTINCT target.relname || '.' || source.relname AS edge
         FROM pg_constraint c
         JOIN pg_class source ON source.oid = c.conrelid
         JOIN pg_class target ON target.oid = c.confrelid
         WHERE c.contype = 'f'
           AND target.relname IN ('enrollment', 'ledger_entry', 'redemption', 'quest_completion', 'bulk_award')
         ORDER BY 1`,
      );
      expect(rows.map((row) => row.edge).toSorted()).toEqual(handled.toSorted());
    });

    it("has every writer that judges the event's status call the wipe first, and no read call it", async () => {
      // Each with its reason: none writes a row the wipe deletes, or it only reads.
      const allowed = new Set([
        "advance_event_lifecycle", // moves the status; the tick's next step wipes
        "end_event_early", // the event is live already: its first write or the tick wiped
        "create_operator_invites", // operator invites, never play data
        "operator_desk", // reads the desk's header only (plpgsql, so volatile by default)
        "rehearsal_event_of", // the team's guard for open, rotate and erase; erase runs the wipe itself
        "join_rehearsal", // holds the rehearsal row FOR UPDATE and wipes through ensure when over
        "ensure_rehearsal_wiped",
        "wipe_rehearsal",
        "due_rehearsal_wipes",
        "rehearsal_over",
        "finish_quiz", // internal: play_enter, the quiz sweep and confirm_results wipe before calling it
        "settle_goal_at", // internal: settle_goal and settle_community wipe before calling it (T-306b)
        "nfc_writer", // an operator writing a tag: organizer data the wipe never touches (T-308)
        "console_ticket", // Questify reads one ticket (an audit row only); the event's status is shown, not judged (T-312)
      ]);
      const writers = await owner<{ proname: string; calls: boolean }>(
        `SELECT p.proname, p.prosrc LIKE '%ensure_rehearsal_wiped%' AS calls
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.provolatile = 'v' AND p.prorettype <> 'trigger'::regtype
           AND (p.prosrc LIKE '%event_status_now%' OR p.prosrc LIKE '%desk_state(%' OR p.prosrc LIKE '%play_phase(%')`,
      );
      expect(writers.length).toBeGreaterThan(5);
      expect(
        writers.filter((w) => !w.calls && !allowed.has(w.proname)).map((w) => w.proname),
      ).toEqual([]);
      const reads = await owner<{ proname: string }>(
        `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.provolatile IN ('s', 'i') AND p.prosrc LIKE '%ensure_rehearsal_wiped%'`,
      );
      expect(reads).toEqual([]);
    });
  });
});
