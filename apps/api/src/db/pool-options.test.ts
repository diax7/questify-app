import { describe, expect, it } from "vitest";
import { IDLE_IN_TRANSACTION_TIMEOUT_MS, poolOptions } from "#src/db/pool-options";

describe("poolOptions", () => {
  it("ends idle transactions after 10 s beside the lock limit, and keeps the statement limits", () => {
    const options = poolOptions({ databaseUrl: "postgres://x@y/z", databasePoolSize: 7 });
    expect(IDLE_IN_TRANSACTION_TIMEOUT_MS).toBe(10_000);
    expect(options.options).toBe(
      "-c lock_timeout=2000 -c idle_in_transaction_session_timeout=10000",
    );
    expect(options).toMatchObject({
      connectionString: "postgres://x@y/z",
      max: 7,
      statement_timeout: 5000,
      query_timeout: 6000,
      connectionTimeoutMillis: 3000,
    });
  });
});
