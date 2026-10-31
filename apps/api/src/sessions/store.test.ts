import { describe, expect, it } from "vitest";
import { HttpError } from "#src/http-error";
import { deleteRaceRefusal, sessionRefusal } from "#src/sessions/store";

const foreignKey = Object.assign(new Error("violates foreign key"), { code: "23503" });

const thrownBy = (work: () => unknown): unknown => {
  try {
    work();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe("the session doors' refusals", () => {
  it("answers a foreign-key refusal as a paid session only at the delete door", () => {
    const answer = thrownBy(() => deleteRaceRefusal(foreignKey));
    expect(answer).toBeInstanceOf(HttpError);
    expect((answer as HttpError).status).toBe(409);
    expect((answer as HttpError).message).toContain("session_has_attendance");
    expect(thrownBy(() => sessionRefusal(foreignKey))).toBe(foreignKey);
  });

  it("leaves every other error to the caller", () => {
    const other = Object.assign(new Error("boom"), { code: "XX000" });
    expect(thrownBy(() => deleteRaceRefusal(other))).toBe(other);
  });
});
