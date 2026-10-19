import { describe, expect, it } from "vitest";
import { apiError } from "./errors";

const message = { ar: "الحدث ممتلئ", en: "The event is full" };

describe("apiError", () => {
  it("builds the one error envelope used by every route", () => {
    expect(apiError("event_full", message)).toEqual({
      code: "event_full",
      message,
      details: {},
    });
  });

  it("keeps details when given", () => {
    expect(apiError("rate_limited", message, { retryAfterSeconds: 30 }).details).toEqual({
      retryAfterSeconds: 30,
    });
  });

  it.each(["Event_Full", "event-full", "", "1event", "event full"])(
    "rejects the machine code %j",
    (code) => {
      expect(() => apiError(code, message)).toThrow(/lower snake case/);
    },
  );

  it.each([
    { ar: "", en: "The event is full" },
    { ar: "   ", en: "The event is full" },
    { ar: "الحدث ممتلئ", en: "  " },
  ])("rejects a message missing a language %j", (bad) => {
    expect(() => apiError("event_full", bad)).toThrow(/non-empty Arabic and English/);
  });
});
