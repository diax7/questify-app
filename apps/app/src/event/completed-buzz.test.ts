import { beforeEach, describe, expect, it, vi } from "vitest";
import { completedBuzz } from "#src/event/completed-buzz.ts";

const haptics = vi.hoisted(() => ({
  impactAsync: vi.fn(async () => undefined),
  notificationAsync: vi.fn(async () => undefined),
}));

vi.mock("expo-haptics", () => ({
  impactAsync: haptics.impactAsync,
  notificationAsync: haptics.notificationAsync,
  ImpactFeedbackStyle: { Light: "light", Medium: "medium" },
  NotificationFeedbackType: { Success: "success", Error: "error" },
}));

beforeEach(() => {
  haptics.impactAsync.mockClear();
  haptics.notificationAsync.mockClear();
});

describe("completedBuzz", () => {
  it("is a Success notification for a completion that paid", async () => {
    await completedBuzz({ replayed: false, points: 10 });
    expect(haptics.notificationAsync).toHaveBeenCalledExactlyOnceWith("success");
    expect(haptics.impactAsync).not.toHaveBeenCalled();
  });

  it("is a Success notification for a replay that still paid", async () => {
    await completedBuzz({ replayed: true, points: 10 });
    expect(haptics.notificationAsync).toHaveBeenCalledExactlyOnceWith("success");
    expect(haptics.impactAsync).not.toHaveBeenCalled();
  });

  it("is a Success notification for a first completion worth nothing", async () => {
    await completedBuzz({ replayed: false, points: 0 });
    expect(haptics.notificationAsync).toHaveBeenCalledExactlyOnceWith("success");
    expect(haptics.impactAsync).not.toHaveBeenCalled();
  });

  it("is a Light tap for a replay that paid nothing", async () => {
    await completedBuzz({ replayed: true, points: 0 });
    expect(haptics.impactAsync).toHaveBeenCalledExactlyOnceWith("light");
    expect(haptics.notificationAsync).not.toHaveBeenCalled();
  });
});
