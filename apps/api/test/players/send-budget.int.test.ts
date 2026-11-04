import { createHash } from "node:crypto";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "#src/db/migrate";
import { giveBack, reserveSend, type Held, type Reserved } from "#src/players/sign-in-limits";
import { setSendBudget } from "#test/support/send-budget";
import {
  TEST_DATABASE_URL,
  connectAsOwner,
  createTestDatabase,
  type TestDatabase,
} from "#test/support/test-db";

const STRIPES = 16;
const PREFIX = { phone: "questify.sms_platform.", email: "questify.player_email_platform." };
const BUCKET = { phone: "sms_platform", email: "player_email_platform" };
const stripeKey = (channel: "phone" | "email", i: number): Buffer =>
  createHash("sha256").update(`${PREFIX[channel]}${i}`).digest();
/** The share of stripe i (migration 0150), written out so the test does not borrow the function's arithmetic. */
const shareOf = (cap: number, i: number): number =>
  Math.floor(cap / STRIPES) + (i < cap % STRIPES ? 1 : 0);

/**
 * The platform send budget (T-804b, ADR-690, ADR-692): take_send_budget from the API role's seat, through the service's
 * own `reserveSend` (which retries `busy`), on the real PostgreSQL. Never overspent, never under-spent, sliding, busy
 * is not spent, a unit given back is free again, and the cap is data.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("the platform send budget", () => {
  let db: TestDatabase;
  let pool: Pool;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new Pool({ connectionString: db.appUrl, max: 40 });
  });
  afterAll(async () => {
    await pool.end();
    await db.close();
  });
  beforeEach(async () => {
    await db.owner.query(
      "DELETE FROM auth_throttle WHERE bucket IN ('sms_platform', 'player_email_platform')",
    );
    await setSendBudget(owner, "phone", 5000);
    await setSendBudget(owner, "email", 1000);
  });

  const owner = (sql: string, values: unknown[] = []) => db.owner.query(sql, values);
  const rowsIn = async (channel: "phone" | "email"): Promise<number> => {
    const { rows } = await db.owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM auth_throttle
       WHERE bucket = $1 AND key = ANY ($2) AND at > now() - interval '1 day'`,
      [BUCKET[channel], Array.from({ length: STRIPES }, (_x, i) => stripeKey(channel, i))],
    );
    return rows[0]?.n ?? 0;
  };
  const perStripe = async (channel: "phone" | "email"): Promise<number[]> => {
    const counts: number[] = [];
    for (let i = 0; i < STRIPES; i += 1) {
      const { rows } = await db.owner.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM auth_throttle WHERE bucket = $1 AND key = $2 AND at > now() - interval '1 hour'",
        [BUCKET[channel], stripeKey(channel, i)],
      );
      counts.push(rows[0]?.n ?? 0);
    }
    return counts;
  };
  const reserve = async (channel: "phone" | "email" = "phone"): Promise<Reserved> => {
    const client = await pool.connect();
    try {
      return await reserveSend(client, channel);
    } finally {
      client.release();
    }
  };
  /** Like the service, but asking again after a final `busy` too, until the function says taken or spent. */
  const reserveUntilAnswered = async (channel: "phone" | "email" = "phone"): Promise<Reserved> => {
    for (;;) {
      const answer = await reserve(channel);
      if (answer.kind !== "busy") {
        return answer;
      }
    }
  };
  const rush = async (calls: number, channel: "phone" | "email" = "phone") => {
    const answers = await Promise.all(
      Array.from({ length: calls }, () => reserveUntilAnswered(channel)),
    );
    return answers.filter((answer) => answer.kind === "held").length;
  };
  /** Inserts rows into stripe i directly as the owner, `ago` seconds back. */
  const seed = (channel: "phone" | "email", i: number, count: number, ago = 0) =>
    owner(
      `INSERT INTO auth_throttle (bucket, key, at)
       SELECT $1, $2, now() - make_interval(secs => $4) FROM generate_series(1, $3)`,
      [BUCKET[channel], stripeKey(channel, i), count, ago],
    );

  const stamp = async () =>
    (
      await db.owner.query<{ settling: boolean }>(
        "SELECT changed_at > now() - interval '1 minute' AS settling FROM platform_send_budget WHERE channel = 'email'",
      )
    ).rows[0]?.settling;

  it("never takes more than the cap from 40 connections at once, nor less, over 20 rounds", async () => {
    await setSendBudget(owner, "phone", 50);
    for (let round = 0; round < 20; round += 1) {
      await owner("DELETE FROM auth_throttle WHERE bucket = 'sms_platform'");
      expect(await rush(200)).toBe(50);
      expect(await rowsIn("phone")).toBe(50);
    }
    const stripes = await perStripe("phone");
    stripes.forEach((n, i) => expect(n, `stripe ${i}`).toBe(shareOf(50, i)));
  });

  it("keeps the exact cap when it does not divide by the stripes, is below them, or is 0", async () => {
    for (const cap of [37, 3, 1]) {
      await owner("DELETE FROM auth_throttle WHERE bucket = 'sms_platform'");
      await setSendBudget(owner, "phone", cap);
      expect(await rush(cap + 20), `cap ${cap}`).toBe(cap);
      expect(await rowsIn("phone")).toBe(cap);
    }
    await owner("DELETE FROM auth_throttle WHERE bucket = 'sms_platform'");
    await setSendBudget(owner, "phone", 0);
    expect(await reserve()).toEqual({ kind: "spent" });
    expect(await rowsIn("phone")).toBe(0);
  });

  it("slides: rows older than the window do not count, rows inside it do, per stripe", async () => {
    await setSendBudget(owner, "phone", 32);
    for (let i = 0; i < STRIPES; i += 1) {
      await seed("phone", i, 2, 3601);
    }
    expect(await rush(40)).toBe(32);
    await owner("DELETE FROM auth_throttle WHERE bucket = 'sms_platform'");
    await seed("phone", 5, 2, 3500);
    expect(await rush(40)).toBe(30);
    expect((await perStripe("phone"))[5]).toBe(2);
  });

  it("answers busy, taking nothing, while another session holds every stripe; then takes", async () => {
    const holder = await connectAsOwner(db);
    try {
      await holder.query("BEGIN");
      for (let i = 0; i < STRIPES; i += 1) {
        await holder.query("SELECT pg_advisory_xact_lock($1::bigint)", [
          stripeKey("phone", i).readBigInt64BE(0).toString(),
        ]);
      }
      expect(await reserve()).toEqual({ kind: "busy" });
      expect(await rowsIn("phone")).toBe(0);
      await holder.query("ROLLBACK");
      expect((await reserve()).kind).toBe("held");
    } finally {
      await holder.end();
    }
  });

  it("answers spent, not busy, when the only stripes with room are free and the others are full", async () => {
    await setSendBudget(owner, "phone", 16);
    for (let i = 0; i < STRIPES; i += 1) {
      await seed("phone", i, 1);
    }
    expect(await reserve()).toEqual({ kind: "spent" });
  });

  it("answers spent, not busy, while another session holds the lock of every full stripe", async () => {
    await setSendBudget(owner, "phone", 16);
    for (let i = 0; i < STRIPES; i += 1) {
      await seed("phone", i, 1);
    }
    const holder = await connectAsOwner(db);
    try {
      await holder.query("BEGIN");
      for (let i = 0; i < STRIPES; i += 1) {
        await holder.query("SELECT pg_advisory_xact_lock($1::bigint)", [
          stripeKey("phone", i).readBigInt64BE(0).toString(),
        ]);
      }
      expect(await reserve()).toEqual({ kind: "spent" });
      expect(await rowsIn("phone")).toBe(16);
    } finally {
      await holder.end();
    }
  });

  it("frees exactly one unit when one is given back; an unknown time gives back nothing", async () => {
    await setSendBudget(owner, "phone", 50);
    const held: Held[] = [];
    for (let n = 0; n < 50; n += 1) {
      const answer = await reserve();
      if (answer.kind === "held") {
        held.push(answer);
      }
    }
    expect(held).toHaveLength(50);
    expect(await reserve()).toEqual({ kind: "spent" });
    const client = await pool.connect();
    try {
      const first = held[0] as Held;
      await giveBack(client, { ...first, at: "2000-01-01 00:00:00+00" });
      expect(await rowsIn("phone")).toBe(50);
      await giveBack(client, first);
      expect(await rowsIn("phone")).toBe(49);
    } finally {
      client.release();
    }
    expect((await reserve()).kind).toBe("held");
    expect(await reserve()).toEqual({ kind: "spent" });
  });

  it("takes a raised cap at once and never more than a lowered one, without a restart", async () => {
    await setSendBudget(owner, "phone", 50);
    expect(await rush(60)).toBe(50);
    await owner("UPDATE platform_send_budget SET cap = 60 WHERE channel = 'phone'");
    expect(await rush(30)).toBe(10);
    await owner("UPDATE platform_send_budget SET cap = 40 WHERE channel = 'phone'");
    expect(await reserve()).toEqual({ kind: "spent" });
    expect(await rowsIn("phone")).toBe(60);
  });

  it("does not overspend a cap lowered mid-window while some stripes are above their new share", async () => {
    await setSendBudget(owner, "phone", 64);
    for (let i = 0; i < 8; i += 1) {
      await seed("phone", i, 4);
    }
    // 32 sent under 64 (stripes 0-7 full at 4). At 40 the shares are 3 and 2: without settling, stripes 8-15 would
    // still take 2 each, 48 in the window.
    await owner("UPDATE platform_send_budget SET cap = 40 WHERE channel = 'phone'");
    expect(await rush(60)).toBe(8);
    expect(await rowsIn("phone")).toBe(40);
    const stripes = await perStripe("phone");
    stripes.slice(8).forEach((n, k) => expect(n, `stripe ${k + 8}`).toBeLessThanOrEqual(2));
  });

  it("counts older rows when the window is lengthened mid-window", async () => {
    await setSendBudget(owner, "phone", 32);
    for (let i = 0; i < STRIPES; i += 1) {
      await seed("phone", i, 2, 5000);
    }
    await owner("UPDATE platform_send_budget SET window_seconds = 7200 WHERE channel = 'phone'");
    try {
      expect(await reserve()).toEqual({ kind: "spent" });
    } finally {
      await owner("UPDATE platform_send_budget SET window_seconds = 3600 WHERE channel = 'phone'");
    }
  });

  it("stamps the settling time only for a lower cap or a longer window", async () => {
    await owner("UPDATE platform_send_budget SET cap = 2000 WHERE channel = 'email'");
    await owner("UPDATE platform_send_budget SET window_seconds = 3600 WHERE channel = 'email'");
    expect(await stamp()).toBe(false);
    await owner("UPDATE platform_send_budget SET cap = 1000 WHERE channel = 'email'");
    expect(await stamp()).toBe(true);
    await setSendBudget(owner, "email", 1000);
    await owner("UPDATE platform_send_budget SET window_seconds = 86400 WHERE channel = 'email'");
    expect(await stamp()).toBe(true);
  });

  it("keeps the email budget apart from the SMS budget", async () => {
    await setSendBudget(owner, "phone", 0);
    await setSendBudget(owner, "email", 5);
    expect(await rush(10, "email")).toBe(5);
    expect(await rowsIn("email")).toBe(5);
    expect(await reserve("phone")).toEqual({ kind: "spent" });
  });

  it("refuses to run at REPEATABLE READ or SERIALIZABLE, where it would count with a stale snapshot", async () => {
    for (const level of ["REPEATABLE READ", "SERIALIZABLE"]) {
      const client = await pool.connect();
      try {
        await client.query(`BEGIN ISOLATION LEVEL ${level}`);
        await expect(
          client.query("SELECT * FROM take_send_budget('phone')"),
          level,
        ).rejects.toThrow(/take_send_budget: needs READ COMMITTED, got /);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    }
    expect(await rowsIn("phone")).toBe(0);
  });

  it("refuses a window longer than a day, which the sweep of old rows would leave uncounted", async () => {
    await expect(
      owner("UPDATE platform_send_budget SET window_seconds = 86401 WHERE channel = 'email'"),
    ).rejects.toThrow(/platform_send_budget_window_seconds_check/);
    await expect(
      owner("UPDATE platform_send_budget SET window_seconds = 0 WHERE channel = 'email'"),
    ).rejects.toThrow(/platform_send_budget_window_seconds_check/);
    await owner("UPDATE platform_send_budget SET window_seconds = 86400 WHERE channel = 'email'");
  });

  it("refuses an unknown channel by name", async () => {
    await expect(db.app.query("SELECT * FROM take_send_budget('pigeon')")).rejects.toThrow(
      /unknown channel pigeon/,
    );
  });
});

