import { randomUUID } from "node:crypto";
import { PLAYER_NOTE_MAX } from "@questify/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { PublicAccount } from "#src/auth/staff-store";
import { registerConsoleTierRoutes } from "#src/console/players/tiers";
import { registerConventions } from "#src/conventions";
import { MemoryIdempotencyStore } from "#src/idempotency-store";
import { fakePool } from "#test/support/fake-pool";

const ADMIN = "11111111-1111-4111-8111-111111111111";
const PLAYER = "22222222-2222-4222-8222-222222222222";
const ACTION = "33333333-3333-4333-8333-333333333333";
const TIERS = [{ achievementId: "events-attended", tier: "bronze" }];
const NOTE = "Shared answers with a second account.";
const REVOKE = { tiers: TIERS, reasonCode: "cheating", note: NOTE };
const RESTORE = { tiers: TIERS, reasonCode: "mistake", note: NOTE };

type Seen = { sql: string; values: readonly unknown[] };
let app: FastifyInstance;

/** The tier routes over a pool whose tier door answers `outcome` (and an action id when it is `changed`). */
function build(outcome = "changed") {
  const seen: Seen[] = [];
  const { pool } = fakePool((sql, values) => {
    if (!sql.includes("_tiers(")) {
      return { rows: [] };
    }
    seen.push({ sql, values });
    return { rows: [{ outcome, action_id: outcome === "changed" ? ACTION : null }] };
  });
  app = Fastify();
  registerConventions(app, {
    minAppVersion: "1.0.0",
    idempotencyStore: new MemoryIdempotencyStore(),
  });
  app.addHook("onRequest", async (request) => {
    request.staff = { account: { id: ADMIN } as PublicAccount, sessionId: "session-1" };
  });
  const keys = { userKey: () => Buffer.alloc(32, 7), contactThrottleKey: () => Buffer.alloc(32) };
  app.register(async (scope) => registerConsoleTierRoutes(scope, { pool, keys }), {
    prefix: "/v1/admin",
  });
  return { seen };
}

const send = (action: "revoke" | "restore", payload: unknown, player = PLAYER) =>
  app.inject({
    method: "POST",
    url: `/v1/admin/players/${player}/achievement-tiers/${action}`,
    headers: { "idempotency-key": randomUUID() },
    payload: payload as object,
  });

afterEach(async () => {
  await app.close();
});

describe("revoking and restoring a player's tiers", () => {
  it.each([
    ["revoke", REVOKE, "SELECT * FROM admin_revoke_tiers($1, $2, $3, $4, $5)"],
    ["restore", RESTORE, "SELECT * FROM admin_restore_tiers($1, $2, $3, $4, $5)"],
  ] as const)(
    "%s sends the player, tiers and reason to its own door",
    async (action, body, sql) => {
      const { seen } = build();
      const response = await send(action, body);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ actionId: ACTION });
      expect(seen).toEqual([
        {
          sql,
          values: [PLAYER, JSON.stringify(TIERS), body.reasonCode, NOTE, expect.any(String)],
        },
      ]);
    },
  );

  it.each([
    ["not_banned", "not_banned"],
    ["not_earned", "tier_not_earned"],
    ["already_revoked", "tier_already_revoked"],
    ["not_revoked", "tier_not_revoked"],
  ])("answers the door's %s as 409 %s", async (outcome, code) => {
    build(outcome);
    const response = await send("revoke", REVOKE);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code });
  });

  it("takes a note padded up to four times the longest, trimmed", async () => {
    const { seen } = build();
    const padded = `${NOTE}${" ".repeat(PLAYER_NOTE_MAX * 4 - NOTE.length)}`;
    expect((await send("revoke", { ...REVOKE, note: padded })).statusCode).toBe(200);
    const longest = "n".repeat(PLAYER_NOTE_MAX);
    expect((await send("revoke", { ...REVOKE, note: longest })).statusCode).toBe(200);
    expect(seen.map((query) => query.values[3])).toEqual([NOTE, longest]);
  });

  it("refuses a body longer than that, or a reason code over 32 characters, before the door", async () => {
    const { seen } = build();
    const tooLong = `${NOTE}${" ".repeat(PLAYER_NOTE_MAX * 4 + 1 - NOTE.length)}`;
    expect((await send("revoke", { ...REVOKE, note: tooLong })).statusCode).toBe(400);
    expect((await send("revoke", { ...REVOKE, reasonCode: "c".repeat(33) })).statusCode).toBe(400);
    expect(seen).toEqual([]);
  });

  it.each([
    ["no tiers", []],
    ["a repeated tier", [...TIERS, ...TIERS]],
    ["an unknown tier", [{ achievementId: "events-attended", tier: "platinum" }]],
  ])("refuses %s as invalid_player_action before the door", async (_label, tiers) => {
    const { seen } = build();
    const response = await send("revoke", { ...REVOKE, tiers });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "invalid_player_action" });
    expect(seen).toEqual([]);
  });

  it("refuses a player id that is not a uuid before the door", async () => {
    const { seen } = build();
    expect((await send("restore", RESTORE, "someone")).statusCode).toBe(400);
    expect(seen).toEqual([]);
  });
});
