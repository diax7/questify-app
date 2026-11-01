import { describe, expect, it } from "vitest";
import { refusalError } from "#src/desk/sale";

const seen = (refusal: string, seat: "player" | "desk") => {
  const error = refusalError(refusal, seat);
  return [error.status, error.envelope.code, error.envelope.details];
};

/** A Pay's stored refusal (migration 0107) as the HTTP error each seat is given (T-612). */
describe("refusalError", () => {
  it.each([
    ["RO409", [409, "sold_out", {}]],
    ["RB422", [422, "not_enough_balance", {}]],
    ["RL409:2", [409, "reward_limit_reached", { limit: 2 }]],
    ["RW403:ended", [403, "reward_not_open", { reason: "ended" }]],
    ["RS403:feature_off", [403, "feature_off", {}]],
    ["RS403:desk_closed", [403, "desk_closed", {}]],
    ["RS403:closed", [403, "shop_closed", { reason: "closed" }]],
    ["DS409:price_changed", [409, "price_changed", {}]],
    ["DS409:reservation_on", [409, "reservation_on", {}]],
    ["DS409:desk_busy", [409, "desk_busy", {}]],
    ["DS410:expired", [410, "sale_gone", {}]],
    ["DS422:not_desk_reward", [422, "not_desk_reward", {}]],
    ["RA403:removed", [403, "enrollment_inactive", { reason: "removed" }]],
    ["QP403", [403, "enrollment_inactive", { reason: "operator_not_playing" }]],
    ["RP403", [403, "redeem_paused", {}]],
    ["RN404", [404, "not_found", {}]],
    ["OP403", [403, "not_operator", {}]],
    ["OA403", [403, "ability_off", {}]],
    ["OY409", [409, "self_handover", {}]],
    ["RK422", [422, "idempotency_key_reused", {}]],
    ["ZZ999", [410, "sale_gone", {}]],
  ] as const)("answers %s as %j", (refusal, expected) => {
    expect(seen(refusal, "player")).toEqual(expected);
  });

  it("tells the player nothing about a flag hold, and the desk that it is held", () => {
    expect(seen("RH409:held", "player")).toEqual([410, "sale_gone", {}]);
    expect(seen("RH409:held", "desk")).toEqual([409, "held", {}]);
    expect(seen("RH409:paused", "player")).toEqual([403, "redeem_paused", {}]);
    expect(seen("RH409:paused", "desk")).toEqual([409, "paused", {}]);
  });
});
