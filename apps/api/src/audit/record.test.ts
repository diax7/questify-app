import { describe, expect, it } from "vitest";
import { assertAuditable, auditRow, recordAudit, type AuditEntry } from "#src/audit/record";

const ENTRY: AuditEntry = {
  actor: { type: "admin", id: "a1" },
  action: "event.update",
  target: { type: "event", id: "e1" },
  organizerId: "o1",
  eventId: "e1",
  before: { name: "A" },
  after: { name: "B" },
  requestId: "r1",
};

describe("auditRow", () => {
  it("lists the ten columns in insert order, with JSON before and after", () => {
    expect(auditRow(ENTRY)).toEqual([
      "admin",
      "a1",
      "o1",
      "e1",
      "event.update",
      "event",
      "e1",
      '{"name":"A"}',
      '{"name":"B"}',
      "r1",
    ]);
  });

  it("gives a system actor no id and leaves what is missing null", () => {
    expect(
      auditRow({ actor: { type: "system" }, action: "event.update", target: { type: "event" } }),
    ).toEqual(["system", null, null, null, "event.update", "event", null, null, null, null]);
  });
});

describe("assertAuditable", () => {
  it("checks the action first, so a bad action holding a secret names the action", () => {
    expect(() => assertAuditable({ ...ENTRY, action: "Bad", after: { token: "x" } })).toThrow(
      'Audit action "Bad" must be dotted lower-case words, like event.update.',
    );
  });

  it("names the secret key and never its value", () => {
    const entry = { ...ENTRY, after: { token: "s3cret" } };
    expect(() => assertAuditable(entry)).toThrow(
      'Audit entry event.update must not hold "token": no secrets or personal data.',
    );
    expect(() => assertAuditable(entry)).not.toThrow(/s3cret/);
  });
});

describe("recordAudit", () => {
  it("writes nothing when the entry is refused, and one insert otherwise", async () => {
    const calls: unknown[][] = [];
    const client = {
      query: async (...args: unknown[]) => {
        calls.push(args);
      },
    };
    await expect(
      recordAudit(client as never, { ...ENTRY, before: { password: "x" } }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
    await recordAudit(client as never, ENTRY);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toEqual(auditRow(ENTRY));
  });
});
