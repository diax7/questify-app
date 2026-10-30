import { randomBytes, randomUUID } from "node:crypto";
import { CHEERS_PER_MINUTE, CHEER_REACTIONS } from "@questify/shared";
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
type Reading = Readonly<{
  enabled: boolean;
  switch: boolean;
  platformOn: boolean;
  live: Readonly<{ startedAt: string; endsAt: string }> | null;
}>;
type Scene = Readonly<{ shut: string | null; cheers?: Row | null }>;
type Player = Readonly<{ player: string; enrollment: string }>;

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
const hash = (): Buffer => randomBytes(32);

/**
 * Cheers in the database (T-509, migration 0090, ADR-377): who starts and stops a moment and every refusal, what ends a
 * live moment at once (the stop, either switch, the add-on, the event's end), the player's cheer with its refusals and the
 * per-minute limit under a race, the screen's scene (counts and sequence numbers only, never a player) and the running
 * list that a live moment takes over.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("cheers (database)", () => {
  let db: TestDatabase;
  let pool: Pool;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let ownerA = "";
  let editorA = "";
  let ownerB = "";
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new Pool({ connectionString: db.appUrl, max: 12 });
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
  const team = (staff = ownerA, organizer = ids.orgA): RequestContext => ({
    organizerId: organizer,
    staffUserId: staff,
  });

  /** A live event of organizer A with the big-screen add-on (unless `addon` is false). */
  const newEvent = async (fields: Readonly<{ addon?: boolean }> = {}) => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Cheers Fest', 'live', now() - interval '2 hours', now() + interval '1 day') RETURNING id`,
      [ids.orgA, `CHR${counter}`],
    );
    if (fields.addon !== false) {
      await owner(
        "INSERT INTO event_entitlement (event_id, organizer_id, feature) VALUES ($1, $2, 'bigScreen')",
        [event?.id, ids.orgA],
      );
    }
    return event?.id ?? "";
  };
  const newPlayer = async (event: string, status = "active"): Promise<Player> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username, avatar) VALUES ($1, 'fox') RETURNING id",
      [`cheer_player_${counter}`],
    );
    await owner("INSERT INTO player_contact (player_id, email) VALUES ($1, $2)", [
      player?.id,
      `cheer${counter}@najd.sa`,
    ]);
    const [made] = await owner<{ id: string }>(
      "INSERT INTO enrollment (organizer_id, event_id, player_id, status) VALUES ($1, $2, $3, $4) RETURNING id",
      [ids.orgA, event, player?.id, status],
    );
    return { player: player?.id ?? "", enrollment: made?.id ?? "" };
  };
  const device = async (event: string, kind = "screen", quest: string | null = null) => {
    const pending = { secret: hash(), code: hash() };
    await query({}, "SELECT * FROM open_device_request($1, $2, $3, 'Chrome on Android')", [
      pending.secret,
      pending.code,
      kind,
    ]);
    const [claimed] = await query<{ id: string }>(
      team(),
      "SELECT team_claim_device($1, $2, $3, $4, 'Hall TV', $5) AS id",
      [pending.code, event, kind, quest, randomUUID()],
    );
    await query({}, "SELECT activate_device($1, $2)", [pending.secret, hash()]);
    return claimed?.id ?? "";
  };
  const read = async <T>(deviceId: string, fn: string): Promise<T> =>
    (await query<{ r: T }>({ deviceId }, `SELECT ${fn}() AS r`))[0]?.r as T;

  const reading = async (event: string, context = team()) =>
    (await query<{ r: Reading }>(context, "SELECT event_cheers($1) AS r", [event]))[0]
      ?.r as Reading;
  const start = async (event: string, minutes: number | null = 5, context = team()) =>
    (
      await query<{ r: Reading }>(context, "SELECT start_cheers_moment($1, $2, $3) AS r", [
        event,
        minutes,
        randomUUID(),
      ])
    )[0]?.r as Reading;
  const stop = async (event: string, context = team()) =>
    (
      await query<{ r: Reading }>(context, "SELECT stop_cheers_moment($1, $2) AS r", [
        event,
        randomUUID(),
      ])
    )[0]?.r as Reading;
  const cheer = (who: Player, event: string, reaction = "heart") =>
    query({ playerId: who.player }, "SELECT send_cheer($1, $2) AS r", [event, reaction]);
  const memberView = async (who: Player, event: string) =>
    (
      await query<{ r: Row | null }>({ playerId: who.player }, "SELECT member_cheers($1) AS r", [
        event,
      ])
    )[0]?.r ?? null;
  const scene = (screen: string) => read<Scene>(screen, "screen_cheers");
  const running = async (screen: string) => (await read<Row>(screen, "device_view"))["scenes"];
  const sentBy = async (who: Player) =>
    Number(
      (
        await owner<{ n: string }>("SELECT count(*) AS n FROM cheer WHERE enrollment_id = $1", [
          who.enrollment,
        ])
      )[0]?.n,
    );

  describe("starting and stopping a moment (FR-1841)", () => {
    it("starts for the owner, replaces the last moment with its cheers, stops, and audits both", async () => {
      const event = await newEvent();
      const fan = await newPlayer(event);
      expect((await reading(event)).live).toBeNull();
      const started = await start(event, 5);
      expect(started).toMatchObject({ enabled: true, switch: true, platformOn: true });
      const span = new Date(started.live?.endsAt ?? "").getTime() - Date.now();
      expect(span).toBeGreaterThan(4 * 60_000);
      expect(span).toBeLessThanOrEqual(5 * 60_000);
      await cheer(fan, event);
      expect(await sentBy(fan)).toBe(1);
      await start(event, 10);
      expect(await sentBy(fan)).toBe(0);
      expect((await reading(event, team(editorA))).live).not.toBeNull();
      expect((await stop(event)).live).toBeNull();
      expect((await stop(event)).live).toBeNull();
      const audit = await owner<{ action: string; after: Row | null; actor_id: string }>(
        "SELECT action, after, actor_id FROM audit_log WHERE event_id = $1 AND action LIKE 'cheers.%' ORDER BY id",
        [event],
      );
      expect(audit.map((row) => row.action)).toEqual([
        "cheers.start",
        "cheers.start",
        "cheers.stop",
      ]);
      expect(audit[0]?.after).toMatchObject({ minutes: 5 });
      expect(audit.every((row) => row.actor_id === ownerA)).toBe(true);
      expect(JSON.stringify(audit)).not.toContain(fan.player);
    });

    it("refuses an editor, another tenant, a missing add-on, bad lengths and an event that is not live", async () => {
      const event = await newEvent();
      expect(await refusal(start(event, 5, team(editorA)))).toBe("CH403");
      expect(await refusal(stop(event, team(editorA)))).toBe("CH403");
      expect(await refusal(start(event, 5, team(ownerB, ids.orgB)))).toBe("AN404");
      expect(await refusal(stop(event, team(ownerB, ids.orgB)))).toBe("AN404");
      expect(await refusal(reading(event, team(ownerB, ids.orgB)))).toBe("AN404");
      for (const minutes of [0, -1, 31, null]) {
        expect(await refusal(start(event, minutes)), String(minutes)).toBe("CH422:minutes");
      }
      expect(await refusal(start(await newEvent({ addon: false }), 5))).toBe("BS403");
      const waiting = await newEvent();
      await owner(
        "UPDATE event SET status = 'scheduled', starts_at = now() + interval '1 day', ends_at = now() + interval '2 days' WHERE id = $1",
        [waiting],
      );
      expect(await refusal(start(waiting, 5))).toBe("CH409:not_live");
      expect(await owner("SELECT 1 FROM cheers_moment WHERE event_id = $1", [event])).toEqual([]);
    });

    it("refuses to start while the event's own switch or the platform's is off", async () => {
      const event = await newEvent();
      await owner(
        `UPDATE event SET config = jsonb_build_object('features', jsonb_build_object('cheers', false)) WHERE id = $1`,
        [event],
      );
      expect(await refusal(start(event, 5))).toBe("CH409:cheers_off");
      expect(await reading(event)).toMatchObject({ switch: false, platformOn: true });
      await owner(`UPDATE event SET config = '{}' WHERE id = $1`, [event]);
      await owner(
        `INSERT INTO platform_setting (key, value) VALUES ('features', '{"cheers": {"enabled": false}}')
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      );
      try {
        expect(await refusal(start(event, 5))).toBe("CH409:cheers_off");
        expect(await reading(event)).toMatchObject({ switch: true, platformOn: false });
      } finally {
        await owner("DELETE FROM platform_setting WHERE key = 'features'");
      }
    });
  });

  describe("what ends a live moment at once", () => {
    it("ends with the stop, the time, either switch, the add-on and the event's end", async () => {
      const event = await newEvent();
      const fan = await newPlayer(event);
      const screen = await device(event);
      const live = async () => (await reading(event)).live !== null;
      const seen = async () => [
        await live(),
        (await memberView(fan, event)) !== null,
        (await scene(screen)).cheers != null,
      ];
      await start(event, 5);
      expect(await seen()).toEqual([true, true, true]);
      await owner(
        "UPDATE cheers_moment SET started_at = now() - interval '10 seconds', ends_at = now() - interval '1 second' WHERE event_id = $1",
        [event],
      );
      expect(await seen()).toEqual([false, false, false]);
      for (const [change, undo] of [
        [
          `UPDATE event SET config = jsonb_build_object('features', jsonb_build_object('cheers', false)) WHERE id = $1`,
          `UPDATE event SET config = '{}' WHERE id = $1`,
        ],
        [
          "DELETE FROM event_entitlement WHERE event_id = $1",
          `INSERT INTO event_entitlement (event_id, organizer_id, feature) VALUES ($1, '${ids.orgA}', 'bigScreen')`,
        ],
        [
          "UPDATE event SET status = 'ended', ends_at = now() - interval '1 minute' WHERE id = $1",
          "UPDATE event SET status = 'live', ends_at = now() + interval '1 day' WHERE id = $1",
        ],
      ] as const) {
        await start(event, 5);
        expect(await live()).toBe(true);
        await owner(change, [event]);
        expect(
          (await memberView(fan, event)) === null && (await scene(screen)).cheers == null,
          change,
        ).toBe(true);
        await owner(undo, [event]);
        expect(await live(), `${change} undone`).toBe(true);
      }
    });
  });

  describe("sending a cheer", () => {
    it("takes each of the five reactions from an active member while a moment is live", async () => {
      const event = await newEvent();
      const fan = await newPlayer(event);
      expect(await refusal(cheer(fan, event))).toBe("CH409:not_live");
      await start(event, 5);
      for (const reaction of CHEER_REACTIONS) {
        expect(await cheer(fan, event, reaction)).toEqual([{ r: { sent: true } }]);
      }
      expect(await sentBy(fan)).toBe(5);
      expect(await memberView(fan, event)).toHaveProperty("endsAt");
    });

    it("refuses a stranger, a removed member, a team seat, a device and an unknown reaction alike or plainly", async () => {
      const event = await newEvent();
      const other = await newEvent();
      const fan = await newPlayer(event);
      const stranger = await newPlayer(other);
      const removed = await newPlayer(event, "removed");
      await start(event, 5);
      for (const who of [stranger, removed]) {
        expect(await refusal(cheer(who, event))).toBe("CH404");
        expect(await memberView(who, event)).toBeNull();
      }
      expect(await refusal(query(team(), "SELECT send_cheer($1, 'heart')", [event]))).toBe("CH404");
      expect(
        await refusal(
          query({ deviceId: await device(event) }, "SELECT send_cheer($1, 'heart')", [event]),
        ),
      ).toBe("CH404");
      expect(await refusal(query({}, "SELECT send_cheer($1, 'heart')", [event]))).toBe("CH404");
      for (const reaction of ["", "Heart", "poop", "heart; DROP TABLE cheer"]) {
        expect(await refusal(cheer(fan, event, reaction)), reaction).toBe("CH422");
      }
      expect(
        await refusal(query({ playerId: fan.player }, "SELECT send_cheer($1, NULL)", [event])),
      ).toBe("CH422");
      expect(await sentBy(fan)).toBe(0);
    });

    it("stops at the per-minute limit with the seconds to wait, and frees a slot as the minute passes", async () => {
      const event = await newEvent();
      const fan = await newPlayer(event);
      const other = await newPlayer(event);
      await start(event, 30);
      for (let sent = 0; sent < CHEERS_PER_MINUTE; sent += 1) {
        await cheer(fan, event);
      }
      const over = await refusal(cheer(fan, event));
      expect(over).toMatch(/^CH429:([1-9]|[1-5][0-9]|60)$/);
      expect(await sentBy(fan)).toBe(CHEERS_PER_MINUTE);
      await cheer(other, event);
      await owner(
        "UPDATE cheer SET created_at = now() - interval '61 seconds' WHERE id = (SELECT min(id) FROM cheer WHERE enrollment_id = $1)",
        [fan.enrollment],
      );
      await cheer(fan, event);
      expect(await refusal(cheer(fan, event))).toMatch(/^CH429/);
      expect(await sentBy(fan)).toBe(CHEERS_PER_MINUTE + 1);
    });

    it("never lets taps at once pass the limit", async () => {
      const event = await newEvent();
      const fan = await newPlayer(event);
      await start(event, 30);
      const results = await Promise.all(
        Array.from({ length: CHEERS_PER_MINUTE + 12 }, () => refusal(cheer(fan, event))),
      );
      expect(results.filter((result) => result === "none")).toHaveLength(CHEERS_PER_MINUTE);
      expect(results.filter((result) => result.startsWith("CH429"))).toHaveLength(12);
      expect(await sentBy(fan)).toBe(CHEERS_PER_MINUTE);
    });

    it("keeps the five names and the limit the shared package shows", async () => {
      const [names] = await owner<{ names: string[]; limit: number }>(
        "SELECT cheers_reactions() AS names, cheers_per_minute() AS limit",
      );
      expect(names?.names).toEqual([...CHEER_REACTIONS]);
      expect(names?.limit).toBe(CHEERS_PER_MINUTE);
    });

    it("removes a player's cheers with the enrollment", async () => {
      const event = await newEvent();
      const fan = await newPlayer(event);
      await start(event, 5);
      await cheer(fan, event);
      await owner("DELETE FROM enrollment WHERE id = $1", [fan.enrollment]);
      expect(await owner("SELECT 1 FROM cheer WHERE event_id = $1", [event])).toEqual([]);
    });
  });

  describe("the big screen's scene", () => {
    it("is shut without the add-on, empty without a moment, and counts and numbers cheers while live", async () => {
      const event = await newEvent();
      const screen = await device(event);
      const fans = [await newPlayer(event), await newPlayer(event)];
      expect(await scene(screen)).toEqual({ shut: null, cheers: null });
      await start(event, 5);
      await cheer(fans[0] as Player, event, "heart");
      await cheer(fans[0] as Player, event, "heart");
      await cheer(fans[1] as Player, event, "fire");
      const live = (await scene(screen)).cheers as {
        endsAt: string;
        totals: Record<string, number>;
        recent: { seq: number; reaction: string }[];
      };
      expect(live.totals).toEqual({ heart: 2, applause: 0, fire: 1, star: 0, party: 0 });
      expect(live.recent.map((entry) => entry.reaction)).toEqual(["heart", "heart", "fire"]);
      const seqs = live.recent.map((entry) => entry.seq);
      expect(seqs).toEqual(seqs.toSorted((a, b) => a - b));
      expect(Object.keys(live).toSorted()).toEqual(["endsAt", "recent", "totals"]);
      expect(Object.keys(live.recent[0] ?? {}).toSorted()).toEqual(["reaction", "seq"]);
      expect(JSON.stringify(live)).not.toContain(fans[0]?.player);
      await owner("DELETE FROM event_entitlement WHERE event_id = $1", [event]);
      expect(await scene(screen)).toEqual({ shut: "feature_off" });
    });

    it("sends only the newest 40 cheers, in order, while the totals count them all", async () => {
      const event = await newEvent();
      const screen = await device(event);
      const fan = await newPlayer(event);
      await start(event, 5);
      await owner(
        `INSERT INTO cheer (organizer_id, event_id, enrollment_id, reaction)
         SELECT $1, $2, $3, 'star' FROM generate_series(1, 55)`,
        [ids.orgA, event, fan.enrollment],
      );
      const live = (await scene(screen)).cheers as {
        totals: Record<string, number>;
        recent: { seq: number }[];
      };
      expect(live.totals["star"]).toBe(55);
      expect(live.recent).toHaveLength(40);
      const seqs = live.recent.map((entry) => entry.seq);
      expect(seqs).toEqual(seqs.toSorted((a, b) => a - b));
      expect(seqs[39]).toBe(
        Number((await owner<{ m: string }>("SELECT max(id) AS m FROM cheer"))[0]?.m),
      );
    });

    it("counts and reads a busy moment from the covering index alone", async () => {
      const event = await newEvent();
      const fan = await newPlayer(event);
      await owner(
        `INSERT INTO cheer (organizer_id, event_id, enrollment_id, reaction)
         SELECT $1, $2, $3, 'fire' FROM generate_series(1, 300)`,
        [ids.orgA, event, fan.enrollment],
      );
      await owner("VACUUM ANALYZE cheer");
      const reads = [
        "SELECT c.reaction, count(*) FROM cheer c WHERE c.event_id = $1 GROUP BY c.reaction",
        "SELECT c.id, c.reaction FROM cheer c WHERE c.event_id = $1 ORDER BY c.id DESC LIMIT 40",
      ];
      await owner("BEGIN");
      try {
        await owner("SET LOCAL enable_seqscan = off");
        for (const sql of reads) {
          const plan = await owner<Row>(`EXPLAIN ${sql}`, [event]);
          expect(plan.map((line) => String(line["QUERY PLAN"])).join(" "), sql).toContain(
            "Index Only Scan using cheer_by_event",
          );
        }
      } finally {
        await owner("ROLLBACK");
      }
    });

    it("runs alone while a moment is live and gives the screen back when it stops", async () => {
      const event = await newEvent();
      const screen = await device(event);
      const before = await running(screen);
      expect(before).not.toEqual(["cheers"]);
      await start(event, 5);
      expect(await running(screen)).toEqual(["cheers"]);
      await stop(event);
      expect(await running(screen)).toEqual(before);
    });

    it("answers a station, an unknown device and no device with the device refusal", async () => {
      const event = await newEvent();
      const [quest] = await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, verification)
         SELECT $1, c.id, 'scan_qr', 'Gate', 10, ARRAY['screen_qr', 'kiosk'] FROM category c
         WHERE c.event_id = $1 LIMIT 1 RETURNING id`,
        [event],
      );
      const station = await device(event, "station", quest?.id ?? null);
      await start(event, 5);
      expect(await refusal(read(station, "screen_cheers"))).toBe("DV401");
      expect(await refusal(read(randomUUID(), "screen_cheers"))).toBe("DV401");
      expect(await refusal(query({}, "SELECT screen_cheers()"))).toBe("DV401");
    });

    it("never shows another event's cheers", async () => {
      const event = await newEvent();
      const other = await newEvent();
      const screen = await device(event);
      const fan = await newPlayer(other);
      await start(other, 5);
      await cheer(fan, other);
      expect(await scene(screen)).toEqual({ shut: null, cheers: null });
    });
  });
});
