import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Pool } from "pg";
import { buildApp } from "#src/app";
import type { EmailMessage, EmailSender } from "#src/auth/email/sender";
import { MemoryIdempotencyStore } from "#src/idempotency-store";
import { createStaff, testConfig } from "#test/support/auth-app";
import { createTestDatabase, seedTwoTenants } from "#test/support/test-db";

/**
 * The real API for the web app's browser tests (apps/web/e2e), on a throw-away database. Test code only: it is
 * bundled and started by Playwright, never part of the product. Sign-in codes are written to a file the tests read,
 * so the product needs no test endpoint.
 *
 * Settings: TEST_DATABASE_URL, E2E_API_PORT, E2E_WEB_ORIGIN (the browser's origin), E2E_CODES_FILE.
 */
const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} must be set for the e2e API server.`);
  }
  return value;
};

/** The password the e2e breach list knows (e2e/paths.ts has the same text). */
const E2E_BREACHED_PASSWORD = "this one was in a breach 2019";

/** Keeps the last sign-in code and the last reset link sent to each address in a JSON file. */
class FileEmailSender implements EmailSender {
  readonly name = "e2e-file";
  private readonly mail: { codes: Record<string, string>; links: Record<string, string> } = {
    codes: {},
    links: {},
  };

  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(this.mail));
  }

  send(message: EmailMessage): Promise<void> {
    const link = /https?:\/\/\S+\/reset-password#token=[A-Za-z0-9_-]+/.exec(message.text)?.[0];
    const code = /(?<![0-9])[0-9]{6}(?![0-9])/.exec(message.text)?.[0];
    if (link !== undefined) {
      this.mail.links[message.to] = link;
    } else if (code !== undefined) {
      this.mail.codes[message.to] = code;
    }
    writeFileSync(this.file, JSON.stringify(this.mail));
    return Promise.resolve();
  }
}

async function main(): Promise<void> {
  const port = Number(required("E2E_API_PORT"));
  const db = await createTestDatabase();
  const ids = await seedTwoTenants(db.owner);
  // One editor account per test and browser size (an organizer has one owner), so the per-account limits (5 codes an hour) never cross tests.
  for (const size of ["desktop", "phone"]) {
    for (const name of ["ar", "en", "keys", "resend", "reset", "change"]) {
      const id = await createStaff(db.owner, { email: `${name}.${size}@najd.test` });
      await db.owner.query(
        "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'editor')",
        [ids.orgA, id],
      );
    }
    await createStaff(db.owner, { email: `new.${size}@najd.test` });
  }
  const pool = new Pool({ connectionString: db.appUrl, max: 8 });
  const config = {
    ...testConfig(db.appUrl, { dashboardOrigin: required("E2E_WEB_ORIGIN") }),
    port,
  };
  const app = buildApp({
    config,
    idempotencyStore: new MemoryIdempotencyStore(),
    pool,
    emailSender: new FileEmailSender(required("E2E_CODES_FILE")),
    breachCheck: (password) => Promise.resolve(password === E2E_BREACHED_PASSWORD),
    logger: false,
  });
  const stop = async (): Promise<void> => {
    await app.close();
    await pool.end();
    await db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  await app.listen({ host: "127.0.0.1", port });
}

void main().catch((error: unknown) => {
  process.stderr.write(`e2e API server failed: ${String(error)}\n`);
  process.exit(1);
});
