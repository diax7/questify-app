import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EmailSendError } from "#src/auth/email/sender";
import { createAuthKeys } from "#src/auth/keys";
import * as passwordModule from "#src/auth/password";
import { clearThrottleFor, createOutcome, createStaffAccount } from "#src/auth/staff-admin";
import { BUCKETS, record } from "#src/auth/throttle";
import {
  DASHBOARD_ORIGIN,
  PASSWORD,
  browserHeaders,
  postPassword,
  signInFully,
  startApp,
  testConfig,
  type TestApp,
} from "#test/support/auth-app";
import {
  TEST_DATABASE_URL,
  connectAsOwner,
  createTestDatabase,
  type TestDatabase,
} from "#test/support/test-db";

vi.mock("#src/auth/password", async (importOriginal) => {
  const actual = await importOriginal<typeof passwordModule>();
  return { ...actual, hashPassword: vi.fn(actual.hashPassword) };
});

const API_ROOT = join(import.meta.dirname, "..", "..");
const PRELOAD = join(API_ROOT, "test", "support", "staff-cli-preload.mjs");
const MAIL_OK_PRELOAD = join(API_ROOT, "test", "support", "staff-cli-mail-ok-preload.mjs");

/** What a run of the real CLI came to. `stdin` stays open until it exits, as a hung pipe would. */
function runCli(
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  preload: string = PRELOAD,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings",
        "--import",
        preload,
        "src/staff-cli.ts",
        ...args,
      ],
      {
        cwd: API_ROOT,
        env: { PATH: process.env["PATH"] ?? "", ...env },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stdin.write("a piped password\n");
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}

const codeOf = (response: { json: <T>() => T }) => response.json<{ code: string }>().code;

