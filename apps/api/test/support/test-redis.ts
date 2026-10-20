import { randomBytes } from "node:crypto";
import { createClient, type RedisClientType } from "redis";

export const TEST_REDIS_URL = process.env["TEST_REDIS_URL"];

/**
 * A connected client whose every key carries a prefix of its own, so parallel test files never share a ranking.
 *
 * @throws Error when TEST_REDIS_URL is not set (guard the suite with `describe.skipIf`).
 */
export async function createTestRedis(): Promise<RedisClientType> {
  if (TEST_REDIS_URL === undefined) {
    throw new Error("TEST_REDIS_URL is not set.");
  }
  const client: RedisClientType = createClient({
    url: TEST_REDIS_URL,
    keyPrefix: `test:${randomBytes(6).toString("hex")}:`,
  });
  await client.connect();
  return client;
}
