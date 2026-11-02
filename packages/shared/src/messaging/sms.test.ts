import { describe, expect, it } from "vitest";
import { smsParts } from "#src/messaging/sms";

describe("smsParts", () => {
  it("counts GSM-7 septets: 160 alone, 153 a part, extended characters twice", () => {
    expect(smsParts("a".repeat(160))).toBe(1);
    expect(smsParts("a".repeat(161))).toBe(2);
    expect(smsParts("a".repeat(306))).toBe(2);
    expect(smsParts("a".repeat(307))).toBe(3);
    expect(smsParts("[".repeat(80))).toBe(1);
    expect(smsParts("[".repeat(81))).toBe(2);
  });

  it("counts UCS-2 units for anything else: 70 alone, 67 a part", () => {
    expect(smsParts("ع".repeat(70))).toBe(1);
    expect(smsParts("ع".repeat(71))).toBe(2);
    expect(smsParts("ع".repeat(201))).toBe(3);
    expect(smsParts("ع".repeat(202))).toBe(4);
    expect(smsParts(`${"a".repeat(60)}ع`)).toBe(1);
  });
});
