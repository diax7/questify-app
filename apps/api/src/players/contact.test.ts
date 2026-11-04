import { describe, expect, it, vi } from "vitest";
import { createAuthKeys } from "#src/auth/keys";
import type { AuthLog } from "#src/auth/sign-in";
import { confirmContactCode, requestContactCode } from "#src/players/contact";
import type { PlayerSignInDeps } from "#src/players/sign-in";
import { fakePool, type FakeAnswer } from "#test/support/fake-pool";

const PLAYER = "11111111-1111-4111-8111-111111111111";
const WINDOWS = "WITH ORDINALITY";

/** The answer of the send or failure windows' one read: `count` attempts in each, the oldest `retryAfter` s from leaving. */
const windowsAt =
  (count: number, retryAfter: number | null) =>
  (values: readonly unknown[]): FakeAnswer => ({
    rows: (values[0] as string[]).map(() => ({ count, retry_after: retryAfter })),
  });

const harness = (answer: (sql: string, values: readonly unknown[]) => FakeAnswer) => {
  const { pool, queries } = fakePool(answer);
  const send = vi.fn(() => Promise.resolve({ kind: "sent" } as const));
  const deps: PlayerSignInDeps = {
    pool,
    keys: createAuthKeys("k".repeat(40)),
    sms: { name: "stub", send },
    email: { name: "stub", send: () => Promise.resolve() },
  };
  const log = vi.fn<AuthLog>();
  const asker = { address: "203.0.113.9", userAgent: null, deviceId: undefined, log };
  return { deps, asker, log, queries, sms: send };
};

describe("changing a contact, seen from the database's answers", () => {
  it("refuses a code when the windows fill after the first look: logs why, opens nothing, gives the unit back", async () => {
    let reads = 0;
    const { deps, asker, log, queries, sms } = harness((sql, values) => {
      if (sql.includes("pg_try_advisory_xact_lock")) {
        return { rows: [{ locked: true }] };
      }
      if (sql.includes(WINDOWS)) {
        reads += 1;
        // The player's own window, then the lock-free look at the send windows: room. Under the lock: full.
        return reads < 3 ? windowsAt(0, null)(values) : windowsAt(999, 77)(values);
      }
      if (sql.includes("take_send_budget")) {
        return {
          rows: [{ outcome: "taken", stripe_key: Buffer.alloc(32, 1), taken_at: "2026-11-04+00" }],
        };
      }
      if (
        sql.startsWith("INSERT INTO auth_throttle") ||
        sql.startsWith("DELETE FROM auth_throttle")
      ) {
        return { rows: [] };
      }
      throw new Error(`unexpected statement: ${sql}`);
    });
    const result = await requestContactCode(
      deps,
      { playerId: PLAYER, channel: "phone", value: "+966551234567", lang: "en" },
      asker,
    );
    expect(result).toEqual({ kind: "throttled", retryAfterSeconds: 77 });
    expect(log.mock.calls).toEqual([
      ["player.throttled", expect.objectContaining({ step: "contact_code", channel: "phone" })],
    ]);
    expect(queries.some((sql) => sql.includes("start_contact_change"))).toBe(false);
    expect(queries.some((sql) => sql.startsWith("DELETE FROM auth_throttle"))).toBe(true);
    expect(sms).not.toHaveBeenCalled();
  });

  it("fails naming confirm_contact_change when it answers no row", async () => {
    const { deps, asker } = harness((sql, values) => {
      if (sql.includes(WINDOWS)) {
        return windowsAt(0, null)(values);
      }
      if (sql.includes("confirm_contact_change")) {
        return { rows: [] };
      }
      throw new Error(`unexpected statement: ${sql}`);
    });
    await expect(
      confirmContactCode(
        deps,
        {
          playerId: PLAYER,
          challengeToken: "t".repeat(32),
          code: "123456",
          lang: "en",
          requestId: "22222222-2222-4222-8222-222222222222",
        },
        asker,
      ),
    ).rejects.toThrow("confirm_contact_change returned no row.");
  });
});
