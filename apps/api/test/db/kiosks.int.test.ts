import { randomBytes, randomUUID } from "node:crypto";
import { Client, Pool, type PoolClient } from "pg";
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
type Paid = Readonly<{
  completion_id: string;
  points: string;
  occurrence: number;
  replayed: boolean;
  boosted: boolean;
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
const KIOSK = ["kiosk"];
const noop = (): void => undefined;
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const hash = (): Buffer => randomBytes(32);
const idsOf = (rows: Row[] | undefined): string[] =>
  (rows ?? []).map((row) => String(row["id"])).toSorted();

/**
 * The kiosk in the database (T-309b, migration 0058, ADR-242, ADR-244): the method's walls, the reserved `kiosk:` keys,
 * the kiosk door table (windows, the one-pay rule, every rule of the one door, the device's states, the self-scan, the
 * boost, rehearsal), the kiosk's view and lists, `kiosk_scan`'s cascades and survival, the flags, and the crossed locks.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("kiosks (database)", () => {
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

  const newEvent = async (status = "live", startsIn = "-2 hours", endsIn = "1 day") => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Hall Fest', $3, now() + $4::interval, now() + $5::interval) RETURNING id`,
      [ids.orgA, `KSK${counter}`, status, startsIn, endsIn],
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
       VALUES ($1, $2, $3, 'Kiosk', 10, $4, $5) RETURNING id`,
      [
        event,
        fields.category ?? (await newCategory(event)),
        fields.type ?? "scan_qr",
        fields.repeat ?? 100,
        fields.verification ?? KIOSK,
      ],
    );
    return quest?.id ?? "";
  };
  const member = async (event: string, via = "code"): Promise<Member> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`ksk_player_${counter}`],
    );
    const [made] = await owner<{ id: string }>(
      `INSERT INTO enrollment (organizer_id, event_id, player_id, joined_via)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [ids.orgA, event, player?.id, via],
    );
    return { player: player?.id ?? "", enrollment: made?.id ?? "" };
  };
  const operator = async (
    event: string,
    abilities = ["scan_quests", "show_rotating_qr"],
    via = "operator",
  ) => {
    const who = await member(event, via);
    const [made] = await owner<{ id: string }>(
      `INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [ids.orgA, event, who.player, abilities],
    );
    return { ...who, assignment: made?.id ?? "" };
  };
  const openRequest = async (kind = "kiosk") => {
    const pending = { secret: hash(), code: hash() };
    await query({}, "SELECT * FROM open_device_request($1, $2, $3, 'Safari on iPadOS')", [
      pending.secret,
      pending.code,
      kind,
    ]);
    return pending;
  };
  const activate = (secret: Buffer) =>
    query({}, "SELECT activate_device($1, $2)", [secret, hash()]);
  /** A kiosk (or another kind) paired by the team, or by an operator when `by` is given, and activated. */
  const kiosk = async (
    event: string,
    quest: string | null,
    fields: Readonly<{ by?: string; kind?: string; activated?: boolean }> = {},
  ) => {
    const kind = fields.kind ?? "kiosk";
    const pending = await openRequest(kind);
    const [row] =
      fields.by === undefined
        ? await query<{ id: string }>(
            teamA(),
            "SELECT team_claim_device($1, $2, $3, $4, 'Gate tablet', $5) AS id",
            [pending.code, event, kind, quest, randomUUID()],
          )
        : await query<{ id: string }>(
            as(fields.by),
            "SELECT operator_claim_device($1, $2, $3, $4, 'Gate tablet', $5) AS id",
            [pending.code, event, kind, quest, randomUUID()],
          );
    if (fields.activated !== false) {
      await activate(pending.secret);
    }
    return row?.id ?? "";
  };
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
  const scan = (device: string, player: string, window: number, key: string = randomUUID()) =>
    query<Paid>({ deviceId: device }, "SELECT * FROM kiosk_complete_quest($1, $2, $3)", [
      player,
      window,
      key,
    ]).then((rows) => rows[0]);
  const subject = (device: string, player: string) =>
    query<{ username: string; avatar: string }>(
      { deviceId: device },
      "SELECT * FROM kiosk_scan_subject($1)",
      [player],
    );
  const view = async (device: string) =>
    (await query<{ view: Row }>({ deviceId: device }, "SELECT device_view() AS view"))[0]?.view;
  const kioskScans = (completion: string | undefined) =>
    owner("SELECT * FROM kiosk_scan WHERE completion_id = $1", [completion]);
  /** A second connection as the owner, for a write held open while another waits on it. */
  const ownerClient = async () => {
    const url = new URL(TEST_DATABASE_URL ?? "");
    url.pathname = `/${db.owner.database ?? ""}`;
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    return client;
  };
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

  // ============================================================ the method's walls
  describe("the method (FR-315)", () => {
    it("allows the kiosk on scan quests with any other scan method; never on another type", async () => {
      const event = await newEvent();
      for (const verification of [
        ["kiosk"],
        ["quest_qr", "kiosk"],
        ["my_qr", "kiosk"],
        ["screen_qr", "kiosk"],
        ["quest_qr", "nfc", "kiosk"],
      ]) {
        expect(await refusal(newQuest(event, { verification })), verification.join()).toBe("none");
      }
      for (const type of ["challenge", "location", "quiz"]) {
        expect(await refusal(newQuest(event, { type, verification: ["kiosk"] })), type).toBe(
          "23514",
        );
      }
    });

    it("takes `kiosk` as a completion method, which a challenge's direct insert still cannot fake into a payment", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const who = await member(event);
      expect(
        await refusal(
          owner(
            `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                           idempotency_key)
             VALUES ($1, $2, $3, $4, 1, 'telepathy', 'k')`,
            [ids.orgA, event, who.enrollment, quest],
          ),
        ),
      ).toBe("23514");
      expect(
        await refusal(
          query(
            teamA(),
            "INSERT INTO kiosk_scan (completion_id, organizer_id, event_id) VALUES (1, $1, $2)",
            [ids.orgA, event],
          ),
        ),
      ).toBe("42501");
    });

    it("keeps kiosk_scan closed to the API role", async () => {
      expect(await refusal(query(teamA(), "SELECT * FROM kiosk_scan"))).toBe("42501");
    });
  });

  // ============================================================ reserved keys
  describe("the kiosk's keys (ADR-244)", () => {
    it("refuses a kiosk: key at every other door, and the kiosk method at complete_quest", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, { verification: ["quest_qr", "kiosk"] });
      const who = await member(event);
      expect(
        await refusal(
          query(as(who.player), "SELECT * FROM complete_quest($1, 'qr', 1, NULL, $2, NULL)", [
            quest,
            `kiosk:${randomUUID()}:${randomUUID()}`,
          ]),
        ),
      ).toBe("QK422");
      expect(
        await refusal(
          query(as(who.player), "SELECT * FROM complete_quest($1, 'kiosk', 1, NULL, $2, NULL)", [
            quest,
            randomUUID(),
          ]),
        ),
      ).toBe("QV422:wrong_method");
    });

    it("refuses the kiosk method with any other key, a NULL key included (CTO note 1)", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const who = await member(event);
      for (const key of [randomUUID(), null]) {
        expect(
          await refusal(
            owner(
              "SELECT * FROM record_completion($1, $2, 'kiosk', 1, NULL, $3, NULL, NULL, NULL, NULL, $4)",
              [quest, who.player, key, event],
            ),
          ),
          String(key),
        ).toBe("QK422");
      }
    });

    it("refuses a key that is not a UUID at the kiosk door", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const device = await kiosk(event, quest);
      const who = await member(event);
      const at = await steadyWindow();
      for (const key of ["not-a-uuid", "x".repeat(36), ""]) {
        expect(await refusal(scan(device, who.player, at.w, key)), key).toBe("QK422");
      }
    });
  });

  // ============================================================ the kiosk door table
  describe("the kiosk door table (FR-315)", () => {
    it("pays the current window as method kiosk, named in kiosk_scan; actor player, no install id", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const device = await kiosk(event, quest);
      const who = await member(event);
      const at = await steadyWindow();
      const paid = await scan(device, who.player, at.w);
      expect(paid).toMatchObject({ points: "10", occurrence: 1, replayed: false, boosted: false });
      const [row] = await owner<{ method: string; device_id: string | null; actor: string }>(
        `SELECT c.method, c.device_id, l.actor FROM quest_completion c
         JOIN ledger_entry l ON l.completion_id = c.id AND l.kind = 'quest' WHERE c.id = $1`,
        [paid?.completion_id],
      );
      expect(row).toEqual({ method: "kiosk", device_id: null, actor: "player" });
      expect(await kioskScans(paid?.completion_id)).toMatchObject([
        { device_id: device, organizer_id: ids.orgA, event_id: event },
      ]);
      expect(await subject(device, who.player)).toEqual([
        expect.objectContaining({ username: expect.stringMatching(/^ksk_player_/) }),
      ]);
    });

    it("refuses two windows back and a future one; the previous only before second 15", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const device = await kiosk(event, quest);
      const who = await member(event);
      const at = await steadyWindow();
      expect(await refusal(scan(device, who.player, at.w - 2))).toBe("QV422:expired");
      expect(await refusal(scan(device, who.player, at.w + 1))).toBe("QV422:expired");
      expect(await refusal(scan(device, who.player, at.w - 1))).toBe(
        at.s < 15 ? "none" : "QV422:expired",
      );
    });

    it("runs every rule of the one door: not in the event, inactive, hidden, not started, ended, audience, lock, method off, cap", async () => {
      const event = await newEvent();
      const at = await steadyWindow();
      const outsider = await member(await newEvent());
      const quest = await newQuest(event);
      const device = await kiosk(event, quest);
      expect(await refusal(scan(device, outsider.player, at.w))).toBe("QC404");
      const inactive = await member(event);
      await owner("UPDATE enrollment SET status = 'left' WHERE id = $1", [inactive.enrollment]);
      expect(await refusal(scan(device, inactive.player, at.w))).toMatch(/^QC403/);
      const cases: readonly [string, string, string][] = [
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
        [
          "kiosk off after pairing",
          "UPDATE quest SET verification = '{my_qr}' WHERE id = $1",
          "QV422:wrong_method",
        ],
      ];
      for (const [name, sql, expected] of cases) {
        const target = await newQuest(event);
        const tablet = await kiosk(event, target);
        const who = await member(event);
        await owner(sql, [target]);
        expect(await refusal(scan(tablet, who.player, at.w)), name).toBe(expected);
      }
      const first = await newCategory(event);
      const second = await newCategory(event);
      await newQuest(event, { category: first });
      await owner("UPDATE category SET unlock_after = $2 WHERE id = $1", [second, first]);
      const locked = await newQuest(event, { category: second });
      const lockedKiosk = await kiosk(event, locked);
      expect(await refusal(scan(lockedKiosk, (await member(event)).player, at.w))).toMatch(
        /^QN403:/,
      );
      const capped = await newQuest(event, { repeat: 1 });
      const cappedKiosk = await kiosk(event, capped);
      const who = await member(event);
      await scan(cappedKiosk, who.player, at.w);
      await owner(
        "UPDATE quest_completion SET created_at = now() - interval '1 minute' WHERE quest_id = $1",
        [capped],
      );
      expect(await refusal(scan(cappedKiosk, who.player, at.w))).toBe("QD409:1");
    });

    it("pays one held-up code once on a repeatable quest; a new code after 45 s pays again; two quests both pay", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, { repeat: 10 });
      const device = await kiosk(event, quest);
      const otherKiosk = await kiosk(event, quest);
      const who = await member(event);
      const at = await steadyWindow();
      await scan(device, who.player, at.w);
      expect(await refusal(scan(device, who.player, at.w))).toBe("QD409:10");
      expect(await refusal(scan(otherKiosk, who.player, at.w))).toBe("QD409:10");
      const elsewhere = await kiosk(event, await newQuest(event));
      expect(await refusal(scan(elsewhere, who.player, at.w))).toBe("none");
      await owner(
        "UPDATE quest_completion SET created_at = now() - interval '46 seconds' WHERE enrollment_id = $1",
        [who.enrollment],
      );
      expect(await refusal(scan(device, who.player, at.w))).toBe("none");
    });

    it("counts the screen QR and the kiosk apart on a quest with both (accepted in ADR-244)", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, { verification: ["screen_qr", "kiosk"], repeat: 10 });
      const device = await kiosk(event, quest);
      const who = await member(event);
      const at = await steadyWindow();
      await scan(device, who.player, at.w);
      expect(
        await refusal(
          query(
            as(who.player),
            "SELECT * FROM complete_quest($1, 'screen_qr', $2, NULL, $3, NULL)",
            [quest, at.w, randomUUID()],
          ),
        ),
      ).toBe("none");
    });

    it("replays a retry with the same key (no second kiosk_scan); the same key on another kiosk is its own", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const other = await newQuest(event);
      const device = await kiosk(event, quest);
      const otherKiosk = await kiosk(event, other);
      const who = await member(event);
      const at = await steadyWindow();
      const key = randomUUID();
      const first = await scan(device, who.player, at.w, key);
      const again = await scan(device, who.player, at.w, key.toUpperCase());
      expect(again).toMatchObject({ completion_id: first?.completion_id, replayed: true });
      expect(await kioskScans(first?.completion_id)).toHaveLength(1);
      const elsewhere = await scan(otherKiosk, who.player, at.w, key);
      expect(elsewhere?.replayed).toBe(false);
      expect(elsewhere?.completion_id).not.toBe(first?.completion_id);
    });

    it("pays a boost in force ×2 and says so, on a replay too (CTO note 3)", async () => {
      const event = await newEvent();
      const category = await newCategory(event);
      const quest = await newQuest(event, { category });
      await owner(
        `INSERT INTO boost (organizer_id, event_id, category_id, starts_at, ends_at)
         VALUES ($1, $2, $3, now() - interval '5 minutes', now() + interval '30 minutes')`,
        [ids.orgA, event, category],
      );
      const device = await kiosk(event, quest);
      const who = await member(event);
      const at = await steadyWindow();
      const key = randomUUID();
      expect(await scan(device, who.player, at.w, key)).toMatchObject({
        points: "20",
        boosted: true,
      });
      expect(await scan(device, who.player, at.w, key)).toMatchObject({
        points: "20",
        boosted: true,
        replayed: true,
      });
    });

    it("never pays the operator who paired it (self_scan); another operator's code pays once they may play", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const op = await operator(event);
      const device = await kiosk(event, quest, { by: op.player });
      const at = await steadyWindow();
      expect(await refusal(scan(device, op.player, at.w))).toBe("OY409");
      const colleague = await operator(event, ["scan_quests"], "code");
      expect(await refusal(scan(device, colleague.player, at.w))).toBe("QP403");
      await owner("UPDATE staff_assignment SET can_play = true WHERE id = $1", [
        colleague.assignment,
      ]);
      expect(await refusal(scan(device, colleague.player, at.w))).toBe("none");
    });

    it("pauses when its operator loses scan_quests or the quest, and pays again when it comes back", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const other = await newQuest(event);
      const op = await operator(event);
      const device = await kiosk(event, quest, { by: op.player });
      const at = await steadyWindow();
      await owner("UPDATE staff_assignment SET abilities = '{show_rotating_qr}' WHERE id = $1", [
        op.assignment,
      ]);
      expect(await refusal(scan(device, (await member(event)).player, at.w))).toBe("DV403:paused");
      expect((await view(device))?.["shut"]).toBe("paused");
      await owner("UPDATE staff_assignment SET abilities = '{scan_quests}' WHERE id = $1", [
        op.assignment,
      ]);
      await owner(
        "INSERT INTO staff_assignment_quest (assignment_id, event_id, quest_id) VALUES ($1, $2, $3)",
        [op.assignment, event, other],
      );
      expect(await refusal(scan(device, (await member(event)).player, at.w))).toBe("DV403:paused");
      await owner(
        "INSERT INTO staff_assignment_quest (assignment_id, event_id, quest_id) VALUES ($1, $2, $3)",
        [op.assignment, event, quest],
      );
      expect(await refusal(scan(device, (await member(event)).player, at.w))).toBe("none");
    });

    it("refuses a revoked, ended, idle, unactivated kiosk, a station, a big screen and no device (DV401)", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, { verification: ["screen_qr", "kiosk"] });
      const who = await member(event);
      const at = await steadyWindow();
      const revoked = await kiosk(event, quest);
      await query(teamA(), "SELECT revoke_device($1, $2, $3)", [event, revoked, randomUUID()]);
      const idle = await kiosk(event, quest);
      await owner(
        "UPDATE paired_device SET last_seen_at = now() - interval '31 days' WHERE id = $1",
        [idle],
      );
      const waiting = await kiosk(event, quest, { activated: false });
      const station = await kiosk(event, quest, { kind: "station" });
      const screen = await kiosk(event, null, { kind: "screen" });
      for (const device of [revoked, idle, waiting, station, screen]) {
        expect(await refusal(scan(device, who.player, at.w)), device).toBe("DV401");
      }
      expect(
        await refusal(
          query(as(who.player), "SELECT * FROM kiosk_complete_quest($1, $2, $3)", [
            who.player,
            at.w,
            randomUUID(),
          ]),
        ),
      ).toBe("DV401");
      const ended = await newEvent();
      const late = await kiosk(ended, await newQuest(ended));
      const lateMember = await member(ended);
      await owner(
        "UPDATE event SET starts_at = now() - interval '3 days', ends_at = now() - interval '25 hours' WHERE id = $1",
        [ended],
      );
      expect(await refusal(scan(late, lateMember.player, at.w))).toBe("DV401");
    });

    it("pays a rehearsal account during rehearsal; after go-live the wipe runs first: refused, its kiosk_scan gone", async () => {
      const event = await newEvent("scheduled", "30 minutes", "1 day");
      counter += 1;
      await owner(
        "INSERT INTO event_rehearsal (event_id, organizer_id, code) VALUES ($1, $2, $3)",
        [
          event,
          ids.orgA,
          `${LETTERS[counter % 24]}${LETTERS[Math.floor(counter / 24) % 24]}KS-KSKK`,
        ],
      );
      const quest = await newQuest(event);
      const device = await kiosk(event, quest);
      const rehearsal = await member(event, "rehearsal");
      const at = await steadyWindow();
      const paid = await scan(device, rehearsal.player, at.w);
      expect(await kioskScans(paid?.completion_id)).toHaveLength(1);
      await owner(
        "UPDATE event SET status = 'live', starts_at = now() - interval '1 minute' WHERE id = $1",
        [event],
      );
      expect(await refusal(scan(device, rehearsal.player, at.w))).toBe("QC404");
      expect(await refusal(scan(device, (await member(event)).player, at.w))).toBe("none");
      expect(await kioskScans(paid?.completion_id)).toHaveLength(0);
    });
  });

  // ============================================================ the subject
  describe("who the kiosk names", () => {
    it("names only a player of the kiosk's own event, and only to a kiosk", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, { verification: ["screen_qr", "kiosk"] });
      const device = await kiosk(event, quest);
      const station = await kiosk(event, quest, { kind: "station" });
      const who = await member(event);
      const stranger = await member(await newEvent());
      expect(await subject(device, who.player)).toHaveLength(1);
      expect(await subject(device, stranger.player)).toEqual([]);
      expect(await subject(station, who.player)).toEqual([]);
      expect(await refusal(subject(randomUUID(), who.player))).toBe("DV401");
    });
  });

  // ============================================================ another organizer
  describe("cross-tenant", () => {
    it("a kiosk of organizer A neither pays nor names a player only in organizer B's event", async () => {
      const event = await newEvent();
      const device = await kiosk(event, await newQuest(event));
      counter += 1;
      const [theirs] = await owner<{ id: string }>(
        `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
         VALUES ($1, $2, 'Other Fest', 'live', now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
        [ids.orgB, `KSB${counter}`],
      );
      const [player] = await owner<{ id: string }>(
        "INSERT INTO player (username) VALUES ($1) RETURNING id",
        [`ksk_b_${counter}`],
      );
      await owner(
        "INSERT INTO enrollment (organizer_id, event_id, player_id, joined_via) VALUES ($1, $2, $3, 'code')",
        [ids.orgB, theirs?.id, player?.id],
      );
      const at = await steadyWindow();
      expect(await refusal(scan(device, player?.id ?? "", at.w))).toBe("QC404");
      expect(await subject(device, player?.id ?? "")).toEqual([]);
      expect(
        await owner("SELECT 1 FROM quest_completion WHERE event_id = $1", [theirs?.id]),
      ).toEqual([]);
      expect(
        await refusal(
          query({ organizerId: ids.orgB, staffUserId: ownerB }, "SELECT * FROM kiosk_scan"),
        ),
      ).toBe("42501");
    });
  });

  // ============================================================ the view and the lists
  describe("the kiosk's view and the lists", () => {
    it("reads the kiosk's shut reasons for the kiosk method (a quest without the screen QR is open)", async () => {
      const event = await newEvent();
      const cases: readonly [string, string | null, string][] = [
        ["open", null, "SELECT 1 WHERE $1::uuid IS NOT NULL"],
        ["method off", "method_off", "UPDATE quest SET verification = '{quest_qr}' WHERE id = $1"],
        ["hidden", "hidden", "UPDATE quest SET visible = false WHERE id = $1"],
        [
          "not started",
          "not_started",
          "UPDATE quest SET opens_at = now() + interval '1 hour' WHERE id = $1",
        ],
        [
          "ended",
          "ended",
          "UPDATE quest SET opens_at = now() - interval '2 hours', closes_at = now() - interval '1 hour' WHERE id = $1",
        ],
      ];
      for (const [name, shut, sql] of cases) {
        const quest = await newQuest(event);
        const device = await kiosk(event, quest);
        await owner(sql, [quest]);
        expect((await view(device))?.["shut"], name).toBe(shut);
      }
      const quest = await newQuest(event);
      const device = await kiosk(event, quest);
      await owner("UPDATE event SET ends_at = now() - interval '1 hour' WHERE id = $1", [event]);
      expect((await view(device))?.["shut"]).toBe("event_ended");
    });

    it("keeps a station's view on the screen QR", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, { verification: ["screen_qr", "kiosk"] });
      const station = await kiosk(event, quest, { kind: "station" });
      expect((await view(station))?.["shut"]).toBeNull();
      await owner("UPDATE quest SET verification = '{kiosk}' WHERE id = $1", [quest]);
      expect((await view(station))?.["shut"]).toBe("method_off");
    });

    it("counts a kiosk's scans in the last 24 hours; a station has none", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, { verification: ["screen_qr", "kiosk"] });
      const device = await kiosk(event, quest);
      await kiosk(event, quest, { kind: "station" });
      const at = await steadyWindow();
      await scan(device, (await member(event)).player, at.w);
      const old = await scan(device, (await member(event)).player, at.w);
      await owner(
        "UPDATE kiosk_scan SET created_at = now() - interval '25 hours' WHERE completion_id = $1",
        [old?.completion_id],
      );
      const [listed] = await query<{ devices: Row[] }>(
        teamA(),
        "SELECT event_devices($1) AS devices",
        [event],
      );
      const byKind = Object.fromEntries(
        (listed?.devices ?? []).map((d) => [d["kind"], d["scans"]]),
      );
      expect(byKind).toEqual({ kiosk: 1, station: null });
    });

    it("offers an operator the kiosk quests within scan_quests and their limit", async () => {
      const event = await newEvent();
      const kioskQuest = await newQuest(event);
      const both = await newQuest(event, { verification: ["screen_qr", "kiosk"] });
      await newQuest(event, { verification: ["quest_qr"] });
      const op = await operator(event);
      const listed = async () =>
        (
          await query<{ v: { quests: Row[]; kioskQuests: Row[] } }>(
            as(op.player),
            "SELECT operator_devices($1) AS v",
            [event],
          )
        )[0]?.v;
      expect(idsOf((await listed())?.kioskQuests)).toEqual([kioskQuest, both].toSorted());
      expect(idsOf((await listed())?.quests)).toEqual([both]);
      await owner(
        "INSERT INTO staff_assignment_quest (assignment_id, event_id, quest_id) VALUES ($1, $2, $3)",
        [op.assignment, event, kioskQuest],
      );
      expect(idsOf((await listed())?.kioskQuests)).toEqual([kioskQuest]);
      await owner("UPDATE staff_assignment SET abilities = '{show_rotating_qr}' WHERE id = $1", [
        op.assignment,
      ]);
      expect((await listed())?.kioskQuests).toEqual([]);
    });

    it("lets an operator with scan_quests pair a kiosk; one without it gets OA403", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const op = await operator(event, ["scan_quests"]);
      expect(await refusal(kiosk(event, quest, { by: op.player }))).toBe("none");
      const shower = await operator(event, ["show_rotating_qr"]);
      expect(await refusal(kiosk(event, quest, { by: shower.player }))).toBe("OA403");
      const printed = await newQuest(event, { verification: ["quest_qr"] });
      expect(await refusal(kiosk(event, printed))).toBe("DV409:not_kiosk");
    });
  });

  // ============================================================ cascades, erasure, flags
  describe("kiosk_scan's life", () => {
    it("a deleted device (its quest's delete) leaves the row; erasure keeps it", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const device = await kiosk(event, quest);
      const who = await member(event);
      const at = await steadyWindow();
      const paid = await scan(device, who.player, at.w);
      await owner("SELECT erase_rows($1, ARRAY[$2]::uuid[], $3)", [who.player, event, hash()]);
      expect(await kioskScans(paid?.completion_id)).toHaveLength(1);
      await owner("DELETE FROM paired_device WHERE id = $1", [device]);
      expect(await kioskScans(paid?.completion_id)).toMatchObject([{ device_id: null }]);
    });

    it("raises a burst for many kiosk scans and never a shared device across kiosk players", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const device = await kiosk(event, quest);
      const who = await member(event);
      const friend = await member(event);
      const at = await steadyWindow();
      await scan(device, friend.player, at.w);
      for (let i = 0; i < 10; i += 1) {
        await scan(device, who.player, at.w);
        await owner(
          `UPDATE quest_completion SET created_at = now() - interval '46 seconds'
           WHERE enrollment_id = $1 AND created_at > now() - interval '46 seconds'`,
          [who.enrollment],
        );
      }
      const flags = await owner<{ kind: string; enrollment_id: string }>(
        "SELECT kind, enrollment_id FROM flag WHERE event_id = $1",
        [event],
      );
      expect(flags).toEqual([{ kind: "burst", enrollment_id: who.enrollment }]);
    });
  });

  // ============================================================ crossed locks
  describe("crossed locks", () => {
    it("a revoke while a kiosk scans waits: paid before, refused after", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const device = await kiosk(event, quest);
      const at = await steadyWindow();
      const held = await hold(
        { deviceId: device },
        "SELECT * FROM kiosk_complete_quest($1, $2, $3)",
        [(await member(event)).player, at.w, randomUUID()],
      );
      const revoking = query(teamA(), "SELECT revoke_device($1, $2, $3)", [
        event,
        device,
        randomUUID(),
      ]);
      expect(await waitsOnLock("revoke_device")).toBe(true);
      held.release();
      expect(await held.done).toHaveLength(1);
      await revoking;
      expect(await refusal(scan(device, (await member(event)).player, at.w))).toBe("DV401");
    });

    it("a scan after a revoke began waits for it, then is refused", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const device = await kiosk(event, quest);
      const at = await steadyWindow();
      const held = await hold(teamA(), "SELECT revoke_device($1, $2, $3)", [
        event,
        device,
        randomUUID(),
      ]);
      const scanning = refusal(scan(device, (await member(event)).player, at.w));
      expect(await waitsOnLock("kiosk_complete_quest")).toBe(true);
      held.release();
      await held.done;
      expect(await scanning).toBe("DV401");
    });

    it("an operator removed while their kiosk scans: the removal waits, no deadlock; the kiosk is revoked", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const op = await operator(event);
      const device = await kiosk(event, quest, { by: op.player });
      const at = await steadyWindow();
      const held = await hold(
        { deviceId: device },
        "SELECT * FROM kiosk_complete_quest($1, $2, $3)",
        [(await member(event)).player, at.w, randomUUID()],
      );
      const remover = await ownerClient();
      try {
        const removing = remover.query("DELETE FROM staff_assignment WHERE id = $1", [
          op.assignment,
        ]);
        expect(await waitsOnLock("DELETE FROM staff_assignment")).toBe(true);
        held.release();
        expect(await held.done).toHaveLength(1);
        await removing;
      } finally {
        await remover.end();
      }
      expect(await refusal(scan(device, (await member(event)).player, at.w))).toBe("DV401");
    });

    it("a scan while the operator's removal is in flight waits for it, then is refused", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const op = await operator(event);
      const device = await kiosk(event, quest, { by: op.player });
      const at = await steadyWindow();
      const scanned = (await member(event)).player;
      const remover = await ownerClient();
      try {
        await remover.query("BEGIN");
        await remover.query("DELETE FROM staff_assignment WHERE id = $1", [op.assignment]);
        const scanning = refusal(scan(device, scanned, at.w));
        expect(await waitsOnLock("kiosk_complete_quest")).toBe(true);
        await remover.query("COMMIT");
        expect(await scanning).toBe("DV401");
      } finally {
        await remover.end();
      }
    });

    it("two kiosks of one quest scan one player at once: one pays, the other answers QD409", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, { repeat: 10 });
      const one = await kiosk(event, quest);
      const two = await kiosk(event, quest);
      const who = await member(event);
      const at = await steadyWindow();
      const held = await hold({ deviceId: one }, "SELECT * FROM kiosk_complete_quest($1, $2, $3)", [
        who.player,
        at.w,
        randomUUID(),
      ]);
      const second = refusal(scan(two, who.player, at.w));
      expect(await waitsOnLock("kiosk_complete_quest")).toBe(true);
      held.release();
      await held.done;
      expect(await second).toBe("QD409:10");
    });
  });
});
