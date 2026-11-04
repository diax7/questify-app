import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MESSAGES } from "@questify/shared";
import { describe, expect, it } from "vitest";

/** The screens where a player types a code that proves who they are: signing in and changing the phone or email. */
const CODE_SCREENS = ["sign-in.tsx", "account.tsx"];

/** The text of one screen's `CodeStep` function, up to the next top-level function. */
function codeStepOf(screen: string): string {
  const text = readFileSync(join(import.meta.dirname, "..", "..", "app", screen), "utf8");
  const start = text.indexOf("function CodeStep(");
  expect(start, `${screen} has a CodeStep`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("\nfunction ", start + 1);
  return text.slice(start, end === -1 ? undefined : end);
}

describe("the notice under the code field (ASVS V6.6.1)", () => {
  it("tells the person in both languages never to share the code, because Questify never asks for it", () => {
    const notice = MESSAGES["signIn.codeNeverShare"];
    expect(notice.en).toBe("Never share this code. Questify will never ask you for it.");
    expect(notice.ar).toContain("لا تشارك رمزك مع أحد");
    expect(notice.ar).toContain("Questify");
    expect(notice.ar).toContain("أبدًا");
  });

  it.each(CODE_SCREENS)("is shown on the code step of %s", (screen) => {
    expect(codeStepOf(screen)).toContain('t("signIn.codeNeverShare")');
  });
});
