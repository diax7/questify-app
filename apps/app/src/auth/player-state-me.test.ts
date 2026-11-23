import { describe, expect, it } from "vitest";
import type { ApiResult } from "#src/api/client.ts";
import { meOf } from "#src/auth/player-state.ts";

const headers = new Headers();
const ok = (body: unknown): ApiResult => ({ kind: "ok", status: 200, body, headers });
const ME = {
  id: "p1",
  username: "falcon",
  avatar: "falcon",
  legal: { toAccept: [], guidelinesAccepted: true },
  identifiers: { phone: null, email: null },
};

describe("meOf", () => {
  it("has no profile for an answer that is not one", () => {
    expect(meOf({ kind: "network" })).toBeUndefined();
    expect(meOf({ kind: "signed_out" })).toBeUndefined();
    expect(meOf(ok({ ...ME, legal: { toAccept: "terms" } }))).toBeUndefined();
    expect(meOf(ok({ ...ME, id: 1 }))).toBeUndefined();
  });

  it("keeps the profile and reads its level, equipment and streak", () => {
    const me = meOf(ok({ ...ME, dailyStreak: "broken" }));
    expect(me).toMatchObject(ME);
    expect(me).toHaveProperty("questify");
    expect(me).toHaveProperty("equipment");
    expect(me?.dailyStreak).toBeNull();
  });
});
