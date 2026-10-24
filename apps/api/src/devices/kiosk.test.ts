import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createAuthKeys } from "#src/auth/keys";
import type { Caller } from "#src/auth/sign-in";
import { kioskScan, type KioskDeps } from "#src/devices/kiosk";
import { createLiveCodeKey, createMyCodeKey, liveCode, myCode } from "#src/quests/qr";

const DEVICE = "11111111-1111-4111-8111-111111111111";
const PLAYER = "22222222-2222-4222-8222-222222222222";
const QUEST = "33333333-3333-4333-8333-333333333333";
const liveKey = createLiveCodeKey("l".repeat(40));
const myKey = createMyCodeKey("m".repeat(40));
const SUBJECT = { username: "sara", avatar: "fox" };

type Refusal = Readonly<{ code: string; detail?: string }>;
type Paid = Readonly<{
  completion_id: string;
  points: string;
  replayed: boolean;
  boosted: boolean;
}>;

/** A pool whose kiosk door answers `door` (a refusal is thrown); throttle reads always have room. */
function fakePool(door: Refusal | Paid) {
  const asked: string[] = [];
  const client = {
    query: async (sql: string) => {
      asked.push(sql);
      if (sql.includes("kiosk_complete_quest")) {
        if ("code" in door) {
          throw Object.assign(new Error("refused"), door);
        }
        return { rows: [door] };
      }
      if (sql.includes("kiosk_scan_subject")) {
        return { rows: [SUBJECT] };
      }
      if (sql.includes("pg_try_advisory_xact_lock")) {
        return { rows: [{ locked: true }] };
      }
      if (sql.includes("FROM auth_throttle")) {
        return { rows: [{ count: 0, retry_after: null }] };
      }
      return { rows: [] };
    },
    release: () => undefined,
  };
  return { pool: { connect: async () => client } as unknown as Pool, asked };
}

function scan(
  door: Refusal | Paid,
  request: Readonly<{ code?: string; questId?: string | null }> = {},
) {
  const { pool, asked } = fakePool(door);
  const afterCompletion = vi.fn(async () => null);
  const log = vi.fn();
  const deps: KioskDeps = {
    pool,
    liveKey,
    myKey,
    keys: createAuthKeys("k".repeat(40)),
    settings: { forEvent: async () => ({ kind: "ok", config: { features: {} } }) as never },
    ranking: { afterCompletion },
  };
  const caller: Caller = { address: "198.51.100.7", userAgent: null, log };
  const answer = kioskScan(
    deps,
    {
      deviceId: DEVICE,
      questId: request.questId === undefined ? QUEST : request.questId,
      code: request.code ?? liveCode(liveKey, PLAYER, 1000),
      idempotencyKey: "44444444-4444-4444-8444-444444444444",
    },
    caller,
    { header: () => undefined },
  );
  return { answer, asked, afterCompletion, log };
}

describe("kioskScan's refusals (T-309b, ADR-244)", () => {
  it.each([
    [{ code: "DV403" }, "paused"],
    [{ code: "OY409" }, "self_scan"],
    [{ code: "QV422", detail: "expired" }, "expired"],
    [{ code: "QV422", detail: "method_off" }, "method_off"],
    [{ code: "QC404" }, "not_in_event"],
    [{ code: "QC403", detail: "banned" }, "not_open"],
    [{ code: "QN403", detail: "left" }, "not_open"],
    [{ code: "QP403" }, "not_open"],
  ])("answers %o as red %s, naming no one", async (refusal, reason) => {
    const { answer, asked } = scan(refusal);
    await expect(answer).resolves.toEqual({ result: "refused", reason });
    expect(asked.some((sql) => sql.includes("kiosk_scan_subject"))).toBe(false);
  });

  it("logs the reason, and the door's detail only when it gave one", async () => {
    const paused = scan({ code: "DV403" });
    await paused.answer;
    expect(paused.log).toHaveBeenCalledWith("kiosk.scan_refused", { reason: "paused" });
    const expired = scan({ code: "QV422", detail: "expired" });
    await expired.answer;
    expect(expired.log).toHaveBeenCalledWith("kiosk.scan_refused", {
      reason: "expired",
      detail: "expired",
    });
    const operator = scan({ code: "QP403" });
    await operator.answer;
    expect(operator.log).toHaveBeenCalledWith("kiosk.scan_refused", {
      reason: "not_open",
      detail: "operator_not_playing",
    });
  });

  it("answers orange with who was scanned when the quest is already done", async () => {
    const { answer } = scan({ code: "QD409" });
    await expect(answer).resolves.toEqual({ result: "already_completed", player: SUBJECT });
  });

  it("throws device_unpaired and idempotency_key_reused as HTTP answers, anything else as it is", async () => {
    await expect(scan({ code: "DV401" }).answer).rejects.toMatchObject({
      status: 401,
      envelope: { code: "device_unpaired" },
    });
    await expect(scan({ code: "QK422" }).answer).rejects.toMatchObject({
      status: 422,
      envelope: { code: "idempotency_key_reused" },
    });
    await expect(scan({ code: "XX000" }).answer).rejects.toThrow("refused");
  });
});

describe("kioskScan's codes", () => {
  it("refuses the fixed My QR as needs_live_code and logs why", async () => {
    const { answer, log } = scan({ code: "XX000" }, { code: myCode(myKey, PLAYER, 1) });
    await expect(answer).resolves.toEqual({ result: "refused", reason: "needs_live_code" });
    expect(log).toHaveBeenCalledWith("kiosk.scan_refused", { reason: "needs_live_code" });
  });

  it("refuses anything else as invalid_code and logs its problem", async () => {
    const { answer, log } = scan({ code: "XX000" }, { code: "not a questify code" });
    await expect(answer).resolves.toEqual({ result: "refused", reason: "invalid_code" });
    expect(log).toHaveBeenCalledWith("kiosk.scan_refused", {
      reason: "invalid_code",
      problem: "not_questify",
    });
  });
});

describe("kioskScan's green answer", () => {
  const paid = { completion_id: "c1", points: "10", replayed: false, boosted: true };

  it("pays, moves the ranking and logs the quest", async () => {
    const { answer, afterCompletion, log } = scan(paid);
    await expect(answer).resolves.toEqual({
      result: "completed",
      player: SUBJECT,
      points: 10,
      boosted: true,
      replayed: false,
    });
    expect(afterCompletion).toHaveBeenCalledWith(PLAYER, "c1");
    expect(log).toHaveBeenCalledWith("kiosk.scan_completed", { questId: QUEST, replayed: "false" });
  });

  it("leaves the ranking alone on a replay", async () => {
    const { answer, afterCompletion, log } = scan({ ...paid, replayed: true }, { questId: null });
    await expect(answer).resolves.toMatchObject({ result: "completed", replayed: true });
    expect(afterCompletion).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("kiosk.scan_completed", { questId: "", replayed: "true" });
  });
});
