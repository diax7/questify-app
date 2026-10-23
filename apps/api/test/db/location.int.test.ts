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
type Paid = { completion_id: string; points: string; replayed: boolean };
type Line = Record<string, unknown>;

const refusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
    return "none";
  } catch (error) {
    const pg = error as { code?: string; detail?: string; hint?: string };
    const hint = pg.hint === undefined ? "" : `:${pg.hint}`;
    return pg.detail === undefined || pg.detail === "" || !String(pg.code).startsWith("Q")
      ? `${pg.code}`
      : `${pg.code}:${pg.detail}${hint}`;
  }
};

const as = (player: string): RequestContext => ({ playerId: player });
/** The spot: Riyadh. 0.001 of a degree of latitude is about 111 m. */
const SPOT = { lat: 24.7136, lng: 46.6753 };
const north = (metres: number) => SPOT.lat + metres / 111_195;
const at = (metres: number, extra: object = {}) => ({
  lat: north(metres),
  lng: SPOT.lng,
  accuracyM: 10,
  ageS: 5,
  ...extra,
});

/**
 * Location check-in quests and the location flags in the database (T-303b, migration 0048, ADR-206, ADR-207): the
 * check-in's verdicts, the QR fallback, a bad reading that never blocks a scan, what is kept (no coordinates), the far
 * and speed flags, flag_detail's lines, erasure and the rehearsal wipe, the refresh rule and the closed doors.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("location quests (database)", () => {
  let db: TestDatabase;
  let pool: Pool;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let ownerA = "";
  let ownerB = "";
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new Pool({ connectionString: db.appUrl, max: 6 });
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

  const newEvent = async (
    options: Readonly<{ status?: string; kind?: string; venue?: boolean }> = {},
  ): Promise<string> => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, kind, starts_at, ends_at, venue_lat, venue_lng)
       VALUES ($1, $2, 'Quest Fest', $3, $4, now() - interval '1 hour', now() + interval '1 day', $5, $6)
       RETURNING id`,
      [
        ids.orgA,
        `LOC${counter}`,
        options.status ?? "live",
        options.kind ?? "physical",
        options.venue === false ? null : SPOT.lat,
        options.venue === false ? null : SPOT.lng,
      ],
    );
    return event?.id ?? "";
  };
  const newCategory = async (event: string, refresh = "none") =>
    (
      await owner<{ id: string }>(
        "INSERT INTO category (event_id, name_en, refresh) VALUES ($1, 'General', $2) RETURNING id",
        [event, refresh],
      )
    )[0]?.id ?? "";
  const newQuest = async (
    event: string,
    type: string,
    place: Readonly<{ north: number; radius: number }> | null = { north: 0, radius: 50 },
    options: Readonly<{ category?: string; repeatCap?: number; config?: object }> = {},
  ) => {
    const category = options.category ?? (await newCategory(event));
    const [quest] = await owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, type_config, place_lat,
                          place_lng, place_radius_m)
       VALUES ($1, $2, $3, 'Visit', 10, $4, $5, $6, $7, $8) RETURNING id`,
      [
        event,
        category,
        type,
        options.repeatCap ?? 1,
        JSON.stringify(options.config ?? {}),
        place === null ? null : north(place.north),
        place === null ? null : SPOT.lng,
        place?.radius ?? null,
      ],
    );
    return quest?.id ?? "";
  };
  const member = async (event: string, via = "code") => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`loc_player_${counter}`],
    );
    const [made] = await owner<{ id: string }>(
      "INSERT INTO enrollment (organizer_id, event_id, player_id, joined_via) VALUES ($1, $2, $3, $4) RETURNING id",
      [ids.orgA, event, player?.id, via],
    );
    return { player: player?.id ?? "", enrollment: made?.id ?? "" };
  };
  const complete = async (
    player: string,
    quest: string,
    method: string,
    reading: unknown,
    options: Readonly<{ key?: string; code?: string | null }> = {},
  ) =>
    (
      await query<Paid>(as(player), "SELECT * FROM complete_quest($1, $2, $3, $4, $5, NULL, $6)", [
        quest,
        method,
        method === "qr" ? 1 : null,
        options.code ?? null,
        options.key ?? randomUUID(),
        reading === undefined ? null : JSON.stringify(reading),
      ])
    )[0] as Paid;
  const checkIn = (player: string, quest: string, reading: unknown, key?: string) =>
    complete(player, quest, "location", reading, key === undefined ? {} : { key });
  const positions = (enrollment: string) =>
    owner(
      `SELECT p.accuracy_m, p.mocked, p.venue_distance_m FROM completion_position p
       WHERE p.enrollment_id = $1 ORDER BY p.completion_id`,
      [enrollment],
    );
  const flags = (enrollment: string) =>
    owner<{ kind: string; evidence: { completions: number[] } }>(
      "SELECT kind, evidence FROM flag WHERE enrollment_id = $1 ORDER BY id",
      [enrollment],
    );
  const backdate = (enrollment: string, seconds: number) =>
    owner(
      "UPDATE quest_completion SET created_at = created_at - make_interval(secs => $2) WHERE enrollment_id = $1",
      [enrollment, seconds],
    );

  const pair = async (gapMetres: number, seconds: number, kind = "physical") => {
    const event = await newEvent({ kind });
    const gate = await newQuest(event, "scan_qr", { north: 0, radius: 50 });
    const hall = await newQuest(event, "scan_qr", { north: gapMetres + 100, radius: 50 });
    const { player, enrollment } = await member(event);
    const first = await complete(player, gate, "qr", undefined);
    await backdate(enrollment, seconds);
    const second = await complete(player, hall, "qr", undefined);
    return { event, enrollment, first, second, hall, gate, player };
  };

  const setting = async (name: string) =>
    (await owner<{ value: string }>(`SELECT current_setting('${name}') AS value`))[0]?.value;

  describe("checking in (FR-215, FR-216)", () => {
    it("pays a check-in inside the area once, keeping only rounded distances, accuracy and the mocked mark", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, "location");
      const { player, enrollment } = await member(event);
      expect(await checkIn(player, quest, at(30))).toMatchObject({ points: "10", replayed: false });
      expect(await positions(enrollment)).toEqual([
        { accuracy_m: 10, mocked: false, venue_distance_m: 30 },
      ]);
      expect(await refusal(checkIn(player, quest, at(0)))).toBe("QD409:1");
      expect(
        await owner("SELECT method FROM quest_completion WHERE enrollment_id = $1", [enrollment]),
      ).toEqual([{ method: "location" }]);
    });

    it("answers not_here with the rounded distance, and writes nothing", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, "location");
      const { player, enrollment } = await member(event);
      expect(await refusal(checkIn(player, quest, at(143)))).toBe("QV422:not_here:140");
      expect(
        await owner("SELECT 1 FROM quest_completion WHERE enrollment_id = $1", [enrollment]),
      ).toEqual([]);
      expect(await positions(enrollment)).toEqual([]);
    });

    it("allows the reported accuracy, capped at the radius, so a coarse fix never passes a far player", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, "location");
      const near = await member(event);
      expect(await checkIn(near.player, quest, at(90, { accuracyM: 45 }))).toMatchObject({
        points: "10",
      });
      const far = await member(event);
      expect(await refusal(checkIn(far.player, quest, at(120, { accuracyM: 400 })))).toBe(
        "QV422:not_here:120",
      );
      const edge = await member(event);
      expect(await checkIn(edge.player, quest, at(98, { accuracyM: 400 }))).toMatchObject({
        points: "10",
      });
    });

    it("refuses a missing, malformed, stale or imprecise reading for a check-in only", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, "location");
      const { player } = await member(event);
      expect(await refusal(checkIn(player, quest, undefined))).toBe("QV422:no_position");
      for (const bad of [
        "here",
        [1, 2],
        { lat: north(0), lng: SPOT.lng, accuracyM: 10 },
        at(0, { extra: 1 }),
        at(0, { lat: "24.7" }),
        at(0, { lat: 91 }),
        at(0, { lng: -181 }),
        at(0, { accuracyM: 0 }),
        at(0, { accuracyM: 10_001 }),
        at(0, { ageS: -1 }),
        at(0, { ageS: 86_401 }),
        at(0, { mocked: "yes" }),
      ]) {
        expect(await refusal(checkIn(player, quest, bad)), JSON.stringify(bad)).toBe(
          "QV422:bad_position",
        );
      }
      // A number too large for a double reads as a bad shape, never an overflow error.
      expect(
        await owner(
          `SELECT lat FROM position_of('{"lat": 1e400, "lng": 1, "accuracyM": 1, "ageS": 1}'::jsonb)`,
        ),
      ).toEqual([{ lat: null }]);
      expect(await refusal(checkIn(player, quest, at(0, { ageS: 121 })))).toBe("QV422:stale");
      expect(await refusal(checkIn(player, quest, at(0, { accuracyM: 501 })))).toBe(
        "QV422:imprecise",
      );
      expect(await checkIn(player, quest, at(0, { ageS: 120, accuracyM: 500 }))).toMatchObject({
        points: "10",
      });
    });

    it("completes the same quest by its QR with no reading (FR-216), and keeps a scan's usable reading", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, "location", { north: 0, radius: 50 }, { repeatCap: 3 });
      const { player, enrollment } = await member(event);
      expect(await complete(player, quest, "qr", undefined)).toMatchObject({ points: "10" });
      expect(await complete(player, quest, "qr", at(2_000))).toMatchObject({ points: "10" });
      expect(await positions(enrollment)).toEqual([
        { accuracy_m: 10, mocked: false, venue_distance_m: 2000 },
      ]);
    });

    it("pays a QR scan and a typed code with a malformed or stale reading, storing no position", async () => {
      const event = await newEvent();
      const scan = await newQuest(event, "scan_qr", null, { repeatCap: 5 });
      const code = await newQuest(event, "enter_code", null, {
        repeatCap: 5,
        config: { code: "SPOT1" },
      });
      const { player, enrollment } = await member(event);
      for (const reading of [at(0, { ageS: 500 }), at(0, { lat: 300 }), "junk", { a: 1 }]) {
        expect(await complete(player, scan, "qr", reading)).toMatchObject({ points: "10" });
        expect(await complete(player, code, "code", reading, { code: "SPOT1" })).toMatchObject({
          points: "10",
        });
      }
      expect(await positions(enrollment)).toEqual([]);
    });

    it("refuses a check-in on a scan quest and a location proof's QR checks stay", async () => {
      const event = await newEvent();
      const scan = await newQuest(event, "scan_qr", null);
      const { player } = await member(event);
      expect(await refusal(checkIn(player, scan, at(0)))).toBe("QV422:wrong_method");
      const quest = await newQuest(event, "location");
      expect(await refusal(complete(player, quest, "code", at(0), { code: "X" }))).toBe(
        "QV422:wrong_method",
      );
    });

    it("answers a replay with the first completion, ignoring a new reading", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, "location");
      const { player, enrollment } = await member(event);
      const key = randomUUID();
      const first = await checkIn(player, quest, at(10), key);
      expect(await checkIn(player, quest, at(5_000), key)).toMatchObject({
        completion_id: first.completion_id,
        replayed: true,
      });
      expect(await positions(enrollment)).toHaveLength(1);
    });

    it("binds check-ins to the period cap and category gates, and gives the quest's item on the first one", async () => {
      const event = await newEvent();
      const daily = await newCategory(event, "daily");
      const quest = await newQuest(
        event,
        "location",
        { north: 0, radius: 50 },
        { category: daily },
      );
      const { player, enrollment } = await member(event);
      await checkIn(player, quest, at(0));
      expect(await refusal(checkIn(player, quest, at(0)))).toBe("QD409:1");
      const later = await newEvent();
      await owner("UPDATE event SET desk_location_en = 'Gate A' WHERE id = $1", [later]);
      const [item] = await owner<{ id: string }>(
        "INSERT INTO quest_item (event_id, name_en, stock_total) VALUES ($1, 'Badge', 5) RETURNING id",
        [later],
      );
      const gated = await newQuest(later, "location");
      await owner("UPDATE quest SET item_id = $2 WHERE id = $1", [gated, item?.id]);
      await owner(
        "UPDATE category SET opens_at = now() + interval '1 hour' WHERE id = (SELECT category_id FROM quest WHERE id = $1)",
        [gated],
      );
      const other = await member(later);
      expect(await refusal(checkIn(other.player, gated, at(0)))).toMatch(/^QN403/);
      await owner(
        "UPDATE category SET opens_at = NULL WHERE id = (SELECT category_id FROM quest WHERE id = $1)",
        [gated],
      );
      await checkIn(other.player, gated, at(0));
      expect(
        await owner("SELECT status FROM redemption WHERE enrollment_id = $1", [other.enrollment]),
      ).toEqual([{ status: "reserved" }]);
      expect(enrollment).not.toBe("");
    });
  });

  describe("the quest's shape", () => {
    it("requires a place on a location quest, allows one on spot types only, and checks its numbers", async () => {
      const event = await newEvent();
      expect(await refusal(newQuest(event, "location", null))).toBe("23514");
      expect(await refusal(newQuest(event, "enter_code", { north: 0, radius: 50 }))).toBe("23514");
      expect(await refusal(newQuest(event, "location", { north: 0, radius: 19 }))).toBe("23514");
      expect(await refusal(newQuest(event, "location", { north: 0, radius: 2001 }))).toBe("23514");
      for (const type of ["scan_qr", "challenge"]) {
        expect(await refusal(newQuest(event, type, { north: 0, radius: 20 }))).toBe("none");
      }
      const quest = await newQuest(event, "scan_qr", { north: 0, radius: 50 });
      expect(await refusal(owner("UPDATE quest SET place_lng = NULL WHERE id = $1", [quest]))).toBe(
        "23514",
      );
    });

    it("keeps the quest QR as a location quest's one method", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, "location");
      expect(await owner("SELECT verification FROM quest WHERE id = $1", [quest])).toEqual([
        { verification: ["quest_qr"] },
      ]);
      for (const methods of [["my_qr"], ["quest_qr", "my_qr"], []]) {
        expect(
          await refusal(
            owner("UPDATE quest SET verification = $2 WHERE id = $1", [quest, methods]),
          ),
        ).toBe("23514");
      }
    });

    it("lets a location quest sit in a refreshing category, still not a survey", async () => {
      const event = await newEvent();
      const daily = await newCategory(event, "daily");
      expect(
        await refusal(newQuest(event, "location", { north: 0, radius: 50 }, { category: daily })),
      ).toBe("none");
      const plain = await newCategory(event);
      await newQuest(event, "location", { north: 0, radius: 50 }, { category: plain });
      expect(
        await refusal(owner("UPDATE category SET refresh = 'daily' WHERE id = $1", [plain])),
      ).toBe("none");
      expect(
        await refusal(
          newQuest(event, "survey", null, {
            category: daily,
            config: { questions: [{ id: "a", text: { en: "?" }, kind: "rating", required: true }] },
          }),
        ),
      ).toBe("QT422:refresh");
    });

    it("checks the venue pin: both numbers or neither, and the radius bounds", async () => {
      const event = await newEvent();
      for (const sql of [
        "UPDATE event SET venue_lng = NULL WHERE id = $1",
        "UPDATE event SET venue_radius_m = 99 WHERE id = $1",
        "UPDATE event SET venue_radius_m = 20001 WHERE id = $1",
        "UPDATE event SET venue_lat = 91 WHERE id = $1",
      ]) {
        expect(await refusal(owner(sql, [event])), sql).toBe("23514");
      }
    });
  });

  describe("far from the venue (FR-331, FR-1744)", () => {
    it("raises beyond the radius plus the margin plus the accuracy, not within it", async () => {
      const event = await newEvent();
      const scan = await newQuest(event, "scan_qr", null, { repeatCap: 5 });
      const inside = await member(event);
      await complete(inside.player, scan, "qr", at(2_000, { accuracyM: 100 }));
      expect(await flags(inside.enrollment)).toEqual([]);
      const outside = await member(event);
      const paid = await complete(outside.player, scan, "qr", at(2_200, { accuracyM: 100 }));
      expect(await flags(outside.enrollment)).toEqual([
        { kind: "far_from_venue", evidence: { completions: [Number(paid.completion_id)] } },
      ]);
    });

    it("keeps one open case, merging the evidence", async () => {
      const event = await newEvent();
      const scan = await newQuest(event, "scan_qr", null, { repeatCap: 5 });
      const { player, enrollment } = await member(event);
      const one = await complete(player, scan, "qr", at(5_000));
      const two = await complete(player, scan, "qr", at(6_000));
      expect(await flags(enrollment)).toEqual([
        {
          kind: "far_from_venue",
          evidence: { completions: [Number(one.completion_id), Number(two.completion_id)] },
        },
      ]);
    });

    it("pays a mocked check-in inside the area and raises the case", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, "location");
      const { player, enrollment } = await member(event);
      expect(await checkIn(player, quest, at(0, { mocked: true }))).toMatchObject({ points: "10" });
      expect((await flags(enrollment)).map((flag) => flag.kind)).toEqual(["far_from_venue"]);
    });

    it("raises nothing with no reading, a stale one, no venue pin, in a virtual event or for a manual award", async () => {
      const event = await newEvent();
      const scan = await newQuest(event, "scan_qr", null, { repeatCap: 5 });
      const { player, enrollment } = await member(event);
      await complete(player, scan, "qr", undefined);
      await complete(player, scan, "qr", at(9_000, { ageS: 121 }));
      expect(await flags(enrollment)).toEqual([]);

      const unpinned = await newEvent({ venue: false });
      const unpinnedScan = await newQuest(unpinned, "scan_qr", null);
      const nowhere = await member(unpinned);
      await complete(nowhere.player, unpinnedScan, "qr", at(9_000));
      expect(await flags(nowhere.enrollment)).toEqual([]);
      expect(await positions(nowhere.enrollment)).toEqual([
        { accuracy_m: 10, mocked: false, venue_distance_m: null },
      ]);

      const online = await newEvent({ kind: "virtual" });
      const onlineScan = await newQuest(online, "scan_qr", null);
      const remote = await member(online);
      await complete(remote.player, onlineScan, "qr", at(9_000, { mocked: true }));
      expect(await flags(remote.enrollment)).toEqual([]);
      expect(await positions(remote.enrollment)).toEqual([]);

      const manual = await newQuest(event, "location");
      const awarded = await member(event);
      await query(teamA(), "SELECT * FROM staff_award($1, $2, $3, NULL, 'Was there', $4, $5)", [
        event,
        awarded.enrollment,
        manual,
        randomUUID(),
        randomUUID(),
      ]);
      expect(await flags(awarded.enrollment)).toEqual([]);
    });
  });

  describe("impossible speed (FR-332)", () => {
    it("raises for two placed quests 1 km apart 30 s apart, with both completions", async () => {
      const { enrollment, first, second } = await pair(1_000, 30);
      expect(await flags(enrollment)).toEqual([
        {
          kind: "impossible_speed",
          evidence: { completions: [Number(first.completion_id), Number(second.completion_id)] },
        },
      ]);
    });

    it("raises nothing for 1 km in 10 minutes, under the minimum gap, or in a virtual event", async () => {
      expect(await flags((await pair(1_000, 600)).enrollment)).toEqual([]);
      expect(await flags((await pair(290, 1)).enrollment)).toEqual([]);
      expect(await flags((await pair(1_000, 30, "virtual")).enrollment)).toEqual([]);
    });

    it("skips a manual award and counts an operator's station scan", async () => {
      const event = await newEvent();
      const gate = await newQuest(event, "challenge", { north: 0, radius: 50 });
      const hall = await newQuest(event, "scan_qr", { north: 1_100, radius: 50 });
      const far = await newQuest(event, "location", { north: 2_200, radius: 50 });
      const { player, enrollment } = await member(event);
      await query(teamA(), "SELECT * FROM staff_award($1, $2, $3, NULL, 'Done', $4, $5)", [
        event,
        enrollment,
        hall,
        randomUUID(),
        randomUUID(),
      ]);
      await backdate(enrollment, 30);
      await complete(player, far, "qr", undefined);
      expect(await flags(enrollment)).toEqual([]);

      const operator = await member(event);
      await owner(
        "INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities) VALUES ($1, $2, $3, '{scan_quests}')",
        [ids.orgA, event, operator.player],
      );
      await backdate(enrollment, 30);
      await query(as(operator.player), "SELECT * FROM operator_complete_quest($1, $2, 1, $3)", [
        gate,
        player,
        randomUUID(),
      ]);
      expect((await flags(enrollment)).map((flag) => flag.kind)).toEqual(["impossible_speed"]);
    });
  });

  describe("the team's view", () => {
    it("shows distances, gap and seconds in flag_detail, never a coordinate, NULL for the first", async () => {
      const event = await newEvent();
      const gate = await newQuest(event, "location", { north: 0, radius: 50 });
      const hall = await newQuest(event, "scan_qr", { north: 1_100, radius: 50 });
      const { player, enrollment } = await member(event);
      await checkIn(player, gate, at(0, { mocked: true, accuracyM: 12 }));
      await backdate(enrollment, 30);
      await complete(player, hall, "qr", undefined);
      const cases = await owner<{ id: string; kind: string }>(
        "SELECT id, kind FROM flag WHERE enrollment_id = $1 ORDER BY kind",
        [enrollment],
      );
      const speed = cases.find((line) => line.kind === "impossible_speed");
      const [detail] = await query<{ evidence: Line[] }>(
        teamA(),
        "SELECT evidence FROM flag_detail($1, $2)",
        [event, speed?.id],
      );
      expect(detail?.evidence).toMatchObject([
        { distanceM: 0, accuracyM: 12, mocked: true, gapM: null, seconds: null },
        { distanceM: null, accuracyM: null, mocked: null, gapM: 1000, seconds: 30 },
      ]);
      expect(JSON.stringify(detail)).not.toMatch(/24\.71|46\.67/);
      const [line] = await query<{ scans: number }>(
        teamA(),
        "SELECT scans FROM event_flags($1, true, NULL, 50) WHERE kind = 'impossible_speed'",
        [event],
      );
      expect(line?.scans).toBe(2);
    });

    it("sends a location quest's place to its players, and no other quest's", async () => {
      const event = await newEvent();
      await newQuest(event, "location", { north: 0, radius: 60 });
      await newQuest(event, "scan_qr", { north: 0, radius: 60 });
      const { player } = await member(event);
      const rows = await query<{ type: string; place_radius_m: number | null }>(
        as(player),
        "SELECT type, place_lat IS NOT NULL AS has_pin, place_radius_m FROM member_event_quests($1) ORDER BY type",
        [event],
      );
      expect(rows).toEqual([
        { type: "location", has_pin: true, place_radius_m: 60 },
        { type: "scan_qr", has_pin: false, place_radius_m: null },
      ]);
    });
  });

  describe("cleanup", () => {
    it("erases the player's position rows with the account", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, "location");
      const { player, enrollment } = await member(event);
      await checkIn(player, quest, at(0));
      await owner("SELECT erase_rows($1, $2, NULL)", [player, [enrollment]]);
      expect(await positions(enrollment)).toEqual([]);
      expect(
        await owner("SELECT 1 FROM quest_completion WHERE enrollment_id = $1", [enrollment]),
      ).toHaveLength(1);
    });

    it("wipes a rehearsal account's positions (with its completions) and its location flags", async () => {
      const event = await newEvent({ status: "draft" });
      await owner(
        "INSERT INTO event_rehearsal (event_id, organizer_id, code) VALUES ($1, $2, 'LCTN-REHR')",
        [event, ids.orgA],
      );
      const quest = await newQuest(event, "location");
      const { player, enrollment } = await member(event, "rehearsal");
      await checkIn(player, quest, at(0, { mocked: true }));
      await owner("SELECT wipe_rehearsal($1, 'go_live', $2)", [event, randomUUID()]);
      expect(await owner("SELECT 1 FROM completion_position WHERE event_id = $1", [event])).toEqual(
        [],
      );
      expect(await flags(enrollment)).toEqual([]);
    });
  });

  describe("every payer still pays after the signature change", () => {
    it("pays a scan, a code, a station scan and a manual award through record_completion", async () => {
      const event = await newEvent();
      const scan = await newQuest(event, "scan_qr", null);
      const code = await newQuest(event, "enter_code", null, { config: { code: "OK123" } });
      const challenge = await newQuest(event, "challenge", null);
      const manual = await newQuest(event, "scan_qr", null);
      const { player, enrollment } = await member(event);
      await complete(player, scan, "qr", undefined);
      await complete(player, code, "code", undefined, { code: "OK123" });
      const operator = await member(event);
      await owner(
        "INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities) VALUES ($1, $2, $3, '{scan_quests}')",
        [ids.orgA, event, operator.player],
      );
      await query(as(operator.player), "SELECT * FROM operator_complete_quest($1, $2, 1, $3)", [
        challenge,
        player,
        randomUUID(),
      ]);
      await query(teamA(), "SELECT * FROM staff_award($1, $2, $3, NULL, 'Yes', $4, $5)", [
        event,
        enrollment,
        manual,
        randomUUID(),
        randomUUID(),
      ]);
      expect(
        await owner("SELECT method FROM quest_completion WHERE enrollment_id = $1 ORDER BY id", [
          enrollment,
        ]),
      ).toEqual([{ method: "qr" }, { method: "code" }, { method: "my_qr" }, { method: "manual" }]);
    });
  });

  describe("closed doors and the log guard", () => {
    it("keeps the position table and the helpers away from the API role", async () => {
      const event = await newEvent();
      const { player } = await member(event);
      for (const sql of [
        "SELECT * FROM completion_position",
        "SELECT * FROM position_of('{}')",
        "SELECT distance_m(0, 0, 1, 1)",
        "SELECT rounded_m(1)",
        "SELECT * FROM location_tuning()",
        "SELECT check_in_check(NULL::quest, NULL)",
        "SELECT keep_position(1, NULL::enrollment, NULL)",
        "SELECT * FROM previous_placed(NULL::quest_completion)",
        "SELECT raise_speed_flag(NULL::quest_completion)",
        "SELECT place_gap_m(0, 0, 1, 0, 0, 1)",
        "SELECT raise_location_flag(NULL::quest_completion, 'burst', '[]')",
        "SELECT * FROM record_completion(gen_random_uuid(), gen_random_uuid(), 'qr', 1, NULL, 'k', NULL, NULL, NULL, NULL, NULL, NULL)",
      ]) {
        for (const context of [teamA(), as(player), { isAdmin: true } as RequestContext]) {
          expect(await refusal(query(context, sql)), sql).toBe("42501");
        }
      }
    });

    it("keeps another organizer from placing this event's quest or reading its flag", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, "scan_qr", null, { repeatCap: 2 });
      const { player, enrollment } = await member(event);
      await complete(player, quest, "qr", at(9_000));
      const teamB: RequestContext = { organizerId: ids.orgB, staffUserId: ownerB };
      expect(
        await query(
          teamB,
          "UPDATE quest SET place_lat = 1, place_lng = 1, place_radius_m = 50 WHERE id = $1 RETURNING id",
          [quest],
        ),
      ).toEqual([]);
      const [flag] = await owner<{ id: string }>("SELECT id FROM flag WHERE enrollment_id = $1", [
        enrollment,
      ]);
      expect(
        await refusal(query(teamB, "SELECT * FROM flag_detail($1, $2)", [event, flag?.id])),
      ).toBe("AN404");
    });

    it("runs a database that never writes bound parameters (a reading) to its log", async () => {
      expect(await setting("log_parameter_max_length_on_error")).toBe("0");
      const quiet =
        (await setting("log_statement")) === "none" &&
        (await setting("log_min_duration_statement")) === "-1";
      expect((await setting("log_parameter_max_length")) === "0" || quiet).toBe(true);
    });
  });
});
