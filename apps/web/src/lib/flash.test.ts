import { describe, expect, it } from "vitest";
import { flashMinutesValid, flashStateOf, flashWindowValid } from "#src/lib/flash.ts";

const NOW = Date.parse("2030-11-01T10:00:00Z");
const quest = (fields: Partial<Parameters<typeof flashStateOf>[0]> = {}) => ({
  flash: true,
  visible: true,
  opensAt: "2030-11-01T09:50:00Z",
  closesAt: "2030-11-01T10:10:00Z",
  ...fields,
});

const window = (opensAt: string, closesAt: string, visible = true) =>
  flashWindowValid({ visible, opensAt, closesAt });

describe("a flash quest on the quest list (T-307)", () => {
  it("is a draft, scheduled, running or ended; nothing for another quest", () => {
    expect(flashStateOf(quest({ flash: false }), NOW)).toBeNull();
    expect(flashStateOf(quest({ visible: false }), NOW)).toBe("draft");
    expect(flashStateOf(quest({ opensAt: null }), NOW)).toBe("draft");
    expect(flashStateOf(quest({ opensAt: "2030-11-01T10:01:00Z" }), NOW)).toBe("scheduled");
    expect(flashStateOf(quest(), NOW)).toBe("running");
    expect(flashStateOf(quest({ closesAt: "2030-11-01T10:00:00Z" }), NOW)).toBe("ended");
  });

  it("launches for 1 to 1,440 whole minutes", () => {
    expect([0, 1, 1440, 1441, 1.5].map(flashMinutesValid)).toEqual([
      false,
      true,
      true,
      false,
      false,
    ]);
  });

  it("shows only with both times, 1 minute to 24 hours apart; a hidden draft needs none", () => {
    expect(window("", "", false)).toBe(true);
    expect(window("2030-11-01T10:00", "")).toBe(false);
    expect(window("2030-11-01T10:00", "2030-11-01T10:01")).toBe(true);
    expect(window("2030-11-01T10:00", "2030-11-02T10:00")).toBe(true);
    expect(window("2030-11-01T10:00", "2030-11-02T10:01")).toBe(false);
    expect(window("2030-11-01T10:00", "2030-11-01T10:00")).toBe(false);
  });
});