describe.skipIf(TEST_DATABASE_URL === undefined)("staff account administration", () => {
  let db: TestDatabase;
  let test: TestApp;
  let ownerUrl = "";
  const keys = createAuthKeys(testConfig().auth.secret);

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
    const url = new URL(db.appUrl);
    const base = new URL(TEST_DATABASE_URL ?? "");
    url.username = base.username;
    url.password = base.password;
    ownerUrl = url.toString();
  }, 180_000);
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const invite = () => ({ email: test.mail, dashboardOrigin: DASHBOARD_ORIGIN, report: () => {} });
  const create = (email: string, owner: Client = db.owner) =>
    createStaffAccount(owner, { email }, invite());
  const owner = async <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const linksOf = (id: string) =>
    owner("SELECT 1 FROM staff_password_reset WHERE staff_user_id = $1", [id]);
  const tokenOf = (email: string, lang = "en"): string => {
    const found = new RegExp(`/${lang}/reset-password#token=([A-Za-z0-9_-]{43})`).exec(
      test.mail.to(email).at(-1)?.text ?? "",
    )?.[1];
    if (found === undefined) throw new Error(`No link was emailed to ${email}.`);
    return found;
  };
  const setPassword = (token: string, newPassword = PASSWORD) =>
    test.app.inject({
      method: "POST",
      url: "/v1/staff/auth/reset/confirm",
      headers: browserHeaders(),
      payload: { token, newPassword },
    });
  const mailSettings = {
    AUTH_SECRET: "t".repeat(40),
    DASHBOARD_ORIGIN,
    MAIL_FROM: "questify@nafes.test",
    GMAIL_SERVICE_ACCOUNT_KEY: JSON.stringify({
      type: "service_account",
      client_email: "mailer@questify.iam.gserviceaccount.test",
      private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
      token_uri: "https://oauth2.googleapis.com/token",
    }),
  };

  const settings = () => ({ ...mailSettings, DATABASE_ADMIN_URL: ownerUrl });

  it("hashes a new random secret for each account, never a constant", async () => {
    vi.mocked(passwordModule.hashPassword).mockClear();
    await create("random.one@najd.sa");
    await create("random.two@najd.sa");
    const [first, second] = vi
      .mocked(passwordModule.hashPassword)
      .mock.calls.map(([secret]) => secret);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(second);
  });

  it("create grants no role", async () => {
    const made = await create("  New.Person@Najd.SA ");
    expect(made).toMatchObject({ sent: true, audited: true });
    const [row] = await owner("SELECT email, platform_role, status FROM staff_user WHERE id = $1", [
      made.id,
    ]);
    expect(row).toEqual({
      email: "new.person@najd.sa",
      platform_role: "none",
      status: "active",
    });
  });

  it("stores one link of 24 hours and mails it once in both languages", async () => {
    const { id } = await create("link@najd.sa");
    const [link] = await owner<{ seconds: number }>(
      `SELECT extract(epoch FROM expires_at - created_at)::int AS seconds
       FROM staff_password_reset WHERE staff_user_id = $1`,
      [id],
    );
    expect(link?.seconds).toBe(86_400);
    expect(await linksOf(id)).toHaveLength(1);
    const mail = test.mail.to("link@najd.sa");
    expect(mail).toHaveLength(1);
    expect(mail[0]?.subject).toBe(
      "حسابك في Questify: اختر كلمة المرور | Choose your Questify password",
    );
    expect(mail[0]?.text).toContain(`${DASHBOARD_ORIGIN}/ar/reset-password#token=`);
    expect(mail[0]?.text).toContain(`${DASHBOARD_ORIGIN}/en/reset-password#token=`);
    expect(mail[0]?.text).toContain("24 ساعة");
    expect(mail[0]?.text).toContain("lasts 24 hours");
    expect(tokenOf("link@najd.sa", "ar")).toBe(tokenOf("link@najd.sa", "en"));
  });

  it.each([
    ["not an email", "nobody"],
    ["an email without a domain dot", "a@b"],
  ])("refuses %s and sends nothing", async (_label, email) => {
    const before = test.mail.sent.length;
    await expect(create(email)).rejects.toThrow(/valid email/);
    expect(await owner("SELECT 1 FROM staff_user WHERE email = $1", [email])).toEqual([]);
    expect(test.mail.sent).toHaveLength(before);
  });

  it("explains that an account already exists, and leaves no second link or mail", async () => {
    const { id } = await create("twice@najd.sa");
    await expect(create("TWICE@najd.sa")).rejects.toThrow(/already exists/);
    expect(await linksOf(id)).toHaveLength(1);
    expect(test.mail.to("twice@najd.sa")).toHaveLength(1);
  });

  it("keeps the real cause of an account that already exists", async () => {
    await create("cause@najd.sa");
    const error = await create("cause@najd.sa").catch((caught: unknown) => caught);
    expect((error as Error).cause).toMatchObject({ code: "23505" });
  });

  it("passes any other database failure through instead of calling it a duplicate", async () => {
    const broken = {
      query: async () => {
        throw new Error("connection lost");
      },
    } as unknown as Client;
    await expect(create("x@najd.sa", broken)).rejects.toThrow("connection lost");
    expect(test.mail.to("x@najd.sa")).toEqual([]);
  });

  it("keeps the account and link when the send fails, and records it", async () => {
    test.mail.failing = true;
    try {
      const made = await create("nomail@najd.sa");
      expect(made).toMatchObject({ sent: false, audited: true });
      expect(await linksOf(made.id)).toHaveLength(1);
      expect(
        await owner(
          "SELECT after FROM audit_log WHERE action = 'staff.invite' AND target_id = $1",
          [made.id],
        ),
      ).toEqual([{ after: { sent: false } }]);
      expect(createOutcome("nomail@najd.sa", made)).toEqual({
        text: 'Created nomail@najd.sa, but the email did not go out. Send them to "Forgot your password?".',
        exitCode: 1,
      });
    } finally {
      test.mail.failing = false;
    }
  });

  it("does not call a sent email undelivered when its audit entry fails", async () => {
    const noInviteAudit = {
      query: (...args: Parameters<Client["query"]>) => {
        if (JSON.stringify(args).includes("staff.invite")) {
          return Promise.reject(new Error("audit write failed"));
        }
        return db.owner.query(...args);
      },
    } as unknown as Client;
    const made = await create("audit@najd.sa", noInviteAudit);
    expect(made).toMatchObject({ sent: true, audited: false });
    const outcome = createOutcome("audit@najd.sa", made);
    expect(outcome.text).not.toContain("did not go out");
    expect(outcome.text).toContain("sent the email");
    expect(outcome.exitCode).toBe(1);
  });

  it("reports why the send or the audit write failed, and never the link", async () => {
    let link = "";
    const sender = {
      name: "gmail",
      send: (message: { text: string }) => {
        link = message.text;
        return Promise.reject(
          new EmailSendError("gmail", "the Gmail API answered 401 (UNAUTHENTICATED)"),
        );
      },
    };
    const lines: string[] = [];
    const report = (line: string) => lines.push(line);
    const failedSend = await createStaffAccount(
      db.owner,
      { email: "why@najd.sa" },
      { email: sender, dashboardOrigin: DASHBOARD_ORIGIN, report },
    );
    expect(failedSend).toMatchObject({ sent: false, audited: true });
    expect(lines).toEqual([
      'The invite email failed: Email sender "gmail" failed: the Gmail API answered 401 (UNAUTHENTICATED)',
    ]);

    const noInviteAudit = {
      query: (...args: Parameters<Client["query"]>) =>
        JSON.stringify(args).includes("staff.invite")
          ? Promise.reject(new TypeError("audit write failed for why2@najd.sa"))
          : db.owner.query(...args),
    } as unknown as Client;
    const failedAudit = await createStaffAccount(
      noInviteAudit,
      { email: "why2@najd.sa" },
      {
        email: { name: "other", send: () => Promise.reject(new RangeError("down")) },
        dashboardOrigin: DASHBOARD_ORIGIN,
        report,
      },
    );
    expect(failedAudit).toMatchObject({ sent: false, audited: false });
    expect(lines.slice(1)).toEqual([
      "The invite email failed: RangeError",
      "The staff.invite audit entry failed: TypeError",
    ]);

    const token = /token=([A-Za-z0-9_-]{43})/.exec(link)?.[1];
    expect(token).toBeDefined();
    expect(lines.join("\n")).not.toContain(token);
    expect(lines.join("\n")).not.toContain("najd.sa");
  });

  it("reports a sent, audited invite as done, with no platform role", async () => {
    const made = { id: "an-id", sent: true, audited: true };
    expect(createOutcome("done@najd.sa", made)).toEqual({
      text: "Created done@najd.sa (an-id). They set their own password from the emailed link. The account has no platform role.",
      exitCode: 0,
    });
  });

  describe("the CLI itself", () => {
    it("never touches stdin, and exits 1 when the email cannot go out", async () => {
      const run = await runCli(["create", "cli.down@najd.sa"], settings());
      expect(run.output).toContain("Created cli.down@najd.sa, but the email did not go out.");
      expect(run.code).toBe(1);
      expect(await owner("SELECT 1 FROM staff_user WHERE email = 'cli.down@najd.sa'")).toHaveLength(
        1,
      );
    }, 60_000);

    it("exits 0 when the provider takes the email, and prints nothing of the link", async () => {
      const { privateKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      });
      const run = await runCli(
        ["create", "cli.sent@najd.sa"],
        {
          ...settings(),
          GMAIL_SERVICE_ACCOUNT_KEY: JSON.stringify({
            ...JSON.parse(mailSettings.GMAIL_SERVICE_ACCOUNT_KEY),
            private_key: privateKey,
          }),
        },
        MAIL_OK_PRELOAD,
      );
      expect(run.output).toContain("Created cli.sent@najd.sa (");
      expect(run.output).toContain("They set their own password from the emailed link.");
      expect(run.output).not.toContain("token=");
      expect(run.code).toBe(0);
      expect(
        await owner(
          `SELECT 1 FROM audit_log a JOIN staff_user s ON s.id = a.target_id::uuid
           WHERE s.email = 'cli.sent@najd.sa' AND a.action = 'staff.invite'`,
        ),
      ).toHaveLength(1);
    }, 60_000);

    it("refuses --admin with the usage text, and makes no account", async () => {
      const run = await runCli(["create", "cli.admin@najd.sa", "--admin"], settings());
      expect(run.output).toContain("Usage: staff create <email>  |");
      expect(run.code).toBe(1);
      expect(await owner("SELECT 1 FROM staff_user WHERE email = 'cli.admin@najd.sa'")).toEqual([]);
    }, 60_000);

    it("prints why the email did not go out, and nothing of the link", async () => {
      const run = await runCli(["create", "cli.why@najd.sa"], settings());
      expect(run.output).toContain('The invite email failed: Email sender "gmail" failed:');
      expect(run.output).not.toContain("token=");
      expect(run.output).not.toMatch(/[A-Za-z0-9_-]{43}/);
      expect(run.code).toBe(1);
    }, 60_000);

    it("refuses an email that starts with a dash, as bare --admin does", async () => {
      const run = await runCli(["create", "--admin"], settings());
      expect(run.output).toContain("Usage: staff create <email>  |");
      expect(run.code).toBe(1);
      expect(await owner("SELECT 1 FROM staff_user WHERE email = '--admin'")).toEqual([]);
    }, 60_000);

    it("refuses before writing anything when the mail settings are missing", async () => {
      const run = await runCli(["create", "cli.nomail@najd.sa"], {
        ...settings(),
        MAIL_FROM: "",
      });
      expect(run.output).toContain("MAIL_FROM");
      expect(run.code).toBe(1);
      expect(await owner("SELECT 1 FROM staff_user WHERE email = 'cli.nomail@najd.sa'")).toEqual(
        [],
      );
    }, 60_000);
  });

  describe("the first password", () => {
    it("answers the ordinary 401 to a sign-in before the link is used", async () => {
      await create("early@najd.sa");
      const early = await postPassword(test, "early@najd.sa");
      expect(early.statusCode).toBe(401);
      expect(codeOf(early)).toBe(codeOf(await postPassword(test, "nobody.here@najd.sa")));
    });

    it("sets a password by the link, then signs in by row 1 with the code", async () => {
      const { id } = await create("works@najd.sa");
      expect((await setPassword(tokenOf("works@najd.sa"))).statusCode).toBeLessThan(300);
      await test.deferred.idle();
      expect(await signInFully(test, "works@najd.sa")).toContain("__Host-qs_session=");
      expect(await linksOf(id)).toEqual([]);
      expect(
        await owner(
          "SELECT 1 FROM audit_log WHERE action = 'staff.password.reset' AND target_id = $1",
          [id],
        ),
      ).toHaveLength(1);
    });

    it("refuses a used link", async () => {
      await create("used@najd.sa");
      const token = tokenOf("used@najd.sa");
      expect((await setPassword(token)).statusCode).toBeLessThan(300);
      expect(codeOf(await setPassword(token, "another pass phrase 88"))).toBe("reset_link_invalid");
    });

    it("refuses a link past its 24 hours, then Forgot gives a working one", async () => {
      const { id } = await create("late@najd.sa");
      const token = tokenOf("late@najd.sa");
      await owner("UPDATE staff_password_reset SET expires_at = now() WHERE staff_user_id = $1", [
        id,
      ]);
      expect(codeOf(await setPassword(token))).toBe("reset_link_invalid");
      await test.app.inject({
        method: "POST",
        url: "/v1/staff/auth/reset/request",
        headers: browserHeaders(),
        payload: { email: "late@najd.sa", lang: "en" },
      });
      await test.deferred.idle();
      expect((await setPassword(tokenOf("late@najd.sa"))).statusCode).toBeLessThan(300);
    });

    it("refuses the link of a disabled account", async () => {
      const { id } = await create("off@najd.sa");
      await owner("UPDATE staff_user SET status = 'disabled' WHERE id = $1", [id]);
      expect(codeOf(await setPassword(tokenOf("off@najd.sa")))).toBe("reset_link_invalid");
    });

    it("sets one password when the same link is used twice at once", async () => {
      const { id } = await create("race@najd.sa");
      const token = tokenOf("race@najd.sa");
      const answers = await Promise.all([
        setPassword(token, "first pass phrase 11"),
        setPassword(token, "second pass phrase 22"),
      ]);
      expect(answers.filter((answer) => answer.statusCode < 300)).toHaveLength(1);
      expect(
        await owner(
          "SELECT 1 FROM audit_log WHERE action = 'staff.password.reset' AND target_id = $1",
          [id],
        ),
      ).toHaveLength(1);
    });

    it("makes one account, one link and one mail from two create calls at once", async () => {
      const second = await connectAsOwner(db);
      try {
        const [one, two] = await Promise.allSettled([
          create("both@najd.sa"),
          create("both@najd.sa", second),
        ]);
        const made = [one, two].filter((result) => result.status === "fulfilled");
        expect(made).toHaveLength(1);
        const [row] = await owner<{ id: string }>(
          "SELECT id FROM staff_user WHERE email = 'both@najd.sa'",
        );
        expect(await linksOf(row?.id ?? "")).toHaveLength(1);
        expect(test.mail.to("both@najd.sa")).toHaveLength(1);
      } finally {
        await second.end();
      }
    });

    it("lets a Forgot request replace the link, and the older one then fails", async () => {
      await create("replaced@najd.sa");
      const older = tokenOf("replaced@najd.sa");
      await test.app.inject({
        method: "POST",
        url: "/v1/staff/auth/reset/request",
        headers: browserHeaders(),
        payload: { email: "replaced@najd.sa", lang: "en" },
      });
      await test.deferred.idle();
      expect(codeOf(await setPassword(older))).toBe("reset_link_invalid");
      expect((await setPassword(tokenOf("replaced@najd.sa"))).statusCode).toBeLessThan(300);
    });

    it("keeps a link under a day old through the retention sweep", async () => {
      const { id } = await create("swept@najd.sa");
      await owner(
        `UPDATE staff_password_reset SET created_at = now() - interval '23 hours 59 minutes'
         WHERE staff_user_id = $1`,
        [id],
      );
      await db.app.query("DELETE FROM staff_password_reset");
      expect(await linksOf(id)).toHaveLength(1);
    });
  });

  it("clears a person's failure count and challenge count", async () => {
    const { id } = await create("locked@najd.sa");
    for (let count = 0; count < 3; count += 1) {
      await record(db.owner, BUCKETS.failEmail, keys.emailKey("locked@najd.sa"));
      await record(db.owner, BUCKETS.challengeUser, keys.userKey(id));
      await record(db.owner, BUCKETS.resetEmail, keys.emailKey("locked@najd.sa"));
    }
    await record(db.owner, BUCKETS.failEmail, keys.emailKey("someone.else@najd.sa"));

    expect(await clearThrottleFor(db.owner, keys, " LOCKED@najd.sa ")).toBe(true);
    const { rows } = await db.owner.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM auth_throttle WHERE key = ANY($1)",
      [[keys.emailKey("locked@najd.sa"), keys.userKey(id)]],
    );
    expect(rows[0]?.n).toBe(0);
    const others = await db.owner.query("SELECT 1 FROM auth_throttle WHERE key = $1", [
      keys.emailKey("someone.else@najd.sa"),
    ]);
    expect(others.rows).toHaveLength(1);
  });

  it("reports an unknown email but still clears its failure count", async () => {
    await record(db.owner, BUCKETS.failEmail, keys.emailKey("ghost@najd.sa"));
    expect(await clearThrottleFor(db.owner, keys, "ghost@najd.sa")).toBe(false);
    const { rows } = await db.owner.query("SELECT 1 FROM auth_throttle WHERE key = $1", [
      keys.emailKey("ghost@najd.sa"),
    ]);
    expect(rows).toEqual([]);
  });
});
