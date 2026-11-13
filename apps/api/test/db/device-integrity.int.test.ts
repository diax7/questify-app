import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
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

/**
 * The device-integrity flag in the database (T-812, migration 0198): a failed check flags the install's accounts in
 * live events and their later scans, once per account and install; a pass raises nothing; nothing is ever refused; the
 * App Attest key doors keep a key to its install and its counter moving forward; erasure forgets both tables.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("device integrity (database)", () => {
  let db: TestDatabase;
  let pool: Pool;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let ownerA = "";
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new Pool({ connectionString: db.appUrl, max: 4 });
    ids = await seedTwoTenants(db.owner);
    ownerA = await addMember(db.owner, ids.orgA, "owner");
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
  const as = <T extends Row>(player: string, sql: string, values: unknown[] = []) =>
    run<T>({ playerId: player }, sql, values);

  const newEvent = async (status = "live"): Promise<string> => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Integrity Fest', $3, now() - interval '1 hour', now() + interval '2 days') RETURNING id`,
      [ids.orgA, `INTEG${counter}`, status],
    );
    await owner("INSERT INTO category (event_id, name_en) VALUES ($1, 'General')", [event?.id]);
    return event?.id ?? "";
  };
  const newQuest = async (event: string): Promise<string> =>
    (
      await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, visible, type_config)
         SELECT $1, id, 'scan_qr', 'Lion', 10, 100, true, '{}' FROM category WHERE event_id = $1 LIMIT 1 RETURNING id`,
        [event],
      )
    )[0]?.id ?? "";
  const newPlayer = async (): Promise<string> => {
    counter += 1;
    return (
      (
        await owner<{ id: string }>("INSERT INTO player (username) VALUES ($1) RETURNING id", [
          `integ_${counter}`,
        ])
      )[0]?.id ?? ""
    );
  };
  const enroll = async (event: string, player: string): Promise<string> =>
    (
      await owner<{ id: string }>(
        "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3) RETURNING id",
        [ids.orgA, event, player],
      )
    )[0]?.id ?? "";
  /** A completion row from an install, written directly (the triggers run as on every path). */
  const completion = (
    event: string,
    enrollment: string,
    quest: string,
    device: string | null,
    method = "qr",
  ) =>
    owner(
      `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                     idempotency_key, device_id)
       VALUES ($1, $2, $3, $4, (SELECT count(*) + 1 FROM quest_completion WHERE enrollment_id = $3 AND quest_id = $4),
               $5, $6, $7)`,
      [ids.orgA, event, enrollment, quest, method, randomUUID(), device],
    );
  const record = (player: string, install: string, passed: boolean, why: string[] = []) =>
    as(player, "SELECT record_device_check($1, 'android', $2, $3)", [install, passed, why]);
  const cases = (enrollment: string) =>
    owner<{ kind: string; status: string; device_id: string; evidence: Row }>(
      "SELECT kind, status, device_id, evidence FROM flag WHERE enrollment_id = $1 AND kind = 'device_integrity'",
      [enrollment],
    );

  it("flags every account that scanned from a failed install in a live event, and nothing else", async () => {
    const live = await newEvent();
    const ended = await newEvent("ended");
    const quest = await newQuest(live);
    const oldQuest = await newQuest(ended);
    const install = randomUUID();
    const [me, sibling, stranger] = [await newPlayer(), await newPlayer(), await newPlayer()];
    const mine = await enroll(live, me);
    const theirs = await enroll(live, sibling);
    const other = await enroll(live, stranger);
    const past = await enroll(ended, me);
    await completion(live, mine, quest, install);
    await completion(live, theirs, quest, install);
    await completion(live, other, quest, randomUUID());
    await completion(ended, past, oldQuest, install);

    await record(me, install, false, ["device", "app"]);

    for (const enrollment of [mine, theirs]) {
      const [flag] = await cases(enrollment);
      expect(flag).toMatchObject({ status: "open", device_id: install });
      expect(flag?.evidence).toMatchObject({ platform: "android", reasons: ["device", "app"] });
    }
    expect(await cases(other)).toEqual([]);
    expect(await cases(past)).toEqual([]);
    const [check] = await owner(
      "SELECT verdict, reasons, player_id FROM device_check WHERE install_id = $1",
      [install],
    );
    expect(check).toEqual({ verdict: "failed", reasons: ["device", "app"], player_id: me });
  });

  it("flags a later scan from a failed install once, never refuses it, and raises nothing for a pass", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const [me, clean] = [await newPlayer(), await newPlayer()];
    const mine = await enroll(event, me);
    const theirs = await enroll(event, clean);
    const bad = randomUUID();
    const good = randomUUID();
    await record(me, bad, false, ["device"]);
    await record(clean, good, true);
    expect(await cases(mine)).toEqual([]);

    await completion(event, mine, quest, bad);
    await completion(event, mine, quest, bad);
    await completion(event, theirs, quest, good);
    await completion(event, mine, quest, null);

    expect(await cases(mine)).toHaveLength(1);
    expect(await cases(theirs)).toEqual([]);
    const [{ n } = { n: 0 }] = await owner<{ n: number }>(
      "SELECT count(*)::int AS n FROM quest_completion WHERE enrollment_id = $1",
      [mine],
    );
    expect(n).toBe(3);
  });

  it("raises nothing for a manual award, and keeps a cleared case cleared", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const me = await newPlayer();
    const mine = await enroll(event, me);
    const bad = randomUUID();
    await record(me, bad, false, ["nonce"]);
    await completion(event, mine, quest, bad, "manual");
    expect(await cases(mine)).toEqual([]);

    await completion(event, mine, quest, bad);
    await owner(
      "UPDATE flag SET status = 'cleared', resolution = 'cleared', resolved_at = now() WHERE enrollment_id = $1",
      [mine],
    );
    await record(me, bad, false, ["device"]);
    await completion(event, mine, quest, bad);
    const flags = await cases(mine);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ status: "cleared", evidence: { reasons: ["nonce"] } });
  });

  it("keeps the case after a pass and records the newest verdict", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const me = await newPlayer();
    const mine = await enroll(event, me);
    const install = randomUUID();
    await completion(event, mine, quest, install);
    await record(me, install, false, ["device"]);
    await record(me, install, true);
    expect(await cases(mine)).toHaveLength(1);
    const [check] = await owner("SELECT verdict, reasons FROM device_check WHERE install_id = $1", [
      install,
    ]);
    expect(check).toEqual({ verdict: "passed", reasons: [] });
  });

  it("shows the case on the Flags page with its evidence", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const me = await newPlayer();
    const mine = await enroll(event, me);
    const install = randomUUID();
    await completion(event, mine, quest, install);
    await record(me, install, false, ["chain"]);
    const team: RequestContext = { organizerId: ids.orgA, staffUserId: ownerA };
    const [line] = await run<{ id: string; kind: string }>(
      team,
      "SELECT * FROM event_flags($1, true, NULL, 50)",
      [event],
    );
    expect(line?.kind).toBe("device_integrity");
    const [detail] = await run<{ evidence: Row[] }>(team, "SELECT * FROM flag_detail($1, $2)", [
      event,
      line?.id,
    ]);
    expect(detail?.evidence).toEqual([
      { platform: "android", reasons: ["chain"], checkedAt: expect.any(String) as unknown },
    ]);
  });

  it("refuses a seat that is not an active player, and a missing install", async () => {
    const me = await newPlayer();
    await expect(
      run({}, "SELECT record_device_check($1, 'ios', true, '{}')", [randomUUID()]),
    ).rejects.toMatchObject({
      code: "PN401",
    });
    await expect(
      as(me, "SELECT record_device_check(NULL, 'ios', true, '{}')"),
    ).rejects.toMatchObject({
      code: "DI400",
    });
    await expect(record(me, randomUUID(), false, ["Not A Code"])).rejects.toMatchObject({
      code: "23514",
    });
    const banned = await newPlayer();
    await owner("UPDATE player SET status = 'banned' WHERE id = $1", [banned]);
    await expect(record(banned, randomUUID(), true)).rejects.toMatchObject({ code: "PN401" });
  });

  it("keeps an App Attest key to its install and moves its counter forward only", async () => {
    const me = await newPlayer();
    const install = randomUUID();
    const key = randomBytes(32);
    const spki = randomBytes(91);
    const add = () =>
      as<{ added: boolean }>(me, "SELECT app_attest_key_add($1, $2, $3, false) AS added", [
        key,
        install,
        spki,
      ]);
    expect((await add())[0]?.added).toBe(true);
    expect((await add())[0]?.added).toBe(false);
    const lookup = (at: string) =>
      as<{ public_key: Buffer; sign_count: string }>(
        me,
        "SELECT * FROM app_attest_key_for($1, $2)",
        [key, at],
      );
    expect(await lookup(randomUUID())).toEqual([]);
    expect((await lookup(install))[0]).toEqual({ public_key: spki, sign_count: "0" });
    await as(me, "SELECT app_attest_key_count($1, $2, 5)", [key, install]);
    await as(me, "SELECT app_attest_key_count($1, $2, 3)", [key, install]);
    await as(me, "SELECT app_attest_key_count($1, $2, 9)", [key, randomUUID()]);
    expect((await lookup(install))[0]?.sign_count).toBe("5");
  });

  it("forgets the checks and keys an account sent when it becomes a tombstone", async () => {
    const me = await newPlayer();
    const other = await newPlayer();
    const install = randomUUID();
    await record(me, install, true);
    await record(other, randomUUID(), true);
    await as(me, "SELECT app_attest_key_add($1, $2, $3, true)", [
      randomBytes(32),
      install,
      randomBytes(91),
    ]);
    await owner("SELECT erase_rows($1, '{}', $2)", [me, randomBytes(32)]);
    const left = await owner<{ n: number }>(
      `SELECT (SELECT count(*) FROM device_check WHERE player_id = $1)
            + (SELECT count(*) FROM app_attest_key WHERE player_id = $1) AS n,
              (SELECT count(*) FROM device_check WHERE player_id = $2) AS kept`,
      [me, other],
    );
    expect(left[0]).toEqual({ n: "0", kept: "1" });
  });
});
