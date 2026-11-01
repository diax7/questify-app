import { describe, expect, it } from "vitest";
import { EXPORT_LIMITS, createExportGate } from "#src/analytics/export-gate";

describe("the export gate", () => {
  it("gives an event's slot to one export at a time, and back when it ends", () => {
    const gate = createExportGate();
    const release = gate.claim("org", "event");
    expect(release).toBeTypeOf("function");
    expect(gate.claim("org", "event")).toBeUndefined();
    expect(gate.claim("org", "other-event")).toBeTypeOf("function");
    expect(gate.claim("other-org", "event")).toBeTypeOf("function");
    release?.();
    expect(gate.claim("org", "event")).toBeTypeOf("function");
  });

  it("does not let a stale release free a slot that was taken again", () => {
    let clock = 0;
    const gate = createExportGate(() => clock);
    const stale = gate.claim("org", "event");
    clock += EXPORT_LIMITS.claimMs + 1;
    const fresh = gate.claim("org", "event");
    expect(fresh).toBeTypeOf("function");
    stale?.();
    expect(gate.claim("org", "event")).toBeUndefined();
  });

  it("frees the slot of an export that never ended after the claim time", () => {
    let clock = 0;
    const gate = createExportGate(() => clock);
    gate.claim("org", "event");
    clock += EXPORT_LIMITS.claimMs - 1;
    expect(gate.claim("org", "event")).toBeUndefined();
    clock += 2;
    expect(gate.claim("org", "event")).toBeTypeOf("function");
  });

  it("admits a staff member's starts up to the limit, then says how long to wait", () => {
    let clock = 1_000_000;
    const gate = createExportGate(() => clock);
    for (let i = 0; i < EXPORT_LIMITS.perStaff; i += 1) {
      expect(gate.admit("staff").admitted).toBe(true);
      clock += 1000;
    }
    const refused = gate.admit("staff");
    expect(refused).toEqual({
      admitted: false,
      retryAfterSeconds: Math.ceil((EXPORT_LIMITS.windowMs - EXPORT_LIMITS.perStaff * 1000) / 1000),
    });
    expect(gate.admit("someone else").admitted).toBe(true);
  });

  it("admits again once the oldest start leaves the window", () => {
    let clock = 0;
    const gate = createExportGate(() => clock);
    for (let i = 0; i < EXPORT_LIMITS.perStaff; i += 1) gate.admit("staff");
    expect(gate.admit("staff").admitted).toBe(false);
    clock += EXPORT_LIMITS.windowMs + 1;
    expect(gate.admit("staff").admitted).toBe(true);
  });

  it("gives a refunded start back to the allowance", () => {
    const gate = createExportGate(() => 0);
    const starts = Array.from({ length: EXPORT_LIMITS.perStaff }, () => gate.admit("staff"));
    expect(gate.admit("staff").admitted).toBe(false);
    const last = starts[starts.length - 1];
    if (last?.admitted !== true) throw new Error("the last start was admitted");
    last.refund();
    last.refund();
    expect(gate.admit("staff").admitted).toBe(true);
    expect(gate.admit("staff").admitted).toBe(false);
  });
});
