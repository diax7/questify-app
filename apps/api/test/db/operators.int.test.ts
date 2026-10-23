import { randomUUID } from "node:crypto";
import { Client } from "pg";
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

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: { code?: string; detail?: string }) => ({ code: error.code, detail: error.detail }),
  );

/**
 * Operators in the database (T-204, T-205, migration 0026): invites and their single claim, the owner's management,
 * the station scan through the one completion engine, removal at once, operators who may not play, operators off the
 * boards, quest verification methods and the My QR version.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("operators (database)", () => {
  let db: TestDatabase;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let ownerA: string;
  let editorA: string;
  let ownerB: string;
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    ids = await seedTwoTenants(db.owner);
    ownerA = await addMember(db.owner, ids.orgA, "owner");
    editorA = await addMember(db.owner, ids.orgA, "editor");
    ownerB = await addMember(db.owner, ids.orgB, "owner");
  });
  afterAll(async () => {
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const as = async <T extends Row>(
    context: RequestContext,
    sql: string,
    values: unknown[] = [],
    client: Client = db.app,
  ) => withRequestContext(client, context, async () => (await client.query<T>(sql, values)).rows);
  const seatA = () => ({ organizerId: ids.orgA, staffUserId: ownerA });
  const editorSeat = () => ({ organizerId: ids.orgA, staffUserId: editorA });
  const seatB = () => ({ organizerId: ids.orgB, staffUserId: ownerB });
  const newEvent = async (fields: { status?: string; ends?: string } = {}): Promise<string> => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Op Fest', $3, now() - interval '1 hour', now() + $4::interval) RETURNING id`,
      [ids.orgA, `OPS${counter}`, fields.status ?? "live", fields.ends ?? "1 day"],
    );
    await owner("INSERT INTO category (event_id, name_en, position) VALUES ($1, 'General', 0)", [
      event?.id,
    ]);
    return event?.id ?? "";
  };

  const newPlayer = async (email?: string): Promise<string> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`op_player_${counter}`],
    );
    await owner("INSERT INTO player_contact (player_id, email) VALUES ($1, $2)", [
      player?.id,
      email ?? `op${counter}@najd.sa`,
    ]);
    return player?.id ?? "";
  };

  const enroll = async (event: string, player: string, status = "active"): Promise<string> => {
    const [row] = await owner<{ id: string }>(
      "INSERT INTO enrollment (organizer_id, event_id, player_id, status) VALUES ($1, $2, $3, $4) RETURNING id",
      [ids.orgA, event, player, status],
    );
    return row?.id ?? "";
  };

  const newQuest = async (
    event: string,
    fields: { verification?: string[]; repeatCap?: number; type?: string } = {},
  ): Promise<string> => {
    const [category] = await owner<{ id: string }>("SELECT id FROM category WHERE event_id = $1", [
      event,
    ]);
    const [quest] = await owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, visible, type_config, verification)
       VALUES ($1, $2, $3, 'Station', 10, $4, true, $5, $6) RETURNING id`,
      [
        event,
        category?.id,
        fields.type ?? "scan_qr",
        fields.repeatCap ?? 1,
        fields.type === "enter_code" ? '{"code":"OPEN"}' : "{}",
        fields.verification ?? ["quest_qr", "my_qr"],
      ],
    );
    return quest?.id ?? "";
  };

  const invite = async (
    event: string,
    fields: { kind?: string; email?: string | null; abilities?: string[]; count?: number } = {},
    seat: RequestContext = seatA(),
  ) =>
    as<{ id: string }>(
      seat,
      "SELECT id FROM create_operator_invites($1, $2, $3, $4, $5, $6, $7) AS id",
      [
        event,
        fields.kind ?? "personal",
        "Gate crew",
        fields.email ?? null,
        fields.abilities ?? ["scan_quests"],
        fields.count ?? 1,
        randomUUID(),
      ],
    );

  const claim = async (player: string, inviteId: string, client: Client = db.app) =>
    (
      await as<{ outcome: string; event_id: string | null }>(
        { playerId: player },
        "SELECT * FROM claim_operator_invite($1, $2)",
        [inviteId, randomUUID()],
        client,
      )
    )[0];

  /** An operator of the event, through a real invite and claim. */
  const newOperator = async (
    event: string,
    abilities: string[] = ["scan_quests"],
  ): Promise<{ player: string; assignment: string }> => {
    const player = await newPlayer();
    const [made] = await invite(event, { abilities });
    await claim(player, made?.id ?? "");
    const [row] = await owner<{ id: string }>(
      "SELECT id FROM staff_assignment WHERE event_id = $1 AND player_id = $2",
      [event, player],
    );
    return { player, assignment: row?.id ?? "" };
  };

  const scan = (
    operator: string,
    quest: string,
    scanned: string,
    fields: { version?: number; key?: string } = {},
  ) =>
    as<{ completion_id: string; points: string; occurrence: number; replayed: boolean }>(
      { playerId: operator },
      "SELECT * FROM operator_complete_quest($1, $2, $3, $4)",
      [quest, scanned, fields.version ?? 1, fields.key ?? randomUUID()],
    );

  const setOperator = (
    event: string,
    assignment: string,
    fields: { abilities?: string[]; canPlay?: boolean; quests?: string[] },
    seat: RequestContext = seatA(),
  ) =>
    as<{ outcome: string }>(seat, "SELECT set_operator($1, $2, $3, $4, $5, $6) AS outcome", [
      event,
      assignment,
      fields.abilities ?? ["scan_quests"],
      fields.canPlay ?? false,
      fields.quests ?? [],
      randomUUID(),
    ]).then((rows) => rows[0]?.outcome);

  describe("invites", () => {
    it("lets the owner create personal, batch and email invites, and nobody else", async () => {
      const event = await newEvent();
      const [one] = await invite(event);
      expect(one?.id).toMatch(/^[0-9a-f-]{36}$/);
      const batch = await invite(event, { count: 3 });
      expect(batch).toHaveLength(3);
      const labels = await owner<{ label: string; batch_id: string | null }>(
        "SELECT label, batch_id FROM operator_invite WHERE id = ANY ($1) ORDER BY label",
        [batch.map((row) => row.id)],
      );
      expect(labels.map((row) => row.label)).toEqual(["Gate crew 1", "Gate crew 2", "Gate crew 3"]);
      expect(new Set(labels.map((row) => row.batch_id)).size).toBe(1);
      const [email] = await invite(event, { kind: "email", email: "crew@najd.sa" });
      const [stored] = await owner<{ expires_at: Date }>(
        "SELECT expires_at FROM operator_invite WHERE id = $1",
        [email?.id],
      );
      expect(stored?.expires_at.getTime()).toBeLessThanOrEqual(Date.now() + 7 * 86_400_000);

      expect(await failure(invite(event, {}, editorSeat()))).toMatchObject({ code: "OO403" });
      expect(await failure(invite(event, {}, seatB()))).toMatchObject({ code: "ON404" });
      expect(await failure(invite(event, {}, { playerId: ids.playerA }))).toMatchObject({
        code: "ON404",
      });
      expect(
        await failure(invite(event, { kind: "email", count: 2, email: "a@b.sa" })),
      ).toMatchObject({ code: "22023" });
      expect(await failure(invite(event, { abilities: ["fly"] }))).toMatchObject({ code: "23514" });
      expect(await failure(invite(event, { kind: "email" }))).toMatchObject({ code: "22023" });
      expect(await failure(invite(event, { email: "a@b.sa" }))).toMatchObject({ code: "22023" });
    });

    it("refuses invites for an ended event and above 500 open ones", async () => {
      const ended = await newEvent({ status: "ended", ends: "-1 minute" });
      expect(await failure(invite(ended))).toMatchObject({ code: "OE409" });
      const event = await newEvent();
      for (let round = 0; round < 5; round += 1) {
        await invite(event, { count: 100 });
      }
      expect(await failure(invite(event))).toMatchObject({ code: "OI409" });
    });

    it("previews without writing, then claims once; a second claim sees it used", async () => {
      const event = await newEvent();
      const [made] = await invite(event, { abilities: ["scan_quests", "hand_over"] });
      const player = await newPlayer();
      const [preview] = await as<{ outcome: string; name_en: string; abilities: string[] }>(
        { playerId: player },
        "SELECT * FROM preview_operator_invite($1)",
        [made?.id],
      );
      expect(preview).toMatchObject({
        outcome: "ok",
        name_en: "Op Fest",
        abilities: ["scan_quests", "hand_over"],
      });
      expect(
        await owner("SELECT 1 FROM staff_assignment WHERE player_id = $1", [player]),
      ).toHaveLength(0);

      expect(await claim(player, made?.id ?? "")).toEqual({ outcome: "claimed", event_id: event });
      const [assignment] = await owner<{
        abilities: string[];
        can_play: boolean;
        invite_id: string;
      }>("SELECT abilities, can_play, invite_id FROM staff_assignment WHERE player_id = $1", [
        player,
      ]);
      expect(assignment).toEqual({
        abilities: ["scan_quests", "hand_over"],
        can_play: false,
        invite_id: made?.id,
      });
      const other = await newPlayer();
      expect(await claim(other, made?.id ?? "")).toEqual({ outcome: "used", event_id: null });
    });

    it("gives one invite to one of two people claiming at the same moment", async () => {
      const event = await newEvent();
      const [made] = await invite(event);
      const players = [await newPlayer(), await newPlayer()];
      const clients = await Promise.all(
        players.map(async () => {
          const client = new Client({ connectionString: db.appUrl });
          await client.connect();
          return client;
        }),
      );
      try {
        const outcomes = await Promise.all(
          players.map((player, index) => claim(player, made?.id ?? "", clients[index])),
        );
        expect(outcomes.map((row) => row?.outcome).toSorted()).toEqual(["claimed", "used"]);
      } finally {
        await Promise.all(clients.map((client) => client.end()));
      }
      expect(
        await owner("SELECT 1 FROM staff_assignment WHERE event_id = $1", [event]),
      ).toHaveLength(1);
    });

    it("makes one assignment when one person claims two invites of an event at once", async () => {
      const event = await newEvent();
      const made = await invite(event, { count: 2 });
      const player = await newPlayer();
      const clients = await Promise.all(
        made.map(async () => {
          const client = new Client({ connectionString: db.appUrl });
          await client.connect();
          return client;
        }),
      );
      try {
        const outcomes = await Promise.all(
          made.map((row, index) => claim(player, row.id, clients[index])),
        );
        expect(outcomes.map((row) => row?.outcome).toSorted()).toEqual([
          "already_operator",
          "claimed",
        ]);
      } finally {
        await Promise.all(clients.map((client) => client.end()));
      }
      const open = await owner(
        "SELECT 1 FROM operator_invite WHERE event_id = $1 AND claimed_at IS NULL",
        [event],
      );
      expect(open).toHaveLength(1);
    });

    it("answers not_found for revoked or unknown invites and expired for an ended event", async () => {
      const event = await newEvent();
      const [made] = await invite(event);
      const [revoked] = await as<{ outcome: string }>(
        seatA(),
        "SELECT revoke_operator_invite($1, $2, $3) AS outcome",
        [event, made?.id, randomUUID()],
      );
      expect(revoked?.outcome).toBe("revoked");
      const player = await newPlayer();
      expect(await claim(player, made?.id ?? "")).toMatchObject({ outcome: "not_found" });
      expect(await claim(player, randomUUID())).toMatchObject({ outcome: "not_found" });
      const [again] = await as<{ outcome: string }>(
        seatA(),
        "SELECT revoke_operator_invite($1, $2, $3) AS outcome",
        [event, made?.id, randomUUID()],
      );
      expect(again?.outcome).toBe("not_open");

      const [open] = await invite(event);
      const [byEditor] = await as<{ outcome: string }>(
        editorSeat(),
        "SELECT revoke_operator_invite($1, $2, $3) AS outcome",
        [event, open?.id, randomUUID()],
      );
      expect(byEditor?.outcome).toBe("not_owner");
      await owner(
        "UPDATE event SET status = 'ended', ends_at = now() - interval '1 minute' WHERE id = $1",
        [event],
      );
      expect(await claim(player, open?.id ?? "")).toMatchObject({ outcome: "expired" });
    });

    it("binds an email invite to that address and clears the email once claimed", async () => {
      const event = await newEvent();
      const [made] = await invite(event, { kind: "email", email: "lead@najd.sa" });
      const stranger = await newPlayer();
      expect(await claim(stranger, made?.id ?? "")).toEqual({
        outcome: "email_mismatch",
        event_id: event,
      });
      const lead = await newPlayer("lead@najd.sa");
      expect(await claim(lead, made?.id ?? "")).toMatchObject({ outcome: "claimed" });
      const [row] = await owner<{ email: string | null }>(
        "SELECT email FROM operator_invite WHERE id = $1",
        [made?.id],
      );
      expect(row?.email).toBeNull();
    });

    it("leaves the invite open when the claimer already staffs the event", async () => {
      const event = await newEvent();
      const { player } = await newOperator(event);
      const [second] = await invite(event);
      expect(await claim(player, second?.id ?? "")).toEqual({
        outcome: "already_operator",
        event_id: event,
      });
      const [row] = await owner<{ claimed_at: Date | null }>(
        "SELECT claimed_at FROM operator_invite WHERE id = $1",
        [second?.id],
      );
      expect(row?.claimed_at).toBeNull();
    });

    it("sweeps the email off expired invites", async () => {
      const event = await newEvent();
      const [made] = await invite(event, { kind: "email", email: "late@najd.sa" });
      await owner(
        "UPDATE operator_invite SET expires_at = now() - interval '1 second' WHERE id = $1",
        [made?.id],
      );
      await as({}, "SELECT sweep_operator_invites()");
      const [row] = await owner<{ email: string | null }>(
        "SELECT email FROM operator_invite WHERE id = $1",
        [made?.id],
      );
      expect(row?.email).toBeNull();
    });
  });

  describe("the station scan", () => {
    it("pays the scanned player, records the operator and no device", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const { player: operator } = await newOperator(event);
      const player = await newPlayer();
      const enrollment = await enroll(event, player);
      const [done] = await scan(operator, quest, player);
      expect(done).toMatchObject({ points: "10", occurrence: 1, replayed: false });
      const [entry] = await owner<{ actor: string; operator_id: string; score: string }>(
        `SELECT l.actor, l.operator_id, e.score FROM ledger_entry l JOIN enrollment e ON e.id = l.enrollment_id
         WHERE l.enrollment_id = $1`,
        [enrollment],
      );
      expect(entry).toEqual({ actor: "operator", operator_id: operator, score: "10" });
      const [completion] = await owner<{ method: string; device_id: string | null }>(
        "SELECT method, device_id FROM quest_completion WHERE enrollment_id = $1",
        [enrollment],
      );
      expect(completion).toEqual({ method: "my_qr", device_id: null });
    });

    it("refuses a removed operator at once, an ability turned off, a quest outside the limit and their own code", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const other = await newQuest(event);
      const { player: operator, assignment } = await newOperator(event);
      const player = await newPlayer();
      await enroll(event, player);

      expect(await setOperator(event, assignment, { abilities: ["award"] })).toBe("changed");
      expect(await failure(scan(operator, quest, player))).toMatchObject({ code: "OA403" });
      expect(
        await setOperator(event, assignment, { abilities: ["scan_quests"], quests: [other] }),
      ).toBe("changed");
      expect(await failure(scan(operator, quest, player))).toMatchObject({ code: "OS403" });
      expect(await scan(operator, other, player)).toHaveLength(1);
      expect(await failure(scan(operator, other, operator))).toMatchObject({ code: "OY409" });

      const [removed] = await as<{ outcome: string }>(
        seatA(),
        "SELECT remove_operator($1, $2, $3) AS outcome",
        [event, assignment, randomUUID()],
      );
      expect(removed?.outcome).toBe("removed");
      expect(await failure(scan(operator, quest, player))).toMatchObject({ code: "OP403" });
      const stranger = await newPlayer();
      expect(await failure(scan(stranger, quest, player))).toMatchObject({ code: "OP403" });
    });

    it("refuses an earlier My QR version, a player not in the event and a quest without My QR", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const printedOnly = await newQuest(event, { verification: ["quest_qr"] });
      const { player: operator } = await newOperator(event);
      const player = await newPlayer();
      await enroll(event, player);
      expect(await as({ playerId: player }, "SELECT reset_my_qr($1) AS v", [randomUUID()])).toEqual(
        [{ v: 2 }],
      );
      expect(await failure(scan(operator, quest, player, { version: 1 }))).toMatchObject({
        code: "OM422",
      });
      expect(await scan(operator, quest, player, { version: 2 })).toHaveLength(1);
      expect(await failure(scan(operator, printedOnly, player, { version: 2 }))).toMatchObject({
        code: "QV422",
        detail: "wrong_method",
      });
      const outsider = await newPlayer();
      expect(await failure(scan(operator, quest, outsider))).toMatchObject({ code: "QC404" });
      expect(await failure(scan(operator, quest, randomUUID()))).toMatchObject({ code: "QC404" });
    });

    it("pays once for a code held up twice within seconds, even on a repeatable quest", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, { repeatCap: 3 });
      const { player: operator } = await newOperator(event);
      const player = await newPlayer();
      await enroll(event, player);
      expect(await scan(operator, quest, player)).toHaveLength(1);
      expect(await failure(scan(operator, quest, player))).toMatchObject({
        code: "QD409",
        detail: "3",
      });
      await owner("ALTER TABLE ledger_entry DISABLE TRIGGER ledger_no_update_or_delete");
      try {
        await owner(
          "UPDATE ledger_entry SET created_at = created_at - interval '11 seconds' WHERE operator_id = $1",
          [operator],
        );
      } finally {
        await owner("ALTER TABLE ledger_entry ENABLE ALWAYS TRIGGER ledger_no_update_or_delete");
      }
      expect(await scan(operator, quest, player)).toMatchObject([{ occurrence: 2 }]);
    });

    it("replays the same key for the same operator and refuses it for another", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const { player: first } = await newOperator(event);
      const { player: second } = await newOperator(event);
      const player = await newPlayer();
      await enroll(event, player);
      const key = randomUUID();
      const [done] = await scan(first, quest, player, { key });
      expect(await scan(first, quest, player, { key })).toMatchObject([
        { completion_id: done?.completion_id, replayed: true },
      ]);
      expect(await failure(scan(second, quest, player, { key }))).toMatchObject({ code: "QK422" });
    });

    it("keeps the player's own scan on its methods: never My QR, never a quest without its printed code", async () => {
      const event = await newEvent();
      const staffOnly = await newQuest(event, { verification: ["my_qr"] });
      const player = await newPlayer();
      await enroll(event, player);
      const self = (method: string) =>
        as({ playerId: player }, "SELECT * FROM complete_quest($1, $2, 1, NULL, $3, NULL)", [
          staffOnly,
          method,
          randomUUID(),
        ]);
      expect(await failure(self("qr"))).toMatchObject({ code: "QV422", detail: "wrong_method" });
      expect(await failure(self("my_qr"))).toMatchObject({ code: "QV422", detail: "wrong_method" });
    });

    it("counts the station's completions today and in all, for the operator's stations only", async () => {
      const event = await newEvent();
      const station = await newQuest(event);
      await newQuest(event, { verification: ["quest_qr"] });
      const limited = await newQuest(event);
      const { player: operator, assignment } = await newOperator(event);
      await setOperator(event, assignment, { quests: [station] });
      const player = await newPlayer();
      await enroll(event, player);
      await scan(operator, station, player);
      const stations = await as<{ quest_id: string; done_today: string; done_total: string }>(
        { playerId: operator },
        "SELECT quest_id, done_today, done_total FROM operator_stations($1)",
        [event],
      );
      expect(stations).toEqual([{ quest_id: station, done_today: "1", done_total: "1" }]);
      expect(stations.map((row) => row.quest_id)).not.toContain(limited);
      expect(
        await failure(as({ playerId: player }, "SELECT * FROM operator_stations($1)", [event])),
      ).toMatchObject({ code: "OP403" });
    });
  });

  describe("operators and playing", () => {
    it("lets an operator play only when the owner allows it, whoever scans", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const { player: colleague } = await newOperator(event);
      const { player: operator, assignment } = await newOperator(event);
      await enroll(event, operator);
      const ownScan = () =>
        as({ playerId: operator }, "SELECT * FROM complete_quest($1, 'qr', 1, NULL, $2, NULL)", [
          quest,
          randomUUID(),
        ]);
      expect(await failure(ownScan())).toMatchObject({ code: "QP403" });
      expect(await failure(scan(colleague, quest, operator))).toMatchObject({ code: "QP403" });
      expect(await setOperator(event, assignment, { canPlay: true })).toBe("changed");
      expect(await ownScan()).toHaveLength(1);
    });

    it("enrolls an allowed operator whatever the access type, and nobody else", async () => {
      const event = await newEvent();
      await owner("UPDATE event SET access = 'private' WHERE id = $1", [event]);
      const { player: operator, assignment } = await newOperator(event);
      const join = (who: string) =>
        as<{ outcome: string }>({ playerId: who }, "SELECT * FROM enroll_operator($1, '1')", [
          event,
        ]).then((rows) => rows[0]?.outcome);
      expect(await join(operator)).toBe("not_allowed");
      await setOperator(event, assignment, { canPlay: true });
      expect(await join(operator)).toBe("joined");
      expect(await join(operator)).toBe("already");
      const [row] = await owner<{ status: string; joined_via: string }>(
        "SELECT status, joined_via FROM enrollment WHERE event_id = $1 AND player_id = $2",
        [event, operator],
      );
      expect(row).toEqual({ status: "active", joined_via: "operator" });
      expect(await join(await newPlayer())).toBe("not_allowed");
    });

    it("waits for a change of the event before enrolling an operator (one welcome amount)", async () => {
      const event = await newEvent();
      const { player: operator, assignment } = await newOperator(event);
      await setOperator(event, assignment, { canPlay: true });
      await db.owner.query("BEGIN");
      try {
        await db.owner.query("UPDATE event SET welcome_points = 10 WHERE id = $1", [event]);
        const enrolling = withRequestContext(db.app, { playerId: operator }, async () => {
          await db.app.query("SET LOCAL lock_timeout = '300ms'");
          return db.app.query("SELECT * FROM enroll_operator($1, '1')", [event]);
        });
        expect(await failure(enrolling)).toMatchObject({ code: "55P03" });
      } finally {
        await db.owner.query("ROLLBACK");
      }
    });

    it("keeps operators off both forms of the ranking and marks the event when the team changes", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const { player: operator, assignment } = await newOperator(event);
      await setOperator(event, assignment, { canPlay: true });
      const enrollment = await enroll(event, operator);
      await as(
        { playerId: operator },
        "SELECT * FROM complete_quest($1, 'qr', 1, NULL, $2, NULL)",
        [quest, randomUUID()],
      );
      const [ranked] = await owner<{ ranked: boolean }>(
        "SELECT ranked FROM ranked_enrollments($1) WHERE id = $2",
        [event, enrollment],
      );
      expect(ranked?.ranked).toBe(false);
      const [eligible] = await owner<{ ok: boolean }>(
        "SELECT ranking_eligible(e) AS ok FROM enrollment e WHERE e.id = $1",
        [enrollment],
      );
      expect(eligible?.ok).toBe(false);

      await owner("DELETE FROM ranking_repair WHERE event_id = $1", [event]);
      await as(seatA(), "SELECT remove_operator($1, $2, $3)", [event, assignment, randomUUID()]);
      expect(await owner("SELECT 1 FROM ranking_repair WHERE event_id = $1", [event])).toHaveLength(
        1,
      );
      const [after] = await owner<{ ranked: boolean }>(
        "SELECT ranked FROM ranked_enrollments($1) WHERE id = $2",
        [event, enrollment],
      );
      expect(after?.ranked).toBe(true);
    });
  });

  describe("quest verification and My QR", () => {
    it("defaults by type and refuses an empty scan quest or a code quest with methods", async () => {
      const event = await newEvent();
      const [category] = await owner<{ id: string }>(
        "SELECT id FROM category WHERE event_id = $1",
        [event],
      );
      const made = await as<{ verification: string[] }>(
        seatA(),
        `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
         VALUES ($1, $2, 'scan_qr', 'Default', 5, '{}') RETURNING verification`,
        [event, category?.id],
      );
      expect(made[0]?.verification).toEqual(["quest_qr"]);
      expect(await failure(newQuest(event, { verification: [] }))).toMatchObject({ code: "23514" });
      expect(
        await failure(newQuest(event, { type: "enter_code", verification: ["my_qr"] })),
      ).toMatchObject({ code: "23514" });
      expect(await newQuest(event, { type: "enter_code", verification: [] })).toMatch(/-/);
    });

    it("limits resets to 5 a day and reads only the caller's version", async () => {
      const player = await newPlayer();
      for (let round = 2; round <= 6; round += 1) {
        expect(
          await as({ playerId: player }, "SELECT reset_my_qr($1) AS v", [randomUUID()]),
        ).toEqual([{ v: round }]);
      }
      expect(await as({ playerId: player }, "SELECT reset_my_qr($1) AS v", [randomUUID()])).toEqual(
        [{ v: null }],
      );
      expect(await as({ playerId: player }, "SELECT my_qr_version() AS v")).toEqual([{ v: 6 }]);
      expect(await as({}, "SELECT my_qr_version() AS v")).toEqual([{ v: null }]);
    });
  });

  describe("who sees what", () => {
    it("shows the team its operators and invites, an operator their own row, and nobody else anything", async () => {
      const event = await newEvent();
      const { player: operator } = await newOperator(event);
      await invite(event);
      expect(await as(editorSeat(), "SELECT * FROM event_operators($1)", [event])).toHaveLength(1);
      expect(
        await as(editorSeat(), "SELECT * FROM event_operator_invites($1)", [event]),
      ).toHaveLength(2);
      expect(await as(seatB(), "SELECT * FROM event_operators($1)", [event])).toHaveLength(0);
      expect(
        await as(seatB(), "SELECT * FROM operator_invite WHERE event_id = $1", [event]),
      ).toHaveLength(0);
      expect(
        await as({ playerId: operator }, "SELECT * FROM staff_assignment WHERE event_id = $1", [
          event,
        ]),
      ).toHaveLength(1);
      expect(
        await as({ playerId: ids.playerA }, "SELECT * FROM staff_assignment WHERE event_id = $1", [
          event,
        ]),
      ).toHaveLength(0);
      expect(await as({ playerId: operator }, "SELECT * FROM operator_invite")).toHaveLength(0);
      expect(await as({ playerId: operator }, "SELECT * FROM operator_events()")).toHaveLength(1);
    });

    it("gives the API role no writes and the outsider nothing", async () => {
      const event = await newEvent();
      expect(
        await failure(
          as(
            seatA(),
            "INSERT INTO staff_assignment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)",
            [ids.orgA, event, ids.playerA],
          ),
        ),
      ).toMatchObject({ code: "42501" });
      expect(
        await failure(as(seatA(), "UPDATE operator_invite SET claimed_at = now()")),
      ).toMatchObject({ code: "42501" });
      expect(
        await failure(
          as(
            seatA(),
            "SELECT * FROM record_completion(NULL, NULL, 'qr', 1, NULL, 'k', NULL, NULL, NULL, NULL, NULL)",
          ),
        ),
      ).toMatchObject({ code: "42501" });
      for (const sql of [
        "SELECT * FROM public.staff_assignment",
        "SELECT * FROM public.operator_invite",
        "SELECT * FROM public.staff_assignment_quest",
        "SELECT * FROM public.operator_events()",
        "SELECT public.my_qr_version()",
        `SELECT * FROM public.claim_operator_invite('${randomUUID()}', '${randomUUID()}')`,
        `SELECT * FROM public.operator_complete_quest('${randomUUID()}', '${randomUUID()}', 1, 'k')`,
      ]) {
        expect(await failure(db.outsider.query(sql))).toMatchObject({ code: "42501" });
      }
    });
  });
});