const old = (name: string): Buffer => createHash("sha256").update(name).digest();

/** Migration 0150 copies the hour's rows of the old single keys into the stripes and leaves the old rows in place. */
describe.skipIf(TEST_DATABASE_URL === undefined)("migration 0150 and the old budget keys", () => {
  const migrations = join(import.meta.dirname, "../../migrations");
  let directory: string;
  let db: TestDatabase;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "questify-pre-0150-"));
    for (const file of await readdir(migrations)) {
      if (file < "0150") {
        await cp(join(migrations, file), join(directory, file));
      }
    }
    db = await createTestDatabase(directory);
  });
  afterAll(async () => {
    await db.close();
    if (
      dirname(resolvePath(directory)) !== resolvePath(tmpdir()) ||
      !basename(directory).startsWith("questify-pre-0150-")
    ) {
      throw new Error("unsafe temporary fixture path");
    }
    await rm(directory, { recursive: true, force: true });
  });

  it("counts the old key's rows of the window after the upgrade, keeps them, and copies no older ones", async () => {
    const insert = (bucket: string, name: string, count: number, ago: number) =>
      db.owner.query(
        `INSERT INTO auth_throttle (bucket, key, at)
         SELECT $1, $2, now() - make_interval(secs => $4) FROM generate_series(1, $3)`,
        [bucket, old(name), count, ago],
      );
    await insert("sms_platform", "questify.sms_platform", 4990, 60);
    await insert("sms_platform", "questify.sms_platform", 7, 4000);
    await insert("player_email_platform", "questify.player_email_platform", 3, 80_000);
    await migrate(db.owner as Client, migrations);

    const counted = await db.owner.query<{ bucket: string; stripes: number; rows: number }>(
      `SELECT bucket, count(DISTINCT key)::int AS stripes, count(*)::int AS rows FROM auth_throttle
       WHERE key <> sha256(convert_to(CASE bucket WHEN 'sms_platform' THEN 'questify.sms_platform'
                                      ELSE 'questify.player_email_platform' END, 'UTF8'))
       GROUP BY bucket ORDER BY bucket`,
    );
    expect(counted.rows).toEqual([
      { bucket: "player_email_platform", stripes: 3, rows: 3 },
      { bucket: "sms_platform", stripes: 16, rows: 4990 },
    ]);
    const kept = await db.owner.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM auth_throttle WHERE bucket = 'sms_platform' AND key = $1",
      [old("questify.sms_platform")],
    );
    expect(kept.rows[0]?.n).toBe(4997);
    const answers: string[] = [];
    for (let n = 0; n < 12; n += 1) {
      const { rows } = await db.app.query<{ outcome: string }>(
        "SELECT outcome FROM take_send_budget('phone')",
      );
      answers.push(rows[0]?.outcome ?? "none");
    }
    expect(answers.filter((answer) => answer === "taken")).toHaveLength(10);
    expect(answers.slice(10)).toEqual(["spent", "spent"]);
  });
});
