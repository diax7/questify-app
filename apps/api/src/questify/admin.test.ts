import { describe, expect, it } from "vitest";
import { HttpError } from "#src/http-error";
import { refusalOf } from "#src/questify/admin";

const answerOf = (error: unknown) => {
  try {
    refusalOf(error);
  } catch (thrown) {
    return thrown;
  }
  throw new Error("refusalOf returned");
};

describe("the console Questify doors' refusals (T-403b)", () => {
  it.each([
    [{ code: "42501" }, 404, "not_found", {}],
    [{ code: "QY404" }, 404, "not_found", {}],
    [{ code: "QY409", detail: "frozen" }, 409, "questify_conflict", { reason: "frozen" }],
    [{ code: "QY422", detail: "campaignId" }, 422, "invalid_questify", { field: "campaignId" }],
    [{ code: "23514" }, 422, "invalid_questify", {}],
  ])("answers %o as %i %s", (error, status, code, details) => {
    const answer = answerOf(error);
    expect(answer).toBeInstanceOf(HttpError);
    expect(answer).toMatchObject({ status, envelope: { code, details } });
  });

  it("rethrows anything else unchanged", () => {
    const fault = Object.assign(new Error("deadlock detected"), { code: "40P01" });
    expect(answerOf(fault)).toBe(fault);
  });
});
