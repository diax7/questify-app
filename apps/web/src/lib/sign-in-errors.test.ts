import { describe, expect, it } from "vitest";
import { translatorFor } from "#src/lib/language.ts";
import { describeProblem, formatWait } from "#src/lib/sign-in-errors.ts";

const envelope = (code: string, details: Record<string, unknown> = {}) => ({
  code,
  message: { ar: "رسالة الخادم.", en: "The server's message." },
  details,
});

describe("formatWait", () => {
  it("shows minutes and two-digit seconds, rounding up", () => {
    expect(formatWait(59)).toBe("0:59");
    expect(formatWait(60)).toBe("1:00");
    expect(formatWait(900)).toBe("15:00");
    expect(formatWait(4.2)).toBe("0:05");
    expect(formatWait(-3)).toBe("0:00");
  });
});

describe("describeProblem", () => {
  it("uses the API's own wording in the page's language", () => {
    expect(describeProblem(envelope("invalid_credentials"), "ar", translatorFor("ar"))).toEqual({
      text: "رسالة الخادم.",
      restart: false,
    });
    expect(describeProblem(envelope("invalid_credentials"), "en", translatorFor("en")).text).toBe(
      "The server's message.",
    );
  });

  it("adds the wait and the attempts left from the details", () => {
    expect(
      describeProblem(
        envelope("too_many_attempts", { retryAfterSeconds: 75 }),
        "en",
        translatorFor("en"),
      ).text,
    ).toBe("The server's message. Try again in 1:15.");
    expect(
      describeProblem(envelope("invalid_code", { attemptsLeft: 2 }), "ar", translatorFor("ar"))
        .text,
    ).toBe("رسالة الخادم. المحاولات المتبقية: 2");
  });

  it("hands the resend wait to the countdown only when the API refuses a resend", () => {
    const t = translatorFor("en");
    expect(
      describeProblem(envelope("resend_too_soon", { retryAfterSeconds: 41.2 }), "en", t)
        .resendWaitSeconds,
    ).toBe(42);
    expect(
      describeProblem(envelope("too_many_attempts", { retryAfterSeconds: 90 }), "en", t)
        .resendWaitSeconds,
    ).toBeUndefined();
    expect(describeProblem(envelope("resend_too_soon"), "en", t).resendWaitSeconds).toBeUndefined();
  });

  it("sends the person back to the first step when the code can no longer work", () => {
    for (const code of ["challenge_expired", "resend_limit"]) {
      expect(describeProblem(envelope(code), "en", translatorFor("en")).restart).toBe(true);
    }
    expect(describeProblem(envelope("invalid_code"), "en", translatorFor("en")).restart).toBe(
      false,
    );
  });

  it("falls back to the network text for anything that is not the API's error body", () => {
    for (const body of [
      undefined,
      null,
      "<html>",
      { code: "x" },
      { message: { en: "only one" } },
    ]) {
      expect(describeProblem(body, "en", translatorFor("en"))).toEqual({
        text: translatorFor("en")("error.network"),
        restart: false,
      });
    }
  });
});
