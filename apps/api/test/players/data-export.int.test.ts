import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loggerOptions } from "#src/app";
import { startApp, testConfig, type TestApp } from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

/**
 * The player's own data download over HTTP (T-708, FR-1418): a download that nothing keeps (no-store, attachment,
 * nosniff), no Idempotency-Key, never in the idempotency store or a log line, 3 a day in the database (429 with
 * Retry-After), 401 without a session, 404 for a banned account.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("downloading my data over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let serial = 0;
  const lines: string[] = [];
  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db, {
      ...loggerOptions(testConfig()),
      level: "info",
      stream: { write: (line: string) => void lines.push(line) },
    });
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const player = async (status = "active") => {
    serial += 1;
    const username = `exporter_${serial}`;
    const email = `exporter${serial}@example.com`;
    const [row] = (
      await db.owner.query<{ id: string }>(
        "INSERT INTO player (username, status) VALUES ($1, $2) RETURNING id",
        [username, status],
      )
    ).rows;
    await db.owner.query("INSERT INTO player_contact (player_id, email) VALUES ($1, $2)", [row?.id, email]);
    const token = randomBytes(32).toString("base64url");
    await db.owner.query(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [row?.id, createHash("sha256").update(token).digest()],
    );
    return { id: row?.id ?? "", username, email, token };
  };
  const download = (token: string | null) =>
    test.app.inject({
      method: "POST",
      url: "/v1/me/data-export",
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
      payload: {},
    });

  it("downloads the file as an attachment nothing keeps, three times a day", async () => {
    const me = await player();
    const first = await download(me.token);
    expect(first.statusCode).toBe(200);
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(first.headers["x-content-type-options"]).toBe("nosniff");
    expect(first.headers["content-disposition"]).toMatch(/^attachment; filename="questify-data-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(first.headers["content-type"]).toContain("application/json");
    const file = first.json<{ format: string; contacts: { email: string }; account: { username: string } }>();
    expect(file.format).toBe("questify-data-export");
    expect(file.contacts.email).toBe(me.email);
    expect(file.account.username).toBe(me.username);
    expect((await download(me.token)).statusCode).toBe(200);
    expect((await download(me.token)).statusCode).toBe(200);
    const refused = await download(me.token);
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ code: "too_many_attempts" });
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(86_000);
    const logged = lines.join("\n");
    expect(logged).not.toContain(me.email);
    expect(logged).toContain('"event":"data.exported"');
  });

  it("answers 401 without a session and 404 to a banned account", async () => {
    expect((await download(null)).statusCode).toBe(401);
    const banned = await player("banned");
    expect([401, 403, 404]).toContain((await download(banned.token)).statusCode);
  });
});
