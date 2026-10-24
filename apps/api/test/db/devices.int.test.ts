import { randomBytes, randomUUID } from "node:crypto";
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
type Member = Readonly<{ player: string; enrollment: string }>;
type Pending = Readonly<{ secret: Buffer; code: Buffer }>;
type Session = Readonly<{
  state: string;
  device_id: string | null;
  kind: string;
  activated: boolean;
}>;
type ScreenCode = Readonly<{
  quest_id: string;
  shut: string | null;
  window_number: number | null;
  ms_to_next: number | null;
}>;

const refusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
    return "none";
  } catch (error) {
    const pg = error as { code?: string; detail?: string };
    const detail =
      pg.detail === undefined || pg.detail === "" || /^[0-9]/.test(pg.code ?? "")
        ? ""
        : `:${pg.detail}`;
    return `${pg.code}${detail}`;
  }
};
const as = (player: string): RequestContext => ({ playerId: player });
const SCREEN = ["screen_qr"];
const noop = (): void => undefined;
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const hash = (): Buffer => randomBytes(32);

/**
 * Device pairing and the rotating screen QR in the database (T-309, migration 0057, ADR-239, ADR-240): the method's
 * walls, the pairing table (requests, claims by operators and the team, every refusal, the limits, activation's secret
 * swap, revocation, removals that revoke, the end of a device), the screen door table, the one clock, the station's
 * code, the wipe and the cascades, and the crossed locks.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("device pairing (database)", () => {
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
  const teamA = (): RequestContext => ({ organizerId: ids.orgA, staffUserId: ownerA });
  const teamB = (): RequestContext => ({ organizerId: ids.orgB, staffUserId: ownerB });

  const newEvent = async (status = "live", startsIn = "-2 hours", endsIn = "1 day") => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Hall Fest', $3, now() + $4::interval, now() + $5::interval) RETURNING id`,
      [ids.orgA, `DEV${counter}`, status, startsIn, endsIn],
    );
    return event?.id ?? "";
  };
  const newCategory = async (event: string) => {
    const [category] = await owner<{ id: string }>(
      "INSERT INTO category (event_id, name_en) VALUES ($1, 'Stage') RETURNING id",
      [event],
    );
    return category?.id ?? "";
  };
  const newQuest = async (
    event: string,
    fields: Readonly<{
      category?: string;
      verification?: string[];
      repeat?: number;
      type?: string;
    }> = {},
  ) => {
    const [quest] = await owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, verification)
       VALUES ($1, $2, $3, 'Screen', 10, $4, $5) RETURNING id`,
      [
        event,
        fields.category ?? (await newCategory(event)),
        fields.type ?? "scan_qr",
        fields.repeat ?? 100,
        fields.verification ?? SCREEN,
      ],
    );
    return quest?.id ?? "";
  };
  const member = async (event: string, via = "code"): Promise<Member> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`dev_player_${counter}`],
    );
    const [made] = await owner<{ id: string }>(
      `INSERT INTO enrollment (organizer_id, event_id, player_id, joined_via)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [ids.orgA, event, player?.id, via],
    );
    return { player: player?.id ?? "", enrollment: made?.id ?? "" };
  };
  const operator = async (event: string, abilities = ["scan_quests", "show_rotating_qr"]) => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`dev_operator_${counter}`],
    );
    const [made] = await owner<{ id: string }>(
      `INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [ids.orgA, event, player?.id, abilities],
    );
    return { player: player?.id ?? "", assignment: made?.id ?? "" };
  };
  const openRequest = async (kind = "station", client = "Chrome on Android"): Promise<Pending> => {
    const pending = { secret: hash(), code: hash() };
    await query({}, "SELECT * FROM open_device_request($1, $2, $3, $4)", [
      pending.secret,
      pending.code,
      kind,
      client,
    ]);
    return pending;
  };
  const teamClaim = (
    pending: Pending,
    event: string,
    kind: string,
    quest: string | null,
    fields: Readonly<{ label?: string; team?: RequestContext }> = {},
  ) =>
    query<{ id: string }>(
      fields.team ?? teamA(),
      "SELECT team_claim_device($1, $2, $3, $4, $5, $6) AS id",
      [pending.code, event, kind, quest, fields.label ?? "Hall B TV", randomUUID()],
    ).then((rows) => rows[0]?.id ?? "");
  const operatorClaim = (
    who: string,
    pending: Pending,
    event: string,
    kind: string,
    quest: string | null,
    label = "Gate TV",
  ) =>
    query<{ id: string }>(as(who), "SELECT operator_claim_device($1, $2, $3, $4, $5, $6) AS id", [
      pending.code,
      event,
      kind,
      quest,
      label,
      randomUUID(),
    ]).then((rows) => rows[0]?.id ?? "");
  const session = async (secret: Buffer) =>
    (await query<Session>({}, "SELECT * FROM device_session($1)", [secret]))[0];
  const activate = async (secret: Buffer, fresh: Buffer = hash()) => {
    const [row] = await query<{ rotated: boolean }>(
      {},
      "SELECT activate_device($1, $2) AS rotated",
      [secret, fresh],
    );
    return { rotated: row?.rotated, fresh };
  };
  /** A station paired by the team and activated: its device id and current secret. */
  const station = async (event: string, quest: string) => {
    const pending = await openRequest();
    const id = await teamClaim(pending, event, "station", quest);
    const { fresh } = await activate(pending.secret);
    return { id, secret: fresh };
  };
  const codeFor = async (device: string) =>
    (await query<ScreenCode>({ deviceId: device }, "SELECT * FROM screen_code_for_device()"))[0];
  const view = async (device: string) =>
    (await query<{ view: Row }>({ deviceId: device }, "SELECT device_view() AS view"))[0]?.view;
  const okAt = async (version: number, instant: string) =>
    (
      await owner<{ ok: boolean }>("SELECT screen_window_ok($1, $2::timestamptz) AS ok", [
        version,
        instant,
      ])
    )[0]?.ok;
  const nowWindow = async () =>
    (
      await owner<{ w: number; s: number }>(
        "SELECT screen_window_of(now()) AS w, (extract(epoch FROM now()) - screen_window_of(now())::numeric * 30)::float AS s",
      )
    )[0] ?? { w: 0, s: 0 };
  /** Waits until the clock is clear of the 15-second line and of a window change, so two calls see the same answer. */
  const steadyWindow = async () => {
    for (;;) {
      const at = await nowWindow();
      if (Math.abs(at.s - 15) > 1 && at.s > 1 && at.s < 29) {
        return at;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  };
  const scan = (player: string, quest: string, version: number, key: string = randomUUID()) =>
    query<{ completion_id: string; points: string; replayed: boolean }>(
      as(player),
      "SELECT * FROM complete_quest($1, 'screen_qr', $2, NULL, $3, NULL)",
      [quest, version, key],
    ).then((rows) => rows[0]);
  const hold = async (context: RequestContext, sql: string, values: unknown[]) => {
    const client = await pool.connect();
    let release = noop;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ran = noop;
    const started = new Promise<void>((resolve) => {
      ran = resolve;
    });
    const done = withRequestContext(client, context, async () => {
      const rows = (await client.query(sql, values)).rows;
      ran();
      await gate;
      return rows;
    }).finally(() => client.release());
    await Promise.race([started, done]);
    return { release, done };
  };
  const waitsOnLock = async (fragment: string) => {
    for (let tries = 0; tries < 100; tries += 1) {
      const rows = await owner(
        `SELECT 1 FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`,
        [`%${fragment}%`],
      );
      if (rows.length > 0) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  };
  const deviceRow = async (id: string) =>
    (
      await owner<{
        status: string;
        paired_by_operator: string | null;
        paired_by_staff: string | null;
      }>("SELECT status, paired_by_operator, paired_by_staff FROM paired_device WHERE id = $1", [
        id,
      ])
    )[0];
  const revokeAudit = async (id: string) =>
    (
      await owner<{ before: Row }>(
        "SELECT before FROM audit_log WHERE action = 'device.revoke' AND target_id = $1",
        [id],
      )
    )[0]?.before;

  // ============================================================ the method's walls
  describe("the method (FR-314, ADR-240)", () => {
    it("allows the screen QR on scan quests only, never with the printed QR (so never with NFC)", async () => {
      const event = await newEvent();
      expect(await refusal(newQuest(event, { verification: ["screen_qr"] }))).toBe("none");
      expect(await refusal(newQuest(event, { verification: ["my_qr", "screen_qr"] }))).toBe("none");
      expect(await refusal(newQuest(event, { verification: ["quest_qr", "screen_qr"] }))).toBe(
        "23514",
      );
      expect(
        await refusal(newQuest(event, { verification: ["quest_qr", "nfc", "screen_qr"] })),
      ).toBe("23514");
      expect(
        await refusal(newQuest(event, { type: "location", verification: ["screen_qr"] })),
      ).toBe("23514");
      expect(
        await refusal(newQuest(event, { type: "challenge", verification: ["screen_qr"] })),
      ).toBe("23514");
    });

    it("refuses a completion method the door does not know (kiosk is T-309b's)", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const who = await member(event);
      expect(
        await refusal(
          owner(
            `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                           idempotency_key)
             VALUES ($1, $2, $3, $4, 1, 'kiosk', 'k')`,
            [ids.orgA, event, who.enrollment, quest],
          ),
        ),
      ).toBe("23514");
    });

    it("keeps both tables closed to the API role", async () => {
      for (const sql of ["SELECT * FROM device_request", "SELECT * FROM paired_device"]) {
        expect(await refusal(query(teamA(), sql))).toBe("42501");
      }
    });
  });

  // ============================================================ the one clock
  describe("the one clock (ADR-240)", () => {
    it("accepts the current window, and the previous one before second 15 exactly (CTO 7)", async () => {
      // 2026-10-24T10:00:00Z is a window start (epoch divisible by 30).
      const start = Date.parse("2026-10-24T10:00:00Z");
      const window = start / 30_000;
      expect(await okAt(window, "2026-10-24T10:00:00Z")).toBe(true);
      expect(await okAt(window - 1, "2026-10-24T10:00:14.999Z")).toBe(true);
      expect(await okAt(window - 1, "2026-10-24T10:00:15.000Z")).toBe(false);
      expect(await okAt(window - 2, "2026-10-24T10:00:01Z")).toBe(false);
      expect(await okAt(window + 1, "2026-10-24T10:00:29.999Z")).toBe(false);
      expect(await okAt(window, "2026-10-24T10:00:29.999Z")).toBe(true);
      expect(await okAt(window, "2026-10-24T10:00:30Z")).toBe(true);
      expect(await okAt(window, "2026-10-24T10:00:45Z")).toBe(false);
    });

    it("holds for random instants: exactly the current window, plus the previous one only before second 15", async () => {
      for (let round = 0; round < 200; round += 1) {
        const ms = 1_700_000_000_000 + Math.floor(Math.random() * 400_000_000_000);
        const current = Math.floor(ms / 30_000);
        const into = (ms % 30_000) / 1000;
        const offset = Math.floor(Math.random() * 5) - 3;
        const version = current + offset;
        const [row] = await owner<{ ok: boolean }>(
          "SELECT screen_window_ok($1, to_timestamp($2::float8 / 1000)) AS ok",
          [version, ms],
        );
        const expected = offset === 0 || (offset === -1 && into < 15);
        expect(row?.ok, `${ms} ${offset}`).toBe(expected);
      }
    });

    it("answers the window now and the time until it changes", async () => {
      const [row] = await owner<{ window_number: number; ms_to_next: number; w: number }>(
        "SELECT s.*, screen_window_of(now()) AS w FROM screen_window() s",
      );
      expect(row?.window_number).toBe(row?.w);
      expect(row?.ms_to_next).toBeGreaterThan(0);
      expect(row?.ms_to_next).toBeLessThanOrEqual(30_000);
    });
  });

  // ============================================================ the pairing table
  describe("pairing (FR-1713, ADR-239)", () => {
    it("request → claim → paired and not activated; the request goes; audited without a secret or code", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const pending = await openRequest();
      expect(await session(pending.secret)).toMatchObject({ state: "pending", kind: "station" });
      const id = await teamClaim(pending, event, "station", quest, { label: "  Hall B TV " });
      expect(await session(pending.secret)).toMatchObject({
        state: "paired",
        device_id: id,
        kind: "station",
        activated: false,
      });
      expect(
        await owner("SELECT 1 FROM device_request WHERE code_hash = $1", [pending.code]),
      ).toEqual([]);
      const [row] = await owner<Row>(
        "SELECT label, client, paired_by_staff, quest_id FROM paired_device WHERE id = $1",
        [id],
      );
      expect(row).toEqual({
        label: "Hall B TV",
        client: "Chrome on Android",
        paired_by_staff: ownerA,
        quest_id: quest,
      });
      const [audit] = await owner<{ actor_type: string; after: Row }>(
        "SELECT actor_type, after FROM audit_log WHERE action = 'device.pair' AND target_id = $1",
        [id],
      );
      expect(audit).toEqual({
        actor_type: "staff",
        after: { kind: "station", label: "Hall B TV", questId: quest, operatorId: null },
      });
    });

    it("answers DV404 for an unknown, expired or already claimed code, naming the event's organizer for the count", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      expect(
        await refusal(teamClaim({ secret: hash(), code: hash() }, event, "station", quest)),
      ).toBe(`DV404:${ids.orgA}`);
      const expired = await openRequest();
      await owner(
        "UPDATE device_request SET expires_at = now() - interval '1 second' WHERE code_hash = $1",
        [expired.code],
      );
      expect(await refusal(teamClaim(expired, event, "station", quest))).toBe(`DV404:${ids.orgA}`);
      const pending = await openRequest();
      await teamClaim(pending, event, "station", quest);
      expect(await refusal(teamClaim(pending, event, "station", quest))).toBe(`DV404:${ids.orgA}`);
    });

    it("refuses a station without the screen QR, a kiosk without its method, another kind, a bad label or quest", async () => {
      const event = await newEvent();
      const printed = await newQuest(event, { verification: ["quest_qr"] });
      const quest = await newQuest(event);
      const other = await newQuest(await newEvent());
      const pending = await openRequest();
      expect(await refusal(teamClaim(pending, event, "station", printed))).toBe(
        "DV409:not_screen_qr",
      );
      expect(await refusal(teamClaim(await openRequest("kiosk"), event, "kiosk", quest))).toBe(
        "DV409:not_kiosk",
      );
      expect(await refusal(teamClaim(pending, event, "screen", null))).toBe("DV409:wrong_kind");
      expect(await refusal(teamClaim(pending, event, "station", null))).toBe("DV422:quest");
      expect(await refusal(teamClaim(await openRequest("screen"), event, "screen", quest))).toBe(
        "DV422:quest",
      );
      expect(await refusal(teamClaim(pending, event, "station", quest, { label: "  " }))).toBe(
        "DV422:label",
      );
      expect(
        await refusal(teamClaim(pending, event, "station", quest, { label: "x".repeat(41) })),
      ).toBe("DV422:label");
      expect(await refusal(teamClaim(pending, event, "station", other))).toBe("OQ404");
      expect(
        await refusal(teamClaim(pending, event, "station", quest, { label: "x".repeat(40) })),
      ).toBe("none");
    });

    it("pairs a big screen from the dashboard with no quest", async () => {
      const event = await newEvent();
      const pending = await openRequest("screen", "Safari on iPadOS");
      const id = await teamClaim(pending, event, "screen", null);
      expect(await session(pending.secret)).toMatchObject({ state: "paired", kind: "screen" });
      expect(await deviceRow(id)).toMatchObject({ status: "active" });
    });

    it("lets an editor pair; another organizer's team gets AN404", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const editor = await addMember(db.owner, ids.orgA, "editor");
      const id = await teamClaim(await openRequest(), event, "station", quest, {
        team: { organizerId: ids.orgA, staffUserId: editor },
      });
      expect(await deviceRow(id)).toMatchObject({ paired_by_staff: editor });
      expect(
        await refusal(teamClaim(await openRequest(), event, "station", quest, { team: teamB() })),
      ).toBe("AN404");
    });

    it("an operator pairs a station within their ability and quest limit; never a big screen", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const outside = await newQuest(event);
      const op = await operator(event);
      const id = await operatorClaim(op.player, await openRequest(), event, "station", quest);
      expect(await deviceRow(id)).toMatchObject({
        paired_by_operator: op.assignment,
        paired_by_staff: null,
      });
      const [audit] = await owner<{ actor_type: string; after: Row }>(
        "SELECT actor_type, after FROM audit_log WHERE action = 'device.pair' AND target_id = $1",
        [id],
      );
      expect(audit).toMatchObject({ actor_type: "system", after: { operatorId: op.assignment } });
      expect(
        await refusal(operatorClaim(op.player, await openRequest("screen"), event, "screen", null)),
      ).toBe("DV422:kind");
      const stranger = await member(event);
      expect(
        await refusal(operatorClaim(stranger.player, await openRequest(), event, "station", quest)),
      ).toBe("OP403");
      const off = await operator(event, ["scan_quests"]);
      expect(
        await refusal(operatorClaim(off.player, await openRequest(), event, "station", quest)),
      ).toBe("OA403");
      await owner(
        "INSERT INTO staff_assignment_quest (assignment_id, event_id, quest_id) VALUES ($1, $2, $3)",
        [op.assignment, event, quest],
      );
      expect(
        await refusal(operatorClaim(op.player, await openRequest(), event, "station", outside)),
      ).toBe("OS403");
      expect(
        await refusal(
          operatorClaim(op.player, await openRequest(), event, "station", randomUUID()),
        ),
      ).toBe("OQ404");
    });

    it("holds 200 active devices an event; a revoked one frees its place", async () => {
      const event = await newEvent();
      await owner(
        `INSERT INTO paired_device (organizer_id, event_id, kind, label, secret_hash, paired_by_staff)
         SELECT $1, $2, 'screen', 'TV', sha256(random()::text::bytea), $3 FROM generate_series(1, 200)`,
        [ids.orgA, event, ownerA],
      );
      const pending = await openRequest("screen");
      expect(await refusal(teamClaim(pending, event, "screen", null))).toBe("DV409:limit_reached");
      await owner(
        "UPDATE paired_device SET status = 'revoked', revoked_at = now() WHERE id = (SELECT id FROM paired_device WHERE event_id = $1 LIMIT 1)",
        [event],
      );
      expect(await refusal(teamClaim(pending, event, "screen", null))).toBe("none");
    });

    it("pairs in Draft and Scheduled, never once the event has ended", async () => {
      const draft = await newEvent("draft", "1 day", "2 days");
      expect(await refusal(teamClaim(await openRequest("screen"), draft, "screen", null))).toBe(
        "none",
      );
      const ended = await newEvent("live", "-2 days", "-1 hour");
      expect(await refusal(teamClaim(await openRequest("screen"), ended, "screen", null))).toBe(
        "DV409:event_closed",
      );
    });

    it("previews a code's kind and client for the event's operator or team; DV404 for a stranger's guess", async () => {
      const event = await newEvent();
      const op = await operator(event);
      const pending = await openRequest("station", "Firefox on Windows");
      const [shown] = await query<Row>(
        as(op.player),
        "SELECT kind, client FROM preview_device($1, $2)",
        [pending.code, event],
      );
      expect(shown).toEqual({ kind: "station", client: "Firefox on Windows" });
      const [team] = await query<Row>(teamA(), "SELECT kind FROM preview_device($1, $2)", [
        pending.code,
        event,
      ]);
      expect(team).toEqual({ kind: "station" });
      expect(
        await refusal(
          query(as((await member(event)).player), "SELECT * FROM preview_device($1, $2)", [
            pending.code,
            event,
          ]),
        ),
      ).toBe("OP403");
      expect(
        await refusal(
          query(teamB(), "SELECT * FROM preview_device($1, $2)", [pending.code, event]),
        ),
      ).toBe("AN404");
      expect(
        await refusal(query(teamA(), "SELECT * FROM preview_device($1, $2)", [hash(), event])),
      ).toBe(`DV404:${ids.orgA}`);
    });
  });

  // ============================================================ requests
  describe("requests", () => {
    it("refuses a taken code (the API draws another) and renews a pending device's code under the same secret", async () => {
      const first = await openRequest();
      expect(
        await refusal(
          query({}, "SELECT * FROM open_device_request($1, $2, 'station', '')", [
            hash(),
            first.code,
          ]),
        ),
      ).toBe("DV409:code_taken");
      const fresh = hash();
      const [renewed] = await query<{ until: Date }>(
        {},
        "SELECT renew_device_request($1, $2) AS until",
        [first.secret, fresh],
      );
      expect(renewed?.until).toBeInstanceOf(Date);
      expect(
        await owner("SELECT 1 FROM device_request WHERE secret_hash = $1 AND code_hash = $2", [
          first.secret,
          fresh,
        ]),
      ).toHaveLength(1);
      expect(
        await refusal(query({}, "SELECT renew_device_request($1, $2)", [first.secret, fresh])),
      ).toBe("DV409:code_taken");
      expect(
        await refusal(query({}, "SELECT renew_device_request($1, $2)", [hash(), hash()])),
      ).toBe("DV401");
    });

    it("renews only within an hour of the request; then the cookie opens nothing (CTO code review 1)", async () => {
      const pending = await openRequest("screen");
      await owner(
        "UPDATE device_request SET created_at = now() - interval '59 minutes' WHERE secret_hash = $1",
        [pending.secret],
      );
      expect(
        await refusal(query({}, "SELECT renew_device_request($1, $2)", [pending.secret, hash()])),
      ).toBe("none");
      await owner(
        "UPDATE device_request SET created_at = now() - interval '61 minutes' WHERE secret_hash = $1",
        [pending.secret],
      );
      expect(
        await refusal(query({}, "SELECT renew_device_request($1, $2)", [pending.secret, hash()])),
      ).toBe("DV401");
      expect(await session(pending.secret)).toBeUndefined();
    });

    it("refuses an unknown kind, a long client name and malformed hashes", async () => {
      expect(
        await refusal(
          query({}, "SELECT * FROM open_device_request($1, $2, 'phone', '')", [hash(), hash()]),
        ),
      ).toBe("DV422:kind");
      expect(
        await refusal(
          query({}, "SELECT * FROM open_device_request($1, $2, 'screen', $3)", [
            hash(),
            hash(),
            "x".repeat(61),
          ]),
        ),
      ).toBe("DV422:client");
      expect(
        await refusal(
          query({}, "SELECT * FROM open_device_request($1, $2, 'screen', '')", [
            randomBytes(8),
            hash(),
          ]),
        ),
      ).toBe("DV422:secret");
    });

    it("sweeps 100 long-expired requests per call and refuses at 5,000 unexpired (the flood cap, CTO 9)", async () => {
      await owner(
        `INSERT INTO device_request (secret_hash, code_hash, kind, expires_at)
         SELECT sha256(random()::text::bytea), sha256(random()::text::bytea), 'screen', now() - interval '2 days'
         FROM generate_series(1, 150)`,
      );
      const before = await owner<{ n: number }>(
        "SELECT count(*)::int AS n FROM device_request WHERE expires_at < now() - interval '1 day'",
      );
      await openRequest();
      const after = await owner<{ n: number }>(
        "SELECT count(*)::int AS n FROM device_request WHERE expires_at < now() - interval '1 day'",
      );
      expect((before[0]?.n ?? 0) - (after[0]?.n ?? 0)).toBe(100);
      await owner(
        `INSERT INTO device_request (secret_hash, code_hash, kind, expires_at)
         SELECT sha256(random()::text::bytea), sha256(random()::text::bytea), 'screen', now() + interval '10 minutes'
         FROM generate_series(1, 5000)`,
      );
      expect(
        await refusal(
          query({}, "SELECT * FROM open_device_request($1, $2, 'screen', '')", [hash(), hash()]),
        ),
      ).toBe("DV503:busy");
      await owner("DELETE FROM device_request WHERE expires_at > now() AND client = ''");
    });
  });

  // ============================================================ activation (CTO 2)
  describe("activation (CTO 2)", () => {
    it("replaces the secret; the old one works only to activate again, until the new one is used", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const pending = await openRequest();
      const id = await teamClaim(pending, event, "station", quest);
      const first = await activate(pending.secret);
      expect(first.rotated).toBe(true);
      expect(await session(pending.secret)).toMatchObject({
        state: "paired",
        device_id: id,
        activated: false,
      });
      expect(await session(first.fresh)).toMatchObject({ state: "paired", activated: true });
      expect(await session(pending.secret)).toBeUndefined();
    });

    it("a second activation with the old secret inside the 60 s issues a fresh secret and never extends the window", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const pending = await openRequest();
      const id = await teamClaim(pending, event, "station", quest);
      const lost = await activate(pending.secret);
      const [before] = await owner<{ until: Date }>(
        "SELECT previous_until AS until FROM paired_device WHERE id = $1",
        [id],
      );
      const again = await activate(pending.secret);
      expect(again.rotated).toBe(true);
      const [after] = await owner<{ until: Date }>(
        "SELECT previous_until AS until FROM paired_device WHERE id = $1",
        [id],
      );
      expect(after?.until.getTime()).toBe(before?.until.getTime());
      expect(await session(lost.fresh)).toBeUndefined();
      expect(await session(again.fresh)).toMatchObject({ activated: true });
    });

    it("refuses the old secret once its 60 seconds have passed", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const pending = await openRequest();
      const id = await teamClaim(pending, event, "station", quest);
      await activate(pending.secret);
      await owner(
        "UPDATE paired_device SET previous_until = now() - interval '1 second' WHERE id = $1",
        [id],
      );
      expect(await session(pending.secret)).toBeUndefined();
      expect(await refusal(activate(pending.secret))).toBe("DV401");
    });

    it("an activated device activating again under its current secret changes nothing; a renew keeps the same secret (CTO 11)", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const made = await station(event, quest);
      expect((await activate(made.secret)).rotated).toBe(false);
      expect(await session(made.secret)).toMatchObject({ activated: true });
      const pending = await openRequest("screen");
      await query({}, "SELECT renew_device_request($1, $2)", [pending.secret, hash()]);
      expect(await session(pending.secret)).toMatchObject({ state: "pending", kind: "screen" });
    });

    it("never activates a pending request or an unknown secret", async () => {
      const pending = await openRequest();
      expect(await refusal(activate(pending.secret))).toBe("DV401");
      expect(await refusal(activate(hash()))).toBe("DV401");
    });

    it("refuses an unactivated device at every device door", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const pending = await openRequest();
      const id = await teamClaim(pending, event, "station", quest);
      expect(await refusal(codeFor(id))).toBe("DV401");
      expect(await refusal(view(id))).toBe("DV401");
      expect(await refusal(codeFor(randomUUID()))).toBe("DV401");
    });
  });

  // ============================================================ the end of a device
  describe("when a device stops working", () => {
    it("revoked: the session opens nothing; a second revoke is DN404; an operator revokes only their own", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const made = await station(event, quest);
      const op = await operator(event);
      const theirs = await operatorClaim(op.player, await openRequest(), event, "station", quest);
      const other = await operator(event);
      expect(
        await refusal(
          query(as(other.player), "SELECT revoke_device($1, $2, $3)", [
            event,
            theirs,
            randomUUID(),
          ]),
        ),
      ).toBe("DN404");
      await query(as(op.player), "SELECT revoke_device($1, $2, $3)", [event, theirs, randomUUID()]);
      expect(await deviceRow(theirs)).toMatchObject({ status: "revoked" });
      expect(
        await refusal(
          query(as(op.player), "SELECT revoke_device($1, $2, $3)", [event, made.id, randomUUID()]),
        ),
      ).toBe("DN404");
      await query(teamA(), "SELECT revoke_device($1, $2, $3)", [event, made.id, randomUUID()]);
      expect(await session(made.secret)).toBeUndefined();
      expect(await refusal(codeFor(made.id))).toBe("DV401");
      expect(
        await refusal(
          query(teamA(), "SELECT revoke_device($1, $2, $3)", [event, made.id, randomUUID()]),
        ),
      ).toBe("DN404");
      expect(
        await refusal(
          query(teamB(), "SELECT revoke_device($1, $2, $3)", [event, theirs, randomUUID()]),
        ),
      ).toBe("AN404");
    });

    it("revokes all big screens, or all, audited once with the count (ADR-241)", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      await teamClaim(await openRequest("screen"), event, "screen", null);
      await teamClaim(await openRequest("screen"), event, "screen", null);
      const made = await station(event, quest);
      const [screens] = await query<{ n: number }>(
        teamA(),
        "SELECT revoke_devices($1, 'screen', $2) AS n",
        [event, randomUUID()],
      );
      expect(screens?.n).toBe(2);
      expect(await session(made.secret)).toMatchObject({ state: "paired" });
      const [all] = await query<{ n: number }>(
        teamA(),
        "SELECT revoke_devices($1, NULL, $2) AS n",
        [event, randomUUID()],
      );
      expect(all?.n).toBe(1);
      const audits = await owner<{ after: Row }>(
        "SELECT after FROM audit_log WHERE action = 'device.revoke_all' AND event_id = $1 ORDER BY id",
        [event],
      );
      expect(audits.map((row) => row.after)).toEqual([
        { kind: "screen", revoked: 2 },
        { kind: null, revoked: 1 },
      ]);
    });

    it("removing an operator revokes what they paired, audited; the delete succeeds (CTO 1)", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const op = await operator(event);
      const id = await operatorClaim(op.player, await openRequest(), event, "station", quest);
      await owner("DELETE FROM staff_assignment WHERE id = $1", [op.assignment]);
      expect(await deviceRow(id)).toEqual({
        status: "revoked",
        paired_by_operator: null,
        paired_by_staff: null,
      });
      expect(await revokeAudit(id)).toMatchObject({ reason: "operator_removed", kind: "station" });
    });

    it("removing an operator with no devices is unchanged; an operator's account erasure revokes theirs", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const idle = await operator(event);
      expect(
        await refusal(owner("DELETE FROM staff_assignment WHERE id = $1", [idle.assignment])),
      ).toBe("none");
      const op = await operator(event);
      const id = await operatorClaim(op.player, await openRequest(), event, "station", quest);
      await owner("SELECT erase_rows($1, ARRAY[]::uuid[], $2)", [op.player, hash()]);
      expect(await deviceRow(id)).toMatchObject({ status: "revoked", paired_by_operator: null });
    });

    it("removing a team member revokes what they paired in that organizer; deleting the account too (CTO 1)", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const editor = await addMember(db.owner, ids.orgA, "editor");
      const team = { organizerId: ids.orgA, staffUserId: editor };
      const one = await teamClaim(await openRequest(), event, "station", quest, { team });
      await owner("DELETE FROM organizer_member WHERE organizer_id = $1 AND staff_user_id = $2", [
        ids.orgA,
        editor,
      ]);
      expect(await deviceRow(one)).toMatchObject({ status: "revoked", paired_by_staff: editor });
      expect(await revokeAudit(one)).toMatchObject({ reason: "member_removed" });
      const other = await addMember(db.owner, ids.orgA, "editor");
      const two = await teamClaim(await openRequest(), event, "station", quest, {
        team: { organizerId: ids.orgA, staffUserId: other },
      });
      expect(await refusal(owner("DELETE FROM staff_user WHERE id = $1", [other]))).toBe("none");
      expect(await deviceRow(two)).toEqual({
        status: "revoked",
        paired_by_operator: null,
        paired_by_staff: null,
      });
    });

    it("deleting an event with operator- and team-paired devices succeeds; the devices go with it (CTO 1)", async () => {
      const event = await newEvent("draft", "1 day", "2 days");
      const quest = await newQuest(event);
      const op = await operator(event);
      const theirs = await operatorClaim(op.player, await openRequest(), event, "station", quest);
      const ours = await teamClaim(await openRequest("screen"), event, "screen", null);
      expect(await refusal(owner("DELETE FROM event WHERE id = $1", [event]))).toBe("none");
      expect(
        await owner("SELECT 1 FROM paired_device WHERE id = ANY ($1)", [[theirs, ours]]),
      ).toEqual([]);
    });

    it("deleting a quest removes its stations", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const made = await station(event, quest);
      await owner("DELETE FROM quest WHERE id = $1", [quest]);
      expect(await deviceRow(made.id)).toBeUndefined();
      expect(await session(made.secret)).toBeUndefined();
    });

    it("goes blank 24 hours after its event ends, and after 30 idle days", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const made = await station(event, quest);
      await owner(
        "UPDATE event SET starts_at = now() - interval '2 days', ends_at = now() - interval '23 hours' WHERE id = $1",
        [event],
      );
      expect(await session(made.secret)).toMatchObject({ state: "paired" });
      expect((await codeFor(made.id))?.shut).toBe("event_ended");
      await owner(
        "UPDATE event SET starts_at = now() - interval '2 days', ends_at = now() - interval '25 hours' WHERE id = $1",
        [event],
      );
      expect(await session(made.secret)).toBeUndefined();
      const live = await newEvent();
      const idle = await station(live, await newQuest(live));
      await owner(
        "UPDATE paired_device SET last_seen_at = now() - interval '31 days' WHERE id = $1",
        [idle.id],
      );
      expect(await session(idle.secret)).toBeUndefined();
    });

    it("writes last_seen_at at most once a minute", async () => {
      const event = await newEvent();
      const made = await station(event, await newQuest(event));
      await owner(
        "UPDATE paired_device SET last_seen_at = now() - interval '30 seconds' WHERE id = $1",
        [made.id],
      );
      const [before] = await owner<{ at: Date }>(
        "SELECT last_seen_at AS at FROM paired_device WHERE id = $1",
        [made.id],
      );
      await session(made.secret);
      const [same] = await owner<{ at: Date }>(
        "SELECT last_seen_at AS at FROM paired_device WHERE id = $1",
        [made.id],
      );
      expect(same?.at.getTime()).toBe(before?.at.getTime());
      await owner(
        "UPDATE paired_device SET last_seen_at = now() - interval '2 minutes' WHERE id = $1",
        [made.id],
      );
      await session(made.secret);
      const [moved] = await owner<{ fresh: boolean }>(
        "SELECT last_seen_at > now() - interval '5 seconds' AS fresh FROM paired_device WHERE id = $1",
        [made.id],
      );
      expect(moved?.fresh).toBe(true);
    });
  });

  // ============================================================ the station's code
  describe("the station's code and view (FR-314)", () => {
    it("answers the quest and the window now; nothing is written", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const made = await station(event, quest);
      const at = await steadyWindow();
      const code = await codeFor(made.id);
      expect(code).toMatchObject({ quest_id: quest, shut: null, window_number: at.w });
      expect(code?.ms_to_next).toBeGreaterThan(0);
      expect(await view(made.id)).toEqual({
        kind: "station",
        label: "Hall B TV",
        event: { nameAr: null, nameEn: "Hall Fest" },
        quest: { titleAr: null, titleEn: "Screen", points: 10 },
        shut: null,
      });
    });

    it("shows no code while the quest is shut: method off, hidden, not started, ended, flash outside its window", async () => {
      const event = await newEvent();
      const cases: readonly [string, string, string][] = [
        ["method off", "UPDATE quest SET verification = '{quest_qr}' WHERE id = $1", "method_off"],
        ["hidden", "UPDATE quest SET visible = false WHERE id = $1", "hidden"],
        [
          "not started",
          "UPDATE quest SET opens_at = now() + interval '1 hour' WHERE id = $1",
          "not_started",
        ],
        [
          "ended",
          "UPDATE quest SET opens_at = now() - interval '2 hours', closes_at = now() - interval '1 hour' WHERE id = $1",
          "ended",
        ],
        [
          "flash, outside its window",
          "UPDATE quest SET flash = true, opens_at = now() + interval '1 hour', closes_at = now() + interval '2 hours' WHERE id = $1",
          "not_started",
        ],
      ];
      for (const [name, sql, expected] of cases) {
        const quest = await newQuest(event);
        const made = await station(event, quest);
        await owner(sql, [quest]);
        const code = await codeFor(made.id);
        expect(code?.shut, name).toBe(expected);
        expect(code?.window_number, name).toBeNull();
        expect((await view(made.id))?.["shut"], name).toBe(expected);
      }
    });

    it("hides a flash quest in its window while flash quests are switched off", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      await owner(
        "UPDATE quest SET flash = true, opens_at = now() - interval '1 minute', closes_at = now() + interval '1 hour' WHERE id = $1",
        [quest],
      );
      const made = await station(event, quest);
      expect((await codeFor(made.id))?.shut).toBeNull();
      await owner(
        `UPDATE event SET config = jsonb_set(config, '{features}', coalesce(config -> 'features', '{}') || '{"flashQuests": false}')
         WHERE id = $1`,
        [event],
      );
      expect((await codeFor(made.id))?.shut).toBe("hidden");
    });

    it("a big screen has no code and never a quest", async () => {
      const event = await newEvent();
      const pending = await openRequest("screen");
      const id = await teamClaim(pending, event, "screen", null);
      await activate(pending.secret);
      expect((await codeFor(id))?.shut).toBe("not_station");
      expect(await view(id)).toMatchObject({ kind: "screen", quest: null, shut: null });
    });

    it("pauses a station whose operator lost the ability or the quest, and resumes when it comes back (CTO 3)", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const other = await newQuest(event);
      const op = await operator(event);
      const pending = await openRequest();
      const id = await operatorClaim(op.player, pending, event, "station", quest);
      await activate(pending.secret);
      expect((await codeFor(id))?.shut).toBeNull();
      await owner("UPDATE staff_assignment SET abilities = '{scan_quests}' WHERE id = $1", [
        op.assignment,
      ]);
      expect((await codeFor(id))?.shut).toBe("paused");
      expect((await view(id))?.["shut"]).toBe("paused");
      await owner(
        "UPDATE staff_assignment SET abilities = '{scan_quests,show_rotating_qr}' WHERE id = $1",
        [op.assignment],
      );
      expect((await codeFor(id))?.shut).toBeNull();
      await owner(
        "INSERT INTO staff_assignment_quest (assignment_id, event_id, quest_id) VALUES ($1, $2, $3)",
        [op.assignment, event, other],
      );
      expect((await codeFor(id))?.shut).toBe("paused");
      await owner(
        "INSERT INTO staff_assignment_quest (assignment_id, event_id, quest_id) VALUES ($1, $2, $3)",
        [op.assignment, event, quest],
      );
      expect((await codeFor(id))?.shut).toBeNull();
    });

    it("the operator's own phone: the code within their ability and limit", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const op = await operator(event);
      const [code] = await query<ScreenCode>(
        as(op.player),
        "SELECT * FROM screen_code_for_operator($1, $2)",
        [event, quest],
      );
      expect(code).toMatchObject({ quest_id: quest, shut: null });
      const off = await operator(event, ["scan_quests"]);
      expect(
        await refusal(
          query(as(off.player), "SELECT * FROM screen_code_for_operator($1, $2)", [event, quest]),
        ),
      ).toBe("OA403");
      const printed = await newQuest(event, { verification: ["quest_qr"] });
      const [shut] = await query<ScreenCode>(
        as(op.player),
        "SELECT * FROM screen_code_for_operator($1, $2)",
        [event, printed],
      );
      expect(shut?.shut).toBe("method_off");
      const page = (
        await query<{ page: { quests: Row[]; devices: Row[] } }>(
          as(op.player),
          "SELECT operator_devices($1) AS page",
          [event],
        )
      )[0]?.page;
      expect(page?.quests.map((row) => row["id"])).toContain(quest);
      expect(page?.quests.map((row) => row["id"])).not.toContain(printed);
    });

    it("lists the event's devices for the team, never a secret; another organizer's team gets AN404", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const made = await station(event, quest);
      const [listed] = await query<{ list: Row[] }>(teamA(), "SELECT event_devices($1) AS list", [
        event,
      ]);
      expect(listed?.list).toHaveLength(1);
      expect(listed?.list[0]).toMatchObject({
        id: made.id,
        kind: "station",
        label: "Hall B TV",
        questId: quest,
        questTitleEn: "Screen",
        client: "Chrome on Android",
        activated: true,
        status: "active",
        paused: false,
      });
      expect(JSON.stringify(listed?.list)).not.toMatch(/secret|hash/i);
      expect(await refusal(query(teamB(), "SELECT event_devices($1)", [event]))).toBe("AN404");
    });
  });

  // ============================================================ the screen door table
  describe("the screen door table (FR-314)", () => {
    it("pays the current window as method screen_qr; refuses two windows back and a future one", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const who = await member(event);
      const at = await steadyWindow();
      const paid = await scan(who.player, quest, at.w);
      expect(paid?.points).toBe("10");
      const [row] = await owner<{ method: string }>(
        "SELECT method FROM quest_completion WHERE id = $1",
        [paid?.completion_id],
      );
      expect(row?.method).toBe("screen_qr");
      const late = await member(event);
      expect(await refusal(scan(late.player, quest, at.w - 2))).toBe("QV422:expired");
      expect(await refusal(scan(late.player, quest, at.w + 1))).toBe("QV422:expired");
    });

    it("pays the previous window only before second 15 of the current one", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const who = await member(event);
      const at = await steadyWindow();
      const outcome = await refusal(scan(who.player, quest, at.w - 1));
      expect(outcome).toBe(at.s < 15 ? "none" : "QV422:expired");
    });

    it("runs every rule of the one door: method off, hidden, not started, ended, audience, cap", async () => {
      const event = await newEvent();
      const cases: readonly [string, string, string][] = [
        [
          "screen off after showing",
          "UPDATE quest SET verification = '{my_qr}' WHERE id = $1",
          "QV422:wrong_method",
        ],
        ["hidden", "UPDATE quest SET visible = false WHERE id = $1", "QN403:hidden"],
        [
          "not started",
          "UPDATE quest SET opens_at = now() + interval '1 hour' WHERE id = $1",
          "QN403:not_started",
        ],
        [
          "ended",
          "UPDATE quest SET opens_at = now() - interval '2 hours', closes_at = now() - interval '1 hour' WHERE id = $1",
          "QN403:ended",
        ],
        [
          "not in the audience",
          "UPDATE category SET hidden = true WHERE id = (SELECT category_id FROM quest WHERE id = $1)",
          "QN403:not_for_you",
        ],
      ];
      const at = await steadyWindow();
      for (const [name, sql, expected] of cases) {
        const quest = await newQuest(event);
        const who = await member(event);
        await owner(sql, [quest]);
        expect(await refusal(scan(who.player, quest, at.w)), name).toBe(expected);
      }
      const capped = await newQuest(event, { repeat: 1 });
      const who = await member(event);
      await scan(who.player, capped, at.w);
      await owner(
        "UPDATE quest_completion SET created_at = now() - interval '1 minute' WHERE quest_id = $1",
        [capped],
      );
      expect(await refusal(scan(who.player, capped, at.w))).toBe("QD409:1");
    });

    it("keeps a category lock", async () => {
      const event = await newEvent();
      const first = await newCategory(event);
      const second = await newCategory(event);
      await newQuest(event, { category: first });
      await owner("UPDATE category SET unlock_after = $2 WHERE id = $1", [second, first]);
      const quest = await newQuest(event, { category: second });
      const who = await member(event);
      const at = await steadyWindow();
      expect(await refusal(scan(who.player, quest, at.w))).toMatch(/^QN403:/);
    });

    it("pays one player once per window on a repeatable quest (CTO 6), again after 45 seconds", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, { repeat: 10 });
      const who = await member(event);
      const at = await steadyWindow();
      await scan(who.player, quest, at.w);
      expect(await refusal(scan(who.player, quest, at.w))).toBe("QD409:10");
      const friend = await member(event);
      expect(await refusal(scan(friend.player, quest, at.w))).toBe("none");
      await owner(
        "UPDATE quest_completion SET created_at = now() - interval '46 seconds' WHERE enrollment_id = $1",
        [who.enrollment],
      );
      expect(await refusal(scan(who.player, quest, at.w))).toBe("none");
    });

    it("replays a retry with the same key; the same key on another quest is QK422", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const other = await newQuest(event);
      const who = await member(event);
      const at = await steadyWindow();
      const key = randomUUID();
      const first = await scan(who.player, quest, at.w, key);
      const again = await scan(who.player, quest, at.w, key);
      expect(again).toMatchObject({ completion_id: first?.completion_id, replayed: true });
      expect(await refusal(scan(who.player, other, at.w, key))).toBe("QK422");
    });

    it("pays a boost in force ×2, as a scan", async () => {
      const event = await newEvent();
      const category = await newCategory(event);
      const quest = await newQuest(event, { category });
      await owner(
        `INSERT INTO boost (organizer_id, event_id, category_id, starts_at, ends_at)
         VALUES ($1, $2, $3, now() - interval '5 minutes', now() + interval '30 minutes')`,
        [ids.orgA, event, category],
      );
      const who = await member(event);
      const at = await steadyWindow();
      expect((await scan(who.player, quest, at.w))?.points).toBe("20");
    });

    it("never pays the screen method at another door (my_qr, nfc are their own)", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, { verification: ["my_qr", "screen_qr"] });
      const who = await member(event);
      for (const method of ["nfc", "my_qr", "kiosk"]) {
        expect(
          await refusal(
            query(as(who.player), "SELECT * FROM complete_quest($1, $2, 1, NULL, $3, NULL)", [
              quest,
              method,
              randomUUID(),
            ]),
          ),
          method,
        ).toBe("QV422:wrong_method");
      }
    });

    it("pays a rehearsal account during rehearsal; after go-live the wipe runs first and the account is gone", async () => {
      const event = await newEvent("scheduled", "30 minutes", "1 day");
      counter += 1;
      await owner(
        "INSERT INTO event_rehearsal (event_id, organizer_id, code) VALUES ($1, $2, $3)",
        [
          event,
          ids.orgA,
          `${LETTERS[counter % 24]}${LETTERS[Math.floor(counter / 24) % 24]}DV-SCRN`,
        ],
      );
      const quest = await newQuest(event);
      const made = await station(event, quest);
      const rehearsal = await member(event, "rehearsal");
      const at = await steadyWindow();
      expect(await refusal(scan(rehearsal.player, quest, at.w))).toBe("none");
      await owner(
        "UPDATE event SET status = 'live', starts_at = now() - interval '1 minute' WHERE id = $1",
        [event],
      );
      expect(await refusal(scan(rehearsal.player, quest, at.w))).toBe("QC404");
      expect(await deviceRow(made.id)).toMatchObject({ status: "active" });
      const player = await member(event);
      expect(await refusal(scan(player.player, quest, at.w))).toBe("none");
    });
  });

  // ============================================================ crossed locks
  describe("crossed locks", () => {
    it("two renews racing for one code: the second answers code_taken, never a raw key error (CTO code review 7)", async () => {
      const one = await openRequest();
      const two = await openRequest();
      const code = hash();
      const held = await hold({}, "SELECT renew_device_request($1, $2)", [one.secret, code]);
      const second = refusal(query({}, "SELECT renew_device_request($1, $2)", [two.secret, code]));
      expect(await waitsOnLock("renew_device_request")).toBe(true);
      held.release();
      await held.done;
      expect(await second).toBe("DV409:code_taken");
    });

    it("two claims of one code: the second waits on the request and finds none (DV404)", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const pending = await openRequest();
      const held = await hold(
        teamA(),
        "SELECT team_claim_device($1, $2, 'station', $3, 'One', $4)",
        [pending.code, event, quest, randomUUID()],
      );
      const second = refusal(teamClaim(pending, event, "station", quest));
      expect(await waitsOnLock("team_claim_device")).toBe(true);
      held.release();
      await held.done;
      expect(await second).toBe(`DV404:${ids.orgA}`);
      expect(await owner("SELECT 1 FROM paired_device WHERE event_id = $1", [event])).toHaveLength(
        1,
      );
    });

    it("a revoke while a station fetches its code: the fetch reads without a lock and answers its window", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const made = await station(event, quest);
      const held = await hold({ deviceId: made.id }, "SELECT * FROM screen_code_for_device()", []);
      await query(teamA(), "SELECT revoke_device($1, $2, $3)", [event, made.id, randomUUID()]);
      held.release();
      const rows = (await held.done) as ScreenCode[];
      expect(rows[0]?.quest_id).toBe(quest);
      expect(await refusal(codeFor(made.id))).toBe("DV401");
    });

    it("an activation in flight holds the device row: an old-secret activation waits, then draws its own secret", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const pending = await openRequest();
      const id = await teamClaim(pending, event, "station", quest);
      const first = hash();
      const held = await hold({}, "SELECT activate_device($1, $2)", [pending.secret, first]);
      const second = activate(pending.secret);
      expect(await waitsOnLock("activate_device")).toBe(true);
      held.release();
      await held.done;
      const again = await second;
      expect(again.rotated).toBe(true);
      expect(await session(first)).toBeUndefined();
      expect(await session(again.fresh)).toMatchObject({ device_id: id, activated: true });
    });
  });
});
