import { MESSAGES } from "@questify/shared";
import { describe, expect, it } from "vitest";
import type { AuthedResult } from "#src/api/session.ts";
import type { Me, PlayerState } from "#src/auth/player-state.ts";
import {
  nameChangeAllowed,
  saveDisabled,
  saveProblem,
  signedInMe,
  usernameOf,
} from "#src/screens/edit-profile.ts";

const meWith = (fields: Partial<Me>): Me => ({ id: "p1", username: "sara", ...fields }) as Me;

const MES: readonly (Me | undefined)[] = [
  undefined,
  meWith({}),
  meWith({ username: "" }),
  meWith({ usernameChange: { allowed: true, nextChangeAt: null } }),
  meWith({ usernameChange: { allowed: false, nextChangeAt: "2026-12-01T00:00:00Z" } }),
];

const STATES: readonly PlayerState[] = [
  { status: "loading" },
  { status: "signed_out", ended: false },
  { status: "signed_in", me: undefined },
  ...MES.slice(1).map((me) => ({ status: "signed_in", me }) as PlayerState),
];

describe("edit profile helpers", () => {
  it("reads the player as the inline expressions did", () => {
    for (const state of STATES) {
      expect(signedInMe(state)).toBe(state.status === "signed_in" ? state.me : undefined);
    }
    for (const me of MES) {
      expect(usernameOf(me)).toBe(me?.username ?? "");
      expect(nameChangeAllowed(me)).toBe(me?.usernameChange?.allowed === true);
    }
  });

  it("turns Save off as the inline condition did, for every busy, lock, name and current name", () => {
    for (const me of MES.slice(1) as Me[]) {
      for (const busy of [true, false]) {
        for (const username of ["", " ", "sara", "sara ", "omar", " omar "]) {
          const old =
            busy ||
            me.usernameChange?.allowed !== true ||
            username === me.username ||
            username.trim() === "";
          const now = saveDisabled({
            busy,
            allowed: nameChangeAllowed(me),
            username,
            current: me.username,
          });
          expect(now).toBe(old);
        }
      }
    }
  });

  it("says the API's words for a refusal and the fixed words for anything else", () => {
    const words = { ar: "الاسم محجوز", en: "Name taken" };
    const answers: readonly AuthedResult[] = [
      { kind: "error", status: 409, code: "taken", message: words },
      { kind: "error", status: 500, code: "unknown", message: null },
      { kind: "network" },
      { kind: "signed_out" },
    ] as unknown as AuthedResult[];
    for (const answer of answers) {
      const old =
        answer.kind === "error" && answer.message !== null
          ? answer.message
          : MESSAGES["profile.saveFailed"];
      expect(saveProblem(answer)).toBe(old);
    }
    expect(saveProblem(answers[0] as AuthedResult)).toBe(words);
  });
});
