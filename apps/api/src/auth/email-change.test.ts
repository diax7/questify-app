import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  createEmailChange,
  mailApplied,
  stopLinkOf,
  type Applied,
  type EmailChangeDeps,
} from "#src/auth/email-change";
import { EmailSendError, type EmailMessage } from "#src/auth/email/sender";
import { createAuthKeys } from "#src/auth/keys";
import { GateBusyError, type VerifyGate } from "#src/auth/verify-gate";

const CHANGE = "6f1d2b3c-4a5e-4f60-8a71-92b3c4d5e6f7";
const STAFF = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const keys = createAuthKeys("k".repeat(40));
const VIEWED = {
  changeId: CHANGE,
  staffUserId: STAFF,
  newEmail: "fresh@mail.test",
  expiresAt: "2026-11-04T10:00:00.000Z",
  organizerName: "Najd",
};
const APPLIED = {
  outcome: "confirmed",
  changeId: CHANGE,
  oldEmail: "owner@najd.test",
  newEmail: "fresh@mail.test",
  appliesAt: "2026-11-04T10:00:00.000Z",
};

type Rows = Readonly<Record<"view" | "password" | "confirm" | "stop", unknown[]>>;

/** A pool whose one connection answers each door function with the rows given; every other statement gets none. */
function fakePool(rows: Partial<Rows>) {
  const query = vi.fn(async (sql: string, _values?: unknown[]) => {
    if (sql.includes("owner_email_view")) return { rows: rows.view ?? [] };
    if (sql.includes("password_hash")) return { rows: rows.password ?? [] };
    if (sql.includes("owner_email_confirm")) return { rows: rows.confirm ?? [] };
    if (sql.includes("owner_email_stop")) return { rows: rows.stop ?? [] };
    return { rows: [] };
  });
  const pool = { connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
  const callOf = (name: string) => query.mock.calls.find(([sql]) => sql.includes(name));
  const paramsOf = (name: string): unknown[] => callOf(name)?.[1] ?? [];
  return { pool, query, callOf, paramsOf };
}

const openGate: VerifyGate = { run: (work) => work() };

function setup(rows: Partial<Rows>, options: { failSend?: boolean; gate?: VerifyGate } = {}) {
  const db = fakePool(rows);
  const sent: EmailMessage[] = [];
  const send = vi.fn(async (message: EmailMessage) => {
    if (options.failSend === true) throw new EmailSendError("test", "down");
    sent.push(message);
  });
  const deps: EmailChangeDeps = {
    pool: db.pool,
    keys,
    email: { name: "test", send },
    gate: options.gate ?? openGate,
    dashboardOrigin: "https://dash.test",
  };
  const log = vi.fn();
  const caller = { address: "203.0.113.9", userAgent: null, log, requestId: "req-1" };
  return { ...db, deps, sent, send, log, caller, change: createEmailChange(deps) };
}

const confirmInput = { token: "t".repeat(43), code: "123456", password: null };
const events = (log: ReturnType<typeof vi.fn>) => log.mock.calls.map(([event]) => event);

describe("stopLinkOf", () => {
  it("opens the Arabic stop page by default and the asked language otherwise", () => {
    const deps = { keys, dashboardOrigin: "https://dash.test" };
    const token = keys.emailChangeToken(CHANGE, "stop");
    expect(stopLinkOf(deps, CHANGE)).toBe(`https://dash.test/ar/email-change/stop#token=${token}`);
    expect(stopLinkOf(deps, CHANGE, "en")).toBe(
      `https://dash.test/en/email-change/stop#token=${token}`,
    );
  });
});

describe("mailApplied", () => {
  it("mails the new address its sign-in email and the old one the masked address with Stop", async () => {
    const { deps, sent, log } = setup({});
    await mailApplied(deps, APPLIED, log);
    expect(sent.map((mail) => mail.to)).toEqual(["fresh@mail.test", "owner@najd.test"]);
    expect(sent[0]?.text).toContain("sign-in email is now fresh@mail.test");
    expect(sent[0]?.text).toContain("https://dash.test/en/sign-in");
    expect(sent[1]?.text).toContain("f•••@m•••.test");
    expect(sent[1]?.text).toContain(stopLinkOf(deps, CHANGE));
    expect(log).not.toHaveBeenCalled();
  });

  it("sends nothing when the change id or either address is missing", async () => {
    for (const missing of ["changeId", "oldEmail", "newEmail"] as const) {
      const { deps, send, log } = setup({});
      const partial: Applied = { ...APPLIED, [missing]: undefined };
      await mailApplied(deps, partial, log);
      expect(send, missing).not.toHaveBeenCalled();
    }
  });

  it("logs each failed notice by change id and error name, and still tries the other", async () => {
    const { deps, send, log } = setup({}, { failSend: true });
    await mailApplied(deps, APPLIED, log);
    expect(send).toHaveBeenCalledTimes(2);
    expect(log.mock.calls).toEqual([
      ["staff.email_change_notice_failed", { change: CHANGE, reason: "EmailSendError" }],
      ["staff.email_change_notice_failed", { change: CHANGE, reason: "EmailSendError" }],
    ]);
  });
});

describe("view", () => {
  it("answers undefined for an unknown link and the masked address for an open one", async () => {
    expect(await setup({}).change.view("t".repeat(43))).toBeUndefined();
    expect(await setup({ view: [{ r: null }] }).change.view("t".repeat(43))).toBeUndefined();
    expect(await setup({ view: [{ r: VIEWED }] }).change.view("t".repeat(43))).toEqual({
      organizerName: "Najd",
      newEmailMasked: "f•••@m•••.test",
      expiresAt: VIEWED.expiresAt,
    });
  });
});

describe("confirm", () => {
  it("answers invalid for an unknown link without asking the door", async () => {
    const { change, caller, callOf } = setup({});
    expect(await change.confirm(confirmInput, caller)).toEqual({ kind: "invalid" });
    expect(callOf("owner_email_confirm")).toBeUndefined();
  });

  it("answers invalid when the door returns no row or an unknown outcome", async () => {
    const empty = setup({ view: [{ r: VIEWED }] });
    expect(await empty.change.confirm(confirmInput, empty.caller)).toEqual({ kind: "invalid" });
    const odd = setup({ view: [{ r: VIEWED }], confirm: [{ r: { outcome: "odd" } }] });
    expect(await odd.change.confirm(confirmInput, odd.caller)).toEqual({ kind: "invalid" });
  });

  it("passes no password result, the code hash and the request id to the door", async () => {
    const { change, caller, paramsOf } = setup({ view: [{ r: VIEWED }] });
    await change.confirm(confirmInput, caller);
    const params = paramsOf("owner_email_confirm");
    expect(params[1]).toEqual(keys.emailChangeCodeHash(CHANGE, "123456"));
    expect(params.slice(2)).toEqual([null, "req-1"]);
    const anonymous = setup({ view: [{ r: VIEWED }] });
    await anonymous.change.confirm(confirmInput, { ...anonymous.caller, requestId: undefined });
    expect(anonymous.paramsOf("owner_email_confirm")[3]).toBeNull();
  });

  it("counts a password as wrong when the account is gone, after a dummy check", async () => {
    const { change, caller, paramsOf } = setup({ view: [{ r: VIEWED }] });
    await change.confirm({ ...confirmInput, password: "some password here" }, caller);
    expect(paramsOf("owner_email_confirm")[2]).toBe(false);
  });

  it("answers busy when the password gate is full and rethrows any other failure", async () => {
    const busy = setup(
      { view: [{ r: VIEWED }] },
      { gate: { run: () => Promise.reject(new GateBusyError()) } },
    );
    const withPassword = { ...confirmInput, password: "some password here" };
    expect(await busy.change.confirm(withPassword, busy.caller)).toEqual({ kind: "busy" });
    const broken = setup(
      { view: [{ r: VIEWED }] },
      { gate: { run: () => Promise.reject(new RangeError("boom")) } },
    );
    await expect(broken.change.confirm(withPassword, broken.caller)).rejects.toThrow("boom");
  });

  it("answers a wrong code with the attempts left and logs it by change id", async () => {
    const { change, caller, log } = setup({
      view: [{ r: VIEWED }],
      confirm: [{ r: { outcome: "wrong", attemptsLeft: 3 } }],
    });
    expect(await change.confirm(confirmInput, caller)).toEqual({ kind: "wrong", attemptsLeft: 3 });
    expect(log).toHaveBeenCalledWith("staff.email_change_wrong", {
      addr: expect.any(String),
      change: CHANGE,
    });
  });

  it("passes a locked change and a taken address through", async () => {
    for (const outcome of ["locked", "email_taken"]) {
      const { change, caller } = setup({ view: [{ r: VIEWED }], confirm: [{ r: { outcome } }] });
      expect(await change.confirm(confirmInput, caller)).toEqual({ kind: outcome });
    }
  });

  it("answers the applied address, else the one the link was for, and logs the outcome", async () => {
    const applied = setup({
      view: [{ r: VIEWED }],
      confirm: [{ r: { ...APPLIED, outcome: "confirmed", newEmail: "other@mail.test" } }],
    });
    expect(await applied.change.confirm(confirmInput, applied.caller)).toEqual({
      kind: "confirmed",
      email: "other@mail.test",
    });
    expect(applied.log).toHaveBeenCalledWith("staff.email_change_confirmed", {
      addr: expect.any(String),
      change: CHANGE,
    });
    const bare = setup({ view: [{ r: VIEWED }], confirm: [{ r: { outcome: "confirmed" } }] });
    expect(await bare.change.confirm(confirmInput, bare.caller)).toEqual({
      kind: "confirmed",
      email: "fresh@mail.test",
    });
    expect(bare.send).not.toHaveBeenCalled();
  });

  it("holds the change, mails the old address the masked address, time and Stop", async () => {
    const { change, caller, sent, deps, log } = setup({
      view: [{ r: VIEWED }],
      confirm: [{ r: { ...APPLIED, outcome: "held" } }],
    });
    expect(await change.confirm(confirmInput, caller)).toEqual({
      kind: "held",
      appliesAt: APPLIED.appliesAt,
    });
    expect(sent.map((mail) => mail.to)).toEqual(["owner@najd.test"]);
    expect(sent[0]?.text).toContain("will change to f•••@m•••.test");
    expect(sent[0]?.text).toContain(stopLinkOf(deps, CHANGE));
    expect(events(log)).toEqual(["staff.email_change_held"]);
  });

  it("answers a held change without its time as an empty time", async () => {
    const { change, caller } = setup({
      view: [{ r: VIEWED }],
      confirm: [{ r: { outcome: "held" } }],
    });
    expect(await change.confirm(confirmInput, caller)).toEqual({ kind: "held", appliesAt: "" });
  });

  it("mails no hold notice when the door's answer misses a field", async () => {
    for (const missing of ["changeId", "oldEmail", "newEmail", "appliesAt"] as const) {
      const answer = { ...APPLIED, outcome: "held", [missing]: undefined };
      const { change, caller, send, log } = setup({
        view: [{ r: VIEWED }],
        confirm: [{ r: answer }],
      });
      await change.confirm(confirmInput, caller);
      expect(send, missing).not.toHaveBeenCalled();
      expect(events(log), missing).toEqual(["staff.email_change_held"]);
    }
  });

  it("logs a failed hold or applied notice through the request's log", async () => {
    const held = setup(
      { view: [{ r: VIEWED }], confirm: [{ r: { ...APPLIED, outcome: "held" } }] },
      { failSend: true },
    );
    expect((await held.change.confirm(confirmInput, held.caller)).kind).toBe("held");
    expect(held.log).toHaveBeenCalledWith("staff.email_change_notice_failed", {
      addr: expect.any(String),
      change: CHANGE,
      reason: "EmailSendError",
    });
    const applied = setup(
      { view: [{ r: VIEWED }], confirm: [{ r: { ...APPLIED, outcome: "confirmed" } }] },
      { failSend: true },
    );
    await applied.change.confirm(confirmInput, applied.caller);
    expect(events(applied.log)).toEqual([
      "staff.email_change_confirmed",
      "staff.email_change_notice_failed",
      "staff.email_change_notice_failed",
    ]);
  });
});

describe("stop", () => {
  it("answers the door's outcome, none without a row, and logs it with the request id passed", async () => {
    const done = setup({ stop: [{ r: "stopped" }] });
    expect(await done.change.stop("t".repeat(43), done.caller)).toBe("stopped");
    expect(done.paramsOf("owner_email_stop")[1]).toBe("req-1");
    expect(done.log).toHaveBeenCalledWith("staff.email_change_stop", {
      addr: expect.any(String),
      outcome: "stopped",
    });
    const none = setup({});
    expect(await none.change.stop("t".repeat(43), none.caller)).toBe("none");
  });
});
