import type { FastifyInstance, FastifyServerOptions, LightMyRequestResponse } from "fastify";
import { Pool, type Client } from "pg";
import { buildApp } from "#src/app";
import { EmailSendError, type EmailMessage, type EmailSender } from "#src/auth/email/sender";
import { hashPassword } from "#src/auth/password";
import type { AppConfig } from "#src/config";
import { MemoryIdempotencyStore } from "#src/idempotency-store";
import type { TestDatabase } from "#test/support/test-db";

export const DASHBOARD_ORIGIN = "https://app.questify.test";
export const PASSWORD = "correct horse battery staple";

export function testConfig(databaseUrl = "postgres://unused"): AppConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 3000,
    minAppVersion: "1.0.0",
    releaseSha: "test",
    databaseUrl,
    trustProxyHops: 1,
    auth: {
      secret: "t".repeat(40),
      dashboardOrigin: DASHBOARD_ORIGIN,
      smtpUser: "bot@gmail.test",
      smtpAppPassword: "unused",
      resend: undefined,
      securityAlertEmail: "security@questify.test",
    },
  };
}

/** Collects every email instead of sending it, and can be told to fail. */
export class RecordingEmailSender implements EmailSender {
  readonly name = "recording";
  readonly sent: EmailMessage[] = [];
  failing = false;

  send(message: EmailMessage): Promise<void> {
    if (this.failing) {
      return Promise.reject(new EmailSendError("recording", "told to fail"));
    }
    this.sent.push(message);
    return Promise.resolve();
  }

  /** The six-digit code in the most recent email to this address. */
  lastCode(to: string): string {
    const mail = this.sent.filter((message) => message.to === to).at(-1);
    const code = /[0-9]{6}/.exec(mail?.text ?? "")?.[0];
    if (code === undefined) {
      throw new Error(`No sign-in code was emailed to ${to}.`);
    }
    return code;
  }

  to(address: string): EmailMessage[] {
    return this.sent.filter((message) => message.to === address);
  }
}

export type StaffSeed = Readonly<{
  email: string;
  password?: string;
  admin?: boolean;
  status?: "active" | "disabled";
  passwordHash?: string;
}>;

/** Creates a staff account as the database owner (the API's own role cannot create accounts). */
export async function createStaff(owner: Client, seed: StaffSeed): Promise<string> {
  const hash = seed.passwordHash ?? (await hashPassword(seed.password ?? PASSWORD));
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO staff_user (email, password_hash, platform_role, status)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [seed.email, hash, seed.admin === true ? "admin" : "none", seed.status ?? "active"],
  );
  return rows[0]?.id ?? "";
}

export type TestApp = Readonly<{
  app: FastifyInstance;
  mail: RecordingEmailSender;
  pool: Pool;
  close: () => Promise<void>;
}>;

export async function startApp(
  db: TestDatabase,
  logger: FastifyServerOptions["logger"] = false,
): Promise<TestApp> {
  const pool = new Pool({ connectionString: db.appUrl, max: 8 });
  const mail = new RecordingEmailSender();
  const app = buildApp({
    config: testConfig(db.appUrl),
    idempotencyStore: new MemoryIdempotencyStore(),
    pool,
    emailSender: mail,
    logger,
  });
  await app.ready();
  return {
    app,
    mail,
    pool,
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}

let addressCounter = 0;

/** A client address nobody has used yet, so one test's failed attempts never count against another's. */
export function freshIp(): string {
  addressCounter += 1;
  return `198.51.${100 + Math.floor(addressCounter / 250)}.${(addressCounter % 250) + 1}`;
}

/** Headers a browser behind the dashboard proxy sends. */
export function browserHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { origin: DASHBOARD_ORIGIN, "x-forwarded-for": freshIp(), ...extra };
}

export async function postPassword(
  test: TestApp,
  email: string,
  password = PASSWORD,
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  return test.app.inject({
    method: "POST",
    url: "/v1/staff/auth/password",
    headers: browserHeaders(headers),
    payload: { email, password },
  });
}

export async function postCode(
  test: TestApp,
  challengeToken: string,
  code: string,
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  return test.app.inject({
    method: "POST",
    url: "/v1/staff/auth/code",
    headers: browserHeaders(headers),
    payload: { challengeToken, code },
  });
}

/** The `name=value` part of the session cookie a response set, ready to send back. */
export function sessionCookieOf(response: LightMyRequestResponse): string {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  const pair = value?.split(";")[0];
  if (pair === undefined || !pair.startsWith("__Host-qs_session=")) {
    throw new Error("The response did not set a session cookie.");
  }
  return pair;
}

/** Runs the whole flow (password, emailed code, code) and returns the session cookie. */
export async function signInFully(
  test: TestApp,
  email: string,
  headers: Record<string, string> = {},
): Promise<string> {
  const first = await postPassword(test, email, PASSWORD, headers);
  const { challengeToken } = first.json<{ challengeToken: string }>();
  const done = await postCode(test, challengeToken, test.mail.lastCode(email), headers);
  if (done.statusCode !== 200) {
    throw new Error(`Sign-in failed: ${done.statusCode} ${done.body}`);
  }
  return sessionCookieOf(done);
}

export function withSession(cookie: string, extra: Record<string, string> = {}) {
  return browserHeaders({ cookie, ...extra });
}
