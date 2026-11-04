import { createHash } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthKeys } from "#src/auth/keys";
import { PLAYER_SIGN_IN_LIMITS as L } from "#src/auth/limits";
import { addressBucket } from "#src/auth/normalize";
import {
  createPlayerSignIn,
  type Asker,
  type CodeRequestResult,
  type PlayerSignIn,
} from "#src/players/sign-in";
import {
  RecordingEmailSender,
  RecordingSmsSender,
  freshIp,
  testConfig,
} from "#test/support/auth-app";
import { setSendBudget, withSendBudgetCap } from "#test/support/send-budget";
import {
  TEST_DATABASE_URL,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

const KEYS = createAuthKeys(testConfig().auth.secret);
const ACCEPT = { terms: "0.1", privacy: "0.1" };
const STRIPE_KEYS = {
  phone: Array.from({ length: 16 }, (_x, i) =>
    createHash("sha256").update(`questify.sms_platform.${i}`).digest(),
  ),
  email: Array.from({ length: 16 }, (_x, i) =>
    createHash("sha256").update(`questify.player_email_platform.${i}`).digest(),
  ),
};

const kinds = (results: readonly CodeRequestResult[]) =>
  results.reduce<Record<string, number>>((into, result) => {
    into[result.kind] = (into[result.kind] ?? 0) + 1;
    return into;
  }, {});

/**
 * The sign-in rush through the service (T-804b, ADR-690 to ADR-692): the platform budget held apart from the request's
 * transaction and given back on every refusal, and the client address that earns room from right codes typed from it.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("the sign-in rush", () => {
  let db: TestDatabase;
  let pool: Pool;
  let sms: RecordingSmsSender;
  let mail: RecordingEmailSender;
  let flow: PlayerSignIn;
  let logged: string[];
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new Pool({ connectionString: db.appUrl, max: 10 });
  });
  afterAll(async () => {
    await pool.end();
    await db.close();
  });
  beforeEach(async () => {
    sms = new RecordingSmsSender();
    mail = new RecordingEmailSender();
    flow = createPlayerSignIn({
      pool,
      keys: KEYS,
      sms,
      email: mail,
      appealEmail: "questify@nafes.test",
    });
    logged = [];
    await owner(
      "DELETE FROM auth_throttle WHERE bucket IN ('sms_platform', 'player_email_platform')",
    );
    vi.restoreAllMocks();
  });

  const owner = (sql: string, values: unknown[] = []) => db.owner.query(sql, values);
  const asker = (address = freshIp()): Asker => ({
    address,
    userAgent: null,
    requestId: undefined,
    deviceId: undefined,
    log: (event) => logged.push(event),
  });
  const newPhone = (): string => {
    counter += 1;
    return `+9665${String(30_000_000 + counter).slice(-8)}`;
  };
  const newEmail = (): string => {
    counter += 1;
    return `rush${counter}@najd.sa`;
  };
  const ask = (value: string, from: Asker = asker()): Promise<CodeRequestResult> =>
    flow.requestCode(
      { channel: value.includes("@") ? "email" : "phone", value, lang: "ar", accept: ACCEPT },
      from,
    );
  const budgetRows = async (channel: "phone" | "email" = "phone"): Promise<number> => {
    const { rows } = await db.owner.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM auth_throttle WHERE key = ANY ($1) AND at > now() - interval '1 day'",
      [STRIPE_KEYS[channel]],
    );
    return rows[0]?.n ?? 0;
  };
  /** Holds the contact's lock from another connection while `work` runs. */
  const withContactLocked = async <T>(contact: string, work: () => Promise<T>): Promise<T> => {
    const lock = KEYS.contactThrottleKey(contact).readBigInt64BE(0).toString();
    await owner("SELECT pg_advisory_lock($1::bigint)", [lock]);
    try {
      return await work();
    } finally {
      await owner("SELECT pg_advisory_unlock($1::bigint)", [lock]);
    }
  };
  const fill = async (address: string, count: number, channel: "phone" | "email" = "phone") => {
    const sent: Array<Readonly<{ contact: string; token: string }>> = [];
    for (let n = 0; n < count; n += 1) {
      const contact = channel === "phone" ? newPhone() : newEmail();
      const result = await ask(contact, asker(address));
      if (result.kind !== "code_sent") {
        throw new Error(`code ${n}: ${result.kind}`);
      }
      sent.push({ contact, token: result.challengeToken });
    }
    return sent;
  };
  const verify = (
    sent: Readonly<{ contact: string; token: string }>,
    address: string,
    right = true,
  ) =>
    flow.verify(
      {
        challengeToken: sent.token,
        code: right
          ? sent.contact.includes("@")
            ? mail.lastCode(sent.contact)
            : sms.lastCode(sent.contact)
          : "000000",
      },
      asker(address),
    );
  const addressRows = (bucket: string, address: string, count: number, ago = 0) =>
    owner(
      `INSERT INTO auth_throttle (bucket, key, at)
       SELECT $1, $2, now() - make_interval(secs => $4) FROM generate_series(1, $3)`,
      [bucket, KEYS.addressKey(addressBucket(address)), count, ago],
    );

  describe("the platform budget", () => {
    it("sends exactly the cap of 200 parallel code requests, SMS and email", async () => {
      const channels = [
        ["phone", newPhone, "sms_unavailable"],
        ["email", newEmail, "email_unavailable"],
      ] as const;
      for (const [channel, contact, refused] of channels) {
        await setSendBudget(owner, channel, 40);
        const results = await Promise.all(Array.from({ length: 200 }, () => ask(contact())));
        const answered = kinds(results);
        expect(answered["code_sent"]).toBe(40);
        expect((answered[refused] ?? 0) + (answered["throttled"] ?? 0)).toBe(160);
        expect(await budgetRows(channel)).toBe(40);
      }
      await setSendBudget(owner, "phone", 5000);
      await setSendBudget(owner, "email", 1000);
      expect(sms.sent).toHaveLength(40);
      expect(mail.sent).toHaveLength(40);
    });

    it("gives the unit back when the contact is busy elsewhere", async () => {
      const phone = newPhone();
      const result = await withContactLocked(phone, () => ask(phone));
      expect(result).toEqual({ kind: "throttled", retryAfterSeconds: 1 });
      expect(await budgetRows()).toBe(0);
    });

    it("gives the unit back when the request's transaction fails, and rethrows", async () => {
      const failingPool = failingOn(db.appUrl, "start_player_challenge");
      const failing = createPlayerSignIn({
        pool: failingPool,
        keys: KEYS,
        sms,
        email: mail,
        appealEmail: "questify@nafes.test",
      });
      const request = failing.requestCode(
        { channel: "phone", value: newPhone(), lang: "ar", accept: ACCEPT },
        asker(),
      );
      await expect(request).rejects.toThrow(/injected failure/);
      await failingPool.end();
      expect(await budgetRows()).toBe(0);
      expect(sms.sent).toEqual([]);
    });

    it("gives the unit back for the App Review phone, which is sent nothing", async () => {
      const reviewer = newPhone();
      const { orgA, eventA } = await seedTwoTenants(db.owner);
      await owner(
        `INSERT INTO review_demo (organizer_id, event_id, contact, contact_key, contact_fp, code_hash, window_until,
                                  created_by)
         VALUES ($1, $2, $3, $4, $5, $6, now() + interval '1 hour', gen_random_uuid())`,
        [
          orgA,
          eventA,
          reviewer,
          KEYS.contactLookupKey(reviewer),
          KEYS.deletionFingerprint(reviewer),
          KEYS.reviewerCodeHash("424242"),
        ],
      );
      expect((await ask(reviewer)).kind).toBe("code_sent");
      expect(sms.sent).toEqual([]);
      expect(await budgetRows()).toBe(0);
    });

    it("answers throttled, not unavailable, to a throttled contact while the budget is spent", async () => {
      const phone = newPhone();
      for (let n = 0; n < L.codesPerContactHour.max; n += 1) {
        expect((await ask(phone)).kind).toBe("code_sent");
      }
      await withSendBudgetCap(owner, "phone", 0, async () => {
        expect((await ask(phone)).kind).toBe("throttled");
        expect((await ask(newPhone())).kind).toBe("sms_unavailable");
      });
    });

    it("never lets a flood of throttled requests take or hold a unit", async () => {
      const phone = newPhone();
      for (let n = 0; n < L.codesPerContactHour.max; n += 1) {
        await ask(phone);
      }
      await owner(
        "DELETE FROM auth_throttle WHERE bucket IN ('sms_platform', 'player_email_platform')",
      );
      await withSendBudgetCap(owner, "phone", 5, async () => {
        const flood = Array.from({ length: 100 }, () => ask(phone));
        const fresh = Array.from({ length: 5 }, () => ask(newPhone()));
        const [flooded, sent] = await Promise.all([Promise.all(flood), Promise.all(fresh)]);
        expect(kinds(flooded)).toEqual({ throttled: 100 });
        expect(kinds(sent)).toEqual({ code_sent: 5 });
        expect(await budgetRows()).toBe(5);
      });
    });

    it("takes and gives back for a resend like for a first code", async () => {
      const phone = newPhone();
      const first = await ask(phone);
      if (first.kind !== "code_sent") {
        throw new Error(first.kind);
      }
      expect(await budgetRows()).toBe(1);
      await owner(
        "UPDATE player_login_challenge SET last_sent_at = last_sent_at - interval '2 minutes' WHERE contact = $1",
        [phone],
      );
      await withSendBudgetCap(owner, "phone", 1, async () => {
        expect(
          await flow.resend({ challengeToken: first.challengeToken, lang: "ar" }, asker()),
        ).toEqual({ kind: "sms_unavailable" });
      });
      expect(await budgetRows()).toBe(1);
      const resent = await withContactLocked(phone, () =>
        flow.resend({ challengeToken: first.challengeToken, lang: "ar" }, asker()),
      );
      expect(resent).toEqual({ kind: "throttled", retryAfterSeconds: 1 });
      expect(await budgetRows()).toBe(1);
      const again = await flow.resend(
        { challengeToken: first.challengeToken, lang: "ar" },
        asker(),
      );
      expect(again.kind).toBe("resent");
      expect(await budgetRows()).toBe(2);
    });
  });

  describe("the address that earns room (ADR-691)", () => {
    it("sends 200 at once, then 2 more for each contact that typed a right code from it", async () => {
      const venue = freshIp();
      const sent = await fill(venue, 200);
      expect((await ask(newPhone(), asker(venue))).kind).toBe("throttled");
      for (const one of sent.slice(0, 50)) {
        expect((await verify(one, venue)).kind).toBe("new");
      }
      await fill(venue, 100);
      expect((await ask(newPhone(), asker(venue))).kind).toBe("throttled");
    });

    it("earns nothing for a wrong code, a right code from elsewhere, a contact twice, or another channel", async () => {
      const venue = freshIp();
      const elsewhere = freshIp();
      const sent = await fill(venue, 200);
      expect((await verify(sent[0]!, venue, false)).kind).toBe("invalid_code");
      expect((await verify(sent[1]!, elsewhere)).kind).toBe("new");
      const again = sent[2]!;
      expect((await verify(again, venue)).kind).toBe("new");
      const second = await ask(again.contact, asker(elsewhere));
      if (second.kind !== "code_sent") {
        throw new Error(second.kind);
      }
      expect((await verify({ ...again, token: second.challengeToken }, venue)).kind).toBe("new");
      // Only the first right code of `again` counts: two more codes, then the window is full.
      await fill(venue, 2);
      expect((await ask(newPhone(), asker(venue))).kind).toBe("throttled");
      // Email codes typed back earn email room only.
      const mailVenue = freshIp();
      const mails = await fill(mailVenue, 200, "email");
      for (const one of mails.slice(0, 10)) {
        expect((await verify(one, mailVenue)).kind).toBe("new");
      }
      expect((await ask(newPhone(), asker(mailVenue))).kind).toBe("throttled");
      expect((await ask(newEmail(), asker(mailVenue))).kind).toBe("code_sent");
    });

    it("holds the ceiling of 2,000 however many contacts typed a right code", async () => {
      const venue = freshIp();
      await addressRows("player_code_address", venue, 1999);
      await addressRows("player_verified_phone_address", venue, 5000);
      expect((await ask(newPhone(), asker(venue))).kind).toBe("code_sent");
      expect((await ask(newPhone(), asker(venue))).kind).toBe("throttled");
    });

    it("lets the wrong-code window earn the same way, from 100 up to 500", async () => {
      const venue = freshIp();
      const [one] = await fill(venue, 1);
      await addressRows("player_fail_address", venue, 100);
      expect((await verify(one!, venue, false)).kind).toBe("throttled");
      await addressRows("player_verified_phone_address", venue, 10);
      expect((await verify(one!, venue, false)).kind).toBe("invalid_code");
      await addressRows("player_fail_address", venue, 400);
      await addressRows("player_verified_phone_address", venue, 5000);
      expect((await verify(one!, venue, false)).kind).toBe("throttled");
    });

    it("forgets earned room once it leaves the window", async () => {
      const venue = freshIp();
      await addressRows("player_code_address", venue, 200);
      await addressRows("player_verified_phone_address", venue, 50, 3700);
      expect((await ask(newPhone(), asker(venue))).kind).toBe("throttled");
    });
  });

  it("puts the budget back for later suites", async () => {
    await setSendBudget(owner, "phone", 5000);
    await setSendBudget(owner, "email", 1000);
  });
});

/**
 * A pool of its own whose connections throw on any query naming `fn`, standing in for a database failure inside the
 * request's transaction. The caller ends it.
 */
function failingOn(url: string, fn: string): Pool {
  const pool = new Pool({ connectionString: url, max: 2 });
  pool.on("connect", (client: PoolClient) => {
    const query = client.query.bind(client) as (...args: unknown[]) => unknown;
    Object.assign(client, {
      query: (...args: unknown[]) =>
        typeof args[0] === "string" && args[0].includes(fn)
          ? Promise.reject(new Error("injected failure"))
          : query(...args),
    });
  });
  return pool;
}
