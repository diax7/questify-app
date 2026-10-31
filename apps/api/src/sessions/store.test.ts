import { MESSAGES } from "@questify/shared";
import { describe, expect, it } from "vitest";
import { featureOff, notEnrolled, notFound, notOperator } from "#src/auth/http-errors";
import { HttpError } from "#src/http-error";
import { deleteRaceRefusal, sessionError, sessionRefusal } from "#src/sessions/store";
import { pgError } from "#test/support/fake-pool";

const foreignKey = Object.assign(new Error("violates foreign key"), { code: "23503" });

const thrownBy = (work: () => unknown): unknown => {
  try {
    work();
  } catch (error) {
    return error;
  }
  return undefined;
};

const refusedWith = (fields: Record<string, string>): HttpError =>
  thrownBy(() => sessionRefusal(pgError(fields))) as HttpError;

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
    expect(thrownBy(() => sessionRefusal(other))).toBe(other);
    const noCode = new Error("no sqlstate");
    expect(thrownBy(() => sessionRefusal(noCode))).toBe(noCode);
  });

  it.each([
    ["AN404", undefined, notFound()],
    ["SS404", undefined, notFound()],
    ["AM403", undefined, notEnrolled()],
    ["OP403", undefined, notOperator()],
    ["AG403", "feature_off", featureOff()],
    [
      "PS422",
      "endsAt:before_start",
      sessionError(422, "invalid_session", { issue: "endsAt:before_start" }),
    ],
    ["PE409", undefined, sessionError(409, "session_event_closed")],
    ["PT409", undefined, sessionError(409, "session_nobody")],
    ["PL429", "hour", sessionError(429, "session_message_limit", { window: "hour" })],
  ])("maps %s to its status, code, message and details", (code, detail, expected) => {
    const answer = refusedWith(detail === undefined ? { code } : { code, detail });
    expect(answer.status).toBe(expected.status);
    expect(answer.envelope).toEqual(expected.envelope);
  });

  it("carries the registered number of a seat count below it", () => {
    const answer = refusedWith({ code: "PS409", detail: "seats_below:12" });
    expect(answer.status).toBe(409);
    expect(answer.envelope).toMatchObject({
      code: "session_seats_below",
      message: MESSAGES["error.sessionSeatsBelow"],
      details: { registered: 12 },
    });
  });

  it.each([
    "has_registrations",
    "has_attendance",
    "limit",
    "not_required",
    "closed",
    "full",
    "started",
    "checked_in",
  ])("names the %s conflict with its own message", (name) => {
    const answer = refusedWith({ code: "PS409", detail: name });
    expect(answer.status).toBe(409);
    expect(answer.envelope.code).toBe(`session_${name}`);
    expect(answer.envelope.message).not.toEqual(MESSAGES["error.sessionInvalid"]);
  });

  it.each([undefined, "", "something_new", "seats_below_x"])(
    "answers a conflict it does not know (%j) as an invalid session",
    (detail) => {
      const answer = refusedWith(
        detail === undefined ? { code: "PS409" } : { code: "PS409", detail },
      );
      expect(answer.status).toBe(409);
      expect(answer.envelope).toMatchObject({
        code: "invalid_session",
        message: MESSAGES["error.sessionInvalid"],
      });
    },
  );

  it("words an error code the table does not hold as an invalid session", () => {
    const answer = sessionError(500, "not_in_the_table");
    expect(answer.envelope).toMatchObject({
      code: "not_in_the_table",
      message: MESSAGES["error.sessionInvalid"],
    });
    expect(sessionError(409, "session_full").envelope.message).toEqual(
      MESSAGES["error.sessionFull"],
    );
  });
});
