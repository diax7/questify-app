import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pushFixture, sqlstate, type Claimed, type PushFixture } from "#test/support/push";
import { TEST_DATABASE_URL } from "#test/support/test-db";

/**
 * The push outbox in the database (T-501, migration 0076; plan § Review 3 and 4): the claim's system seat, its fairness
 * between notices, its re-checks and expiry, leases and late acknowledgements, the bulk acknowledgement and its
 * attempts, invalid tokens, the switch, and the claim's cost with a 65,000-row queue present.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("push sending (database)", () => {
  let f: PushFixture;
  beforeAll(async () => {
    f = await pushFixture();
  });
  afterAll(async () => {
    await f.close();
  });
  beforeEach(async () => {
    await f.switchPush(true);
    await f.drain();
  });

  /** `n` players with one device each and a personal notice each of `kind`; answers the notices. */
  const personalBatch = async (
    kind: string,
    n: number,
    device: Parameters<PushFixture["phone"]>[1] = {},
  ) => {
    const made: Array<
      Readonly<{ who: string; deviceId: string; family: string; notice: string | null }>
    > = [];
    for (let i = 0; i < n; i += 1) {
      const phone = await f.playerWithPhone(device);
      made.push({ ...phone, notice: await f.notice(kind, { player: phone.who }) });
    }
    await f.fanOut();
    return made;
  };

  /** `n` members of a new live event, each signed in on one iOS phone, written straight into the tables. */
  const crowd = async (n: number): Promise<string> => {
    const event = await f.newEvent({ phase: "live" });
    await f.owner(
      `WITH p AS (INSERT INTO player (username)
                  SELECT 'pm_' || $2 || '_' || g FROM generate_series(1, $3) g RETURNING id),
            r AS (INSERT INTO player_refresh (player_id, family, token_hash, expires_at)
                  SELECT id, gen_random_uuid(), sha256(convert_to(id::text, 'UTF8')), now() + interval '180 days'
                  FROM p RETURNING player_id, family),
            d AS (INSERT INTO push_device (player_id, family, platform, token, environment, language, app_version)
                  SELECT player_id, family, 'ios', md5(family::text) || md5(player_id::text), 'production', 'ar', '1'
                  FROM r RETURNING 1)
       INSERT INTO enrollment (organizer_id, event_id, player_id)
       SELECT e.organizer_id, e.id, p.id FROM p CROSS JOIN event e WHERE e.id = $1`,
      [event, randomUUID().slice(0, 8), n],
    );
    return event;
  };

  /** A fanned-out event notice to the first `rows` members of the crowd's event (by player), queued for APNs. */
  const bulkQueue = async (kind: string, event: string, rows: number) => {
    const [made] = await f.owner<{ id: string }>(
      `INSERT INTO notice (kind, organizer_id, event_id, audience, dedupe, expires_at, fanned_at)
       SELECT $1, organizer_id, id, 'event', $3, now() + interval '1 day', now() FROM event WHERE id = $2 RETURNING id`,
      [kind, event, randomUUID()],
    );
    await f.owner(
      `WITH c AS (INSERT INTO notification (notice_id, player_id, event_id)
                  SELECT $1, n.player_id, n.event_id FROM enrollment n WHERE n.event_id = $2
                  ORDER BY n.player_id LIMIT $3 RETURNING id, player_id)
       INSERT INTO push_send (notification_id, device_id, notice_id, target, priority, expires_at)
       SELECT c.id, d.id, $1, 'apns:production', 1, now() + interval '1 day'
       FROM c JOIN push_device d ON d.player_id = c.player_id`,
      [made?.id, event, rows],
    );
    return made?.id ?? "";
  };

  const acked = (
    rows: readonly Claimed[],
    outcome: string,
    extra: Partial<{ code: string; attempts: number }> = {},
  ) =>
    f.ack(
      rows.map((row) => ({
        id: row.send_id,
        lease: row.lease,
        outcome,
        code: extra.code ?? null,
        attempts: extra.attempts ?? row.attempts + 1,
      })),
    );

  describe("the claim", () => {
    it("runs in the system context only, under READ COMMITTED", async () => {
      const who = await f.newPlayer();
      for (const seat of [
        { playerId: who },
        f.team(),
        { isAdmin: true, staffUserId: f.ownerA },
        { deviceId: randomUUID() },
      ]) {
        expect(await sqlstate(f.claim(undefined, 200, seat))).toBe("PN403");
        for (const sql of [
          "SELECT push_fan_out()",
          "SELECT push_settle()",
          "SELECT push_ack('{1}', ARRAY[gen_random_uuid()], '{sent}', '{null}', '{1}')",
        ]) {
          expect(await sqlstate(f.run(seat, sql)), sql).toBe("PN403");
        }
      }
      const client = await f.pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
        expect(await sqlstate(client.query("SELECT * FROM push_claim('{fcm}', 1)"))).toBe("PN403");
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });

    it("takes only the targets asked for, priority before id, at most 200, with fresh leases", async () => {
      const personal = await f.kind();
      const eventKind = await f.kind({ class: "event" });
      const android = await f.playerWithPhone({ platform: "android" });
      const eventQueue = await bulkQueue(eventKind, await crowd(150), 150);
      const [made] = await personalBatch(personal, 1);
      const fcm = await f.notice(personal, { player: android.who });
      await f.fanOut();
      const first = await f.claim(["apns:production"], 500);
      expect(first).toHaveLength(101);
      expect(first[0]?.notification_id).toBe(
        (
          await f.owner<{ id: string }>("SELECT id FROM notification WHERE notice_id = $1", [
            made?.notice,
          ])
        )[0]?.id,
      );
      expect(first.slice(1).every((row) => row.priority === 1)).toBe(true);
      expect(new Set(first.map((row) => row.lease)).size).toBe(101);
      expect(first.every((row) => row.target === "apns:production")).toBe(true);
      expect((await f.sends(fcm)).map((row) => row.state)).toEqual(["queued"]);
      const second = await f.claim(["apns:production", "fcm"], 500);
      expect(second.map((row) => row.target).toSorted()).toEqual([
        ...Array(50).fill("apns:production"),
        "fcm",
      ]);
      expect(second[0]?.target).toBe("fcm");
      expect((await f.sends(eventQueue)).filter((row) => row.state === "queued")).toHaveLength(0);
    });

    it("a large notice then a 10-row notice: the first claim takes 100 and 10 (the 50,000-row case: perf/push-timing)", async () => {
      const kind = await f.kind({ class: "event" });
      const phone = await f.playerWithPhone();
      const big = await f.syntheticQueue(kind, 300, phone.deviceId);
      const small = await f.syntheticQueue(kind, 10, phone.deviceId);
      await f.claim(["apns:production"], 200);
      const picked = await f.owner<{ notice_id: string; n: number }>(
        `SELECT notice_id, count(*)::int AS n FROM push_send
         WHERE notice_id = ANY ($1) AND state <> 'queued' GROUP BY 1 ORDER BY 1`,
        [[big, small]],
      );
      expect(picked).toEqual([
        { notice_id: big, n: 100 },
        { notice_id: small, n: 10 },
      ]);
    });

    it("visits at most 200 notices per target, not the whole queue (code review MAJOR; timing: perf/push-timing)", async () => {
      const kind = await f.kind();
      await f.personalQueue(kind, 1000);
      const [heads] = await f.owner<{ n: number }>(
        "SELECT count(*)::int AS n FROM push_queue_heads('{apns:production,apns:sandbox,fcm}')",
      );
      expect(heads?.n).toBe(200);
      const claimed = await f.claim(["apns:production", "apns:sandbox", "fcm"], 200);
      expect(claimed).toHaveLength(200);
      expect(new Set(claimed.map((row) => row.notification_id)).size).toBe(200);
    });

    it("two claimers take disjoint rows", async () => {
      const kind = await f.kind();
      await f.personalQueue(kind, 60);
      const a = new Client({ connectionString: f.db.appUrl });
      const b = new Client({ connectionString: f.db.appUrl });
      await a.connect();
      await b.connect();
      try {
        await a.query("BEGIN");
        const first = (
          await a.query<{ send_id: string }>(
            "SELECT send_id FROM push_claim('{apns:production}', 40)",
          )
        ).rows;
        const second = (
          await b.query<{ send_id: string }>(
            "SELECT send_id FROM push_claim('{apns:production}', 40)",
          )
        ).rows;
        await a.query("COMMIT");
        expect(first).toHaveLength(40);
        expect(second).toHaveLength(20);
        expect(new Set([...first, ...second].map((row) => row.send_id)).size).toBe(60);
      } finally {
        await a.end();
        await b.end();
      }
    });

    it("a picked expired row becomes expired, not leased; settle expires the rest by index", async () => {
      const kind = await f.kind();
      const [one, two] = await personalBatch(kind, 2);
      await f.owner(
        "UPDATE push_send SET expires_at = now() - interval '1 second' WHERE notice_id = ANY ($1)",
        [[one?.notice, two?.notice]],
      );
      expect(await f.claim(["apns:production"], 1)).toEqual([]);
      const states = await f.owner<{ state: string }>(
        "SELECT state FROM push_send WHERE notice_id = ANY ($1) ORDER BY notice_id",
        [[one?.notice, two?.notice]],
      );
      expect(states.map((row) => row.state)).toEqual(["expired", "queued"]);
      await f.settle();
      expect((await f.sends(two?.notice)).map((row) => row.state)).toEqual(["expired"]);
    });

    it("skips with the reason: player, archived, device, not_member", async () => {
      const event = await f.newEvent({ phase: "live" });
      const personal = await f.kind();
      const eventKind = await f.kind({ class: "event" });
      const banned = await f.playerWithPhone();
      const bannedNotice = await f.notice(personal, { player: banned.who });
      const signedOut = await f.playerWithPhone();
      const outNotice = await f.notice(personal, { player: signedOut.who });
      const leaver = await f.playerWithPhone();
      await f.join(event, leaver.who);
      const leaverNotice = await f.notice(eventKind, { event });
      const archivedEvent = await f.newEvent({ phase: "live" });
      const archivedMember = await f.playerWithPhone();
      await f.join(archivedEvent, archivedMember.who);
      const archivedNotice = await f.notice(personal, {
        event: archivedEvent,
        player: archivedMember.who,
      });
      await f.fanOut();
      await f.owner("UPDATE player SET status = 'banned' WHERE id = $1", [banned.who]);
      await f.owner("SELECT revoke_family($1)", [signedOut.family]);
      await f.owner("UPDATE enrollment SET status = 'left' WHERE player_id = $1", [leaver.who]);
      await f.owner(
        "UPDATE event SET status = 'archived', ends_at = now() - interval '1 day' WHERE id = $1",
        [archivedEvent],
      );
      expect(await f.claim()).toEqual([]);
      const codes = async (id: string | null) =>
        (await f.sends(id)).map((row) => `${row.state}:${row.code}`);
      expect(await codes(bannedNotice)).toEqual(["skipped:player"]);
      expect(await codes(outNotice)).toEqual(["skipped:device"]);
      expect(await codes(leaverNotice)).toEqual(["skipped:not_member"]);
      expect(await codes(archivedNotice)).toEqual(["skipped:archived"]);
    });

    it("claims nothing with the switch off; the fan-out and settle go on", async () => {
      const kind = await f.kind();
      await f.switchPush(false);
      const [made] = await personalBatch(kind, 1);
      expect(await f.recipients(made?.notice ?? null)).toHaveLength(1);
      expect(await f.claim()).toEqual([]);
      expect((await f.sends(made?.notice)).map((row) => row.state)).toEqual(["queued"]);
      expect(await f.settle()).toMatchObject({ more: false });
      await f.switchPush(true);
      expect(await f.claim()).toHaveLength(1);
    });
  });

  describe("leases and the acknowledgement", () => {
    it("expires a lease to unknown, after which a late acknowledgement changes nothing", async () => {
      const kind = await f.kind();
      await personalBatch(kind, 1);
      const [row] = await f.claim();
      await f.owner(
        "UPDATE push_send SET lease_until = now() - interval '1 second' WHERE id = $1",
        [row?.send_id],
      );
      expect(await f.claim()).toEqual([]);
      expect(row === undefined ? -1 : await acked([row], "sent")).toBe(0);
      const [state] = await f.owner<{ state: string; code: string; lease_token: string | null }>(
        "SELECT state, code, lease_token FROM push_send WHERE id = $1",
        [row?.send_id],
      );
      expect(state).toEqual({ state: "unknown", code: "lease_expired", lease_token: null });
    });

    it("records each outcome with its attempts, never lowering them, a requeue going back to the queue", async () => {
      const kind = await f.kind();
      await personalBatch(kind, 5);
      const rows = (await f.claim()).toSorted((a, b) => Number(a.send_id) - Number(b.send_id));
      expect(rows).toHaveLength(5);
      const outcomes = ["sent", "unknown", "failed", "requeue", "requeue"];
      const changed = await f.ack(
        rows.map((row, i) => ({
          id: row.send_id,
          lease: row.lease,
          outcome: outcomes[i] ?? "sent",
          code: i === 4 ? "not a code!" : "500",
          attempts: i === 4 ? 0 : 3,
        })),
      );
      expect(changed).toBe(5);
      const after = await f.owner<{
        state: string;
        attempts: number;
        code: string | null;
        finished: boolean;
      }>(
        "SELECT state, attempts, code, finished_at IS NOT NULL AS finished FROM push_send WHERE id = ANY ($1) ORDER BY id",
        [rows.map((row) => row.send_id)],
      );
      expect(after).toEqual([
        { state: "sent", attempts: 3, code: "500", finished: true },
        { state: "unknown", attempts: 3, code: "500", finished: true },
        { state: "failed", attempts: 3, code: "500", finished: true },
        { state: "queued", attempts: 3, code: "500", finished: false },
        { state: "queued", attempts: 0, code: null, finished: false },
      ]);
      expect(await f.claim()).toHaveLength(2);
    });

    it("8 attempts: failed; a row claimed at 7 gets one try and is failed at 8 while the rest of its wave is acked as usual", async () => {
      const kind = await f.kind();
      await personalBatch(kind, 50);
      await f.owner(
        "UPDATE push_send SET attempts = 7 WHERE id = (SELECT min(id) FROM push_send WHERE state = 'queued')",
      );
      const wave = await f.claim(undefined, 50);
      expect(wave).toHaveLength(50);
      const seventh = wave.find((row) => row.attempts === 7);
      expect(seventh).toBeDefined();
      const changed = await f.ack(
        wave.map((row) =>
          row === seventh
            ? { id: row.send_id, lease: row.lease, outcome: "requeue", code: "503", attempts: 9 }
            : { id: row.send_id, lease: row.lease, outcome: "sent", attempts: row.attempts + 1 },
        ),
      );
      expect(changed).toBe(50);
      const states = await f.owner<{ state: string; code: string | null; n: number }>(
        "SELECT state, code, count(*)::int AS n FROM push_send WHERE id = ANY ($1) GROUP BY 1, 2 ORDER BY 1",
        [wave.map((row) => row.send_id)],
      );
      expect(states).toEqual([
        { state: "failed", code: "attempts", n: 1 },
        { state: "sent", code: null, n: 49 },
      ]);
      expect(
        (
          await f.owner<{ attempts: number }>("SELECT attempts FROM push_send WHERE id = $1", [
            seventh?.send_id,
          ])
        )[0],
      ).toEqual({ attempts: 8 });
    });

    it("keeps a token registered while the claim read the old one: the old token's invalid answer marks nothing", async () => {
      const kind = await f.kind();
      const [made] = await personalBatch(kind, 1);
      const [session] = await f.owner<{ token_hash: Buffer }>(
        "SELECT token_hash FROM player_session WHERE refresh_family = $1",
        [made?.family],
      );
      const fresh = "ab".repeat(32);
      const register = new Client({ connectionString: f.db.appUrl });
      await register.connect();
      try {
        // The registration begins (and stamps its time) before the claim, and commits after it.
        await register.query("BEGIN");
        await register.query("SELECT set_config('app.player_id', $1, true)", [made?.who]);
        await register.query(
          "SELECT push_device_register($1, 'ios', $2, 'production', 'ar', '1.0.0')",
          [session?.token_hash, fresh],
        );
        const claimed = await f.claim();
        expect(claimed.map((row) => row.token)).not.toContain(fresh);
        await register.query("COMMIT");
        await acked(claimed, "invalid", { code: "Unregistered" });
      } finally {
        await register.end();
      }
      const [device] = await f.owner<{
        token: string;
        invalid_at: Date | null;
        token_version: number;
      }>("SELECT token, invalid_at, token_version FROM push_device WHERE id = $1", [
        made?.deviceId,
      ]);
      expect(device).toEqual({ token: fresh, invalid_at: null, token_version: 2 });
    });

    it("refuses a malformed acknowledgement", async () => {
      expect(await sqlstate(f.ack([]))).toBe("PN422");
      expect(
        await sqlstate(f.ack([{ id: "1", lease: randomUUID(), outcome: "maybe", attempts: 1 }])),
      ).toBe("PN422");
      expect(
        await sqlstate(
          f.one(
            f.system,
            "SELECT push_ack('{1,2}', ARRAY[gen_random_uuid()], '{sent}', '{null}', '{1}') AS r",
          ),
        ),
      ).toBe("PN422");
    });

    it("an invalid answer marks the device, unless it registered a new token after the claim; 100 Unregistered mark 100 devices", async () => {
      const kind = await f.kind();
      const made = await personalBatch(kind, 3);
      const rows = await f.claim();
      const reRegistered = made[2];
      const sign =
        reRegistered === undefined
          ? undefined
          : {
              session: (
                await f.owner<{ token_hash: Buffer }>(
                  "SELECT token_hash FROM player_session WHERE refresh_family = $1",
                  [reRegistered.family],
                )
              )[0]?.token_hash,
            };
      await f.owner("SELECT pg_sleep(0.01)");
      await f.register(reRegistered?.who ?? "", sign?.session ?? Buffer.alloc(32), {});
      await acked(rows, "invalid", { code: "Unregistered" });
      const devices = await f.owner<{ id: string; invalid: string | null }>(
        "SELECT id, invalid_code AS invalid FROM push_device WHERE id = ANY ($1)",
        [made.map((one) => one.deviceId)],
      );
      const byId = new Map(devices.map((row) => [row.id, row.invalid]));
      expect(made.map((one) => byId.get(one.deviceId))).toEqual([
        "Unregistered",
        "Unregistered",
        null,
      ]);
      const states = await f.owner<{ state: string }>(
        "SELECT DISTINCT state FROM push_send WHERE id = ANY ($1)",
        [rows.map((row) => row.send_id)],
      );
      expect(states).toEqual([{ state: "failed" }]);
      const many = await personalBatch(kind, 100);
      const claimed = await f.claim();
      await acked(claimed, "invalid", { code: "Unregistered" });
      expect(
        await f.count("push_device WHERE id = ANY ($1) AND invalid_at IS NOT NULL", [
          many.map((one) => one.deviceId),
        ]),
      ).toBe(100);
      expect(await f.claim()).toEqual([]);
    });
  });
});
