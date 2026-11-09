import { describe, expect, it } from "vitest";
import type { MessageKey } from "@questify/shared";
import { translatorFor } from "#src/lib/language.ts";
import { describeProblem, formatWait, type Problem } from "#src/lib/sign-in-errors.ts";

const en = translatorFor("en");
const ar = translatorFor("ar");
const MESSAGE = { ar: "رسالة الخادم.", en: "The server's message." };
const envelope = (code: unknown, details?: unknown, message: unknown = MESSAGE) => ({
  code,
  message,
  ...(details === undefined ? {} : { details }),
});

const NETWORK: Problem = { text: en("error.network"), restart: false };

describe("describeProblem, branch by branch", () => {
  const network: readonly [string, unknown][] = [
    ["null", null],
    ["a string", "oops"],
    ["a number", 7],
    ["an empty object", {}],
    ["no message", { code: "x" }],
    ["a message that is a string", envelope("x", undefined, "text")],
    ["a message that is null", envelope("x", undefined, null)],
    ["a message without the language", envelope("x", undefined, { ar: "فقط" })],
    ["a numeric message in the language", envelope("x", undefined, { en: 5 })],
    ["no code", { message: MESSAGE }],
    ["a numeric code", envelope(5)],
    ["a null code", envelope(null)],
  ];
  it.each(network)("gives the network text for %s", (_name, body) => {
    expect(describeProblem(body, "en", en)).toEqual(NETWORK);
  });

  it("gives the network text in the page's language", () => {
    expect(describeProblem(null, "ar", ar)).toEqual({ text: ar("error.network"), restart: false });
  });

  it("reads the message in the page's language", () => {
    expect(describeProblem(envelope("x"), "ar", ar)).toEqual({ text: MESSAGE.ar, restart: false });
    expect(describeProblem(envelope("x"), "en", en)).toEqual({ text: MESSAGE.en, restart: false });
  });

  const details: readonly [string, unknown, string[]][] = [
    ["no details", undefined, []],
    ["null details", null, []],
    ["string details", "x", []],
    ["empty details", {}, []],
    ["array details", [1], []],
    ["a wait of 90", { retryAfterSeconds: 90 }, [en("staff.tryAgainIn", { time: "1:30" })]],
    ["a wait of 0.5", { retryAfterSeconds: 0.5 }, [en("staff.tryAgainIn", { time: "0:01" })]],
    ["a wait of 0", { retryAfterSeconds: 0 }, []],
    ["a negative wait", { retryAfterSeconds: -5 }, []],
    ["a string wait", { retryAfterSeconds: "90" }, []],
    ["a null wait", { retryAfterSeconds: null }, []],
    ["2 attempts left", { attemptsLeft: 2 }, [en("staff.attemptsLeft", { count: 2 })]],
    ["0 attempts left", { attemptsLeft: 0 }, [en("staff.attemptsLeft", { count: 0 })]],
    ["a negative count", { attemptsLeft: -1 }, [en("staff.attemptsLeft", { count: -1 })]],
    ["a string count", { attemptsLeft: "2" }, []],
    [
      "both",
      { retryAfterSeconds: 61, attemptsLeft: 1 },
      [en("staff.tryAgainIn", { time: "1:01" }), en("staff.attemptsLeft", { count: 1 })],
    ],
    [
      "a zero wait and attempts",
      { retryAfterSeconds: 0, attemptsLeft: 3 },
      [en("staff.attemptsLeft", { count: 3 })],
    ],
  ];
  it.each(details)("adds the extras for %s", (_name, given, extra) => {
    expect(describeProblem(envelope("x", given), "en", en)).toEqual({
      text: [MESSAGE.en, ...extra].join(" "),
      restart: false,
    });
  });

  it.each(["challenge_expired", "resend_limit"])("restarts after %s", (code) => {
    expect(describeProblem(envelope(code), "en", en)).toEqual({ text: MESSAGE.en, restart: true });
  });
  it.each(["invalid_code", "resend_too_soon", "weak_password", "shop_window_locked", ""])(
    "does not restart after %j",
    (code) => {
      expect(describeProblem(envelope(code), "en", en).restart).toBe(false);
    },
  );

  const resend: readonly [string, unknown, number | undefined][] = [
    ["a wait of 41.2", { retryAfterSeconds: 41.2 }, 42],
    ["a wait of 60", { retryAfterSeconds: 60 }, 60],
    ["a wait of 0.1", { retryAfterSeconds: 0.1 }, 1],
    ["a wait of 0", { retryAfterSeconds: 0 }, undefined],
    ["a negative wait", { retryAfterSeconds: -2 }, undefined],
    ["a string wait", { retryAfterSeconds: "41" }, undefined],
    ["no wait", {}, undefined],
  ];
  it.each(resend)("hands over the resend wait for %s", (_name, given, seconds) => {
    const problem = describeProblem(envelope("resend_too_soon", given), "en", en);
    expect(problem.resendWaitSeconds).toBe(seconds);
    expect("resendWaitSeconds" in problem).toBe(seconds !== undefined);
    expect(problem.restart).toBe(false);
  });
  it("hands over a wait only for a resend refusal", () => {
    const problem = describeProblem(envelope("too_many", { retryAfterSeconds: 41.2 }), "en", en);
    expect("resendWaitSeconds" in problem).toBe(false);
  });

  const reasons: readonly [string, unknown, MessageKey | undefined][] = [
    ["weak_password", "too_short", "staff.weak.tooShort"],
    ["weak_password", "too_long", "staff.weak.tooLong"],
    ["weak_password", "same_as_email", "staff.weak.sameAsEmail"],
    ["weak_password", "context_word", "staff.weak.contextWord"],
    ["weak_password", "breached", "staff.weak.breached"],
    ["weak_password", "unknown", undefined],
    ["weak_password", undefined, undefined],
    ["weak_password", "shorter", undefined],
    ["shop_window_locked", "shorter", "rewards.windowLocked.shorter"],
    ["shop_window_locked", "closed", "rewards.windowLocked.closed"],
    ["shop_window_locked", "later", undefined],
    ["shop_window_locked", "too_short", undefined],
    ["other_code", "too_short", undefined],
    ["other_code", "shorter", undefined],
  ];
  it.each(reasons)("%s with the reason %s", (code, reason, key) => {
    const given = { reason, retryAfterSeconds: 90, attemptsLeft: 2 };
    for (const [language, t] of [
      ["en", en],
      ["ar", ar],
    ] as const) {
      const problem = describeProblem(envelope(code, given), language, t);
      if (key === undefined) {
        const extra = [
          t("staff.tryAgainIn", { time: formatWait(90) }),
          t("staff.attemptsLeft", { count: 2 }),
        ];
        expect(problem).toEqual({ text: [MESSAGE[language], ...extra].join(" "), restart: false });
      } else {
        expect(problem).toEqual({ text: t(key), restart: false });
      }
    }
  });
});
