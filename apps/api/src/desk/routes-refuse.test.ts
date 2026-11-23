import { describe, expect, it } from "vitest";
import {
  abilityOff,
  deskClosed,
  enrollmentInactive,
  handoverMode,
  heldAtDesk,
  notFound,
  notOperator,
  notReady,
  offerGone,
  pausedAtDesk,
  redeemPaused,
  reservationEnded,
  selfHandover,
} from "#src/auth/http-errors";
import type { DeskRefusal } from "#src/desk/desk";
import { refuse } from "#src/desk/routes";
import type { HttpError } from "#src/http-error";

const thrown = (run: () => unknown): HttpError => {
  try {
    run();
  } catch (error) {
    return error as HttpError;
  }
  throw new Error("nothing was thrown");
};

const CASES: ReadonlyArray<[DeskRefusal, HttpError, number]> = [
  [{ kind: "not_found" }, notFound(), 404],
  [{ kind: "not_in_event" }, notFound(), 404],
  [{ kind: "old_code" }, notFound(), 404],
  [{ kind: "not_operator" }, notOperator(), 403],
  [{ kind: "ability_off" }, abilityOff(), 403],
  [{ kind: "reservation_ended", status: "expired" }, reservationEnded({ status: "expired" }), 409],
  [
    { kind: "enrollment_inactive", reason: "banned" },
    enrollmentInactive({ reason: "banned" }),
    403,
  ],
  [{ kind: "self_handover" }, selfHandover(), 409],
  [{ kind: "handover_mode" }, handoverMode(), 409],
  [{ kind: "desk_closed" }, deskClosed(), 403],
  [{ kind: "offer_gone" }, offerGone(), 409],
  [{ kind: "not_ready" }, notReady(), 409],
  [{ kind: "held", hold: "paused" }, pausedAtDesk(), 409],
  [{ kind: "held", hold: "held" }, heldAtDesk(), 409],
  [{ kind: "redeem_paused" }, redeemPaused(), 403],
];

describe("refuse (the prize desk)", () => {
  it.each(CASES)("answers %j", (result, expected, status) => {
    const error = thrown(() => refuse(result));
    expect(error.status).toBe(expected.status);
    expect(error.status).toBe(status);
    expect(error.envelope).toEqual(expected.envelope);
  });

  it("tells a pause from a hold", () => {
    const paused = thrown(() => refuse({ kind: "held", hold: "paused" }));
    const held = thrown(() => refuse({ kind: "held", hold: "held" }));
    expect([paused.envelope.code, held.envelope.code]).toEqual(["paused", "held"]);
  });
});
