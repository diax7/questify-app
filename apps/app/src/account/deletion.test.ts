import { MESSAGES } from "@questify/shared";
import { describe, expect, it } from "vitest";
import type { ApiRequest } from "#src/api/client.ts";
import type { AuthedResult } from "#src/api/session.ts";
import {
  confirmDeletion,
  pendingOf,
  requestDeletionCode,
  verifyDeletionCode,
} from "#src/account/deletion-api.ts";
import {
  START,
  canDelete,
  deletionStep,
  type DeletionState,
  type PendingPrize,
} from "#src/account/deletion-flow.ts";

const headers = new Headers();
const MESSAGE = { ar: "رسالة", en: "Message" };
const ok = (body: unknown, status = 200): AuthedResult => ({ kind: "ok", status, body, headers });
const fail = (
  status: number,
  code: string,
  details: Record<string, unknown> = {},
): AuthedResult => ({
  kind: "error",
  status,
  code,
  message: MESSAGE,
  details,
  headers,
});

function setup(answer: AuthedResult) {
  const calls: Omit<ApiRequest, "accessToken">[] = [];
  const deps = {
    session: {
      request: async (request: Omit<ApiRequest, "accessToken">) => {
        calls.push(request);
        return answer;
      },
    },
  };
  return { deps, calls };
}

const PRIZE: PendingPrize = {
  redemptionId: "r1",
  event: { ar: "مهرجان", en: "Fest" },
  item: { ar: null, en: "Spa" },
  rankPrize: false,
};
const CODE: DeletionState = {
  step: "code",
  challengeToken: "c1",
  attemptsLeft: null,
  problem: null,
};
const CONFIRM: DeletionState = {
  step: "confirm",
  deletionToken: "d1",
  pending: [PRIZE],
  forfeit: false,
  problem: null,
};

describe("the deletion requests", () => {
  it("asks for a code to the account's own contact and carries the challenge", async () => {
    const { deps, calls } = setup(ok({ challengeToken: "c1", expiresInSeconds: 300 }, 202));
    expect(await requestDeletionCode(deps, { channel: "phone", lang: "ar" })).toEqual({
      type: "code_sent",
      challengeToken: "c1",
    });
    expect(calls).toEqual([
      { method: "POST", path: "/v1/me/deletion/code", body: { channel: "phone", lang: "ar" } },
    ]);
  });

  it("says why a code could not be sent, offline or signed out included", async () => {
    expect(
      await requestDeletionCode(setup(fail(503, "sms_unavailable")).deps, {
        channel: "phone",
        lang: "en",
      }),
    ).toEqual({ type: "refused", problem: MESSAGE });
    expect(
      await requestDeletionCode(setup({ kind: "network" }).deps, {
        channel: "phone",
        lang: "en",
      }),
    ).toEqual({ type: "refused", problem: MESSAGES["signIn.offline"] });
    expect(
      await requestDeletionCode(setup({ kind: "signed_out" }).deps, {
        channel: "phone",
        lang: "en",
      }),
    ).toEqual({
      type: "refused",
      problem: MESSAGES["signIn.sessionEnded"],
    });
  });

  it("turns a right code into the token and the waiting prizes; a wrong one into the attempts left", async () => {
    const right = setup(
      ok({ deletionToken: "d1", expiresInSeconds: 600, pending: [PRIZE, { bad: true }] }),
    );
    expect(await verifyDeletionCode(right.deps, { challengeToken: "c1", code: "123456" })).toEqual({
      type: "verified",
      deletionToken: "d1",
      pending: [PRIZE],
    });
    expect(right.calls[0]).toMatchObject({
      path: "/v1/deletion/verify",
      body: { challengeToken: "c1", code: "123456" },
    });
    expect(
      await verifyDeletionCode(setup(fail(422, "invalid_code", { attemptsLeft: 1 })).deps, {
        challengeToken: "c1",
        code: "000000",
      }),
    ).toEqual({ type: "wrong_code", attemptsLeft: 1, problem: MESSAGE });
    expect(
      await verifyDeletionCode(setup(fail(410, "deletion_expired")).deps, {
        challengeToken: "c1",
        code: "1",
      }),
    ).toEqual({ type: "start_again", problem: MESSAGE });
  });

  it("deletes on 204, lists prizes that became pending, and starts again on an ended token", async () => {
    const done = setup(ok(undefined, 204));
    expect(await confirmDeletion(done.deps, { deletionToken: "d1", forfeit: true })).toEqual({
      type: "erased",
    });
    expect(done.calls[0]).toMatchObject({
      path: "/v1/deletion/confirm",
      body: { deletionToken: "d1", forfeit: true },
    });
    expect(
      await confirmDeletion(setup(fail(409, "handover_pending", { pending: [PRIZE] })).deps, {
        deletionToken: "d1",
        forfeit: false,
      }),
    ).toEqual({ type: "pending", pending: [PRIZE], problem: MESSAGE });
    expect(
      await confirmDeletion(setup(fail(410, "deletion_expired")).deps, {
        deletionToken: "d1",
        forfeit: false,
      }),
    ).toEqual({ type: "start_again", problem: MESSAGE });
  });

  it("reads only well-formed prizes", () => {
    expect(pendingOf(null)).toEqual([]);
    expect(pendingOf([{ redemptionId: "r2", event: "x", item: { en: 3 } }])).toEqual([
      {
        redemptionId: "r2",
        event: { ar: null, en: null },
        item: { ar: null, en: null },
        rankPrize: false,
      },
    ]);
  });
});

describe("the deletion steps", () => {
  it("goes from what is deleted, to the code, to the confirmation, to done", () => {
    const code = deletionStep(START, { type: "code_sent", challengeToken: "c1" });
    expect(code).toEqual(CODE);
    const confirm = deletionStep(code, { type: "verified", deletionToken: "d1", pending: [] });
    expect(confirm).toMatchObject({ step: "confirm", pending: [], forfeit: false });
    expect(canDelete(confirm)).toBe(true);
    expect(deletionStep(confirm, { type: "erased" })).toEqual({ step: "done" });
  });

  it("needs the player to give up a waiting prize before deleting", () => {
    expect(canDelete(CONFIRM)).toBe(false);
    const ticked = deletionStep(CONFIRM, { type: "forfeit", forfeit: true });
    expect(canDelete(ticked)).toBe(true);
    const again = deletionStep(ticked, {
      type: "pending",
      pending: [PRIZE, PRIZE],
      problem: MESSAGE,
    });
    expect(again).toMatchObject({ pending: [PRIZE, PRIZE], forfeit: false, problem: MESSAGE });
    expect(canDelete(again)).toBe(false);
  });

  it("keeps the attempts left on a wrong code and starts again when a step ends", () => {
    expect(
      deletionStep(CODE, { type: "wrong_code", attemptsLeft: 2, problem: MESSAGE }),
    ).toMatchObject({
      attemptsLeft: 2,
      problem: MESSAGE,
    });
    expect(deletionStep(CONFIRM, { type: "start_again", problem: MESSAGE })).toEqual({
      step: "about",
      problem: MESSAGE,
    });
    expect(deletionStep(CODE, { type: "refused", problem: MESSAGE })).toMatchObject({
      step: "code",
      problem: MESSAGE,
    });
  });

  it("ignores a late answer that does not fit the step", () => {
    expect(deletionStep(START, { type: "verified", deletionToken: "d", pending: [] })).toBe(START);
    expect(deletionStep(START, { type: "erased" })).toBe(START);
    expect(deletionStep(START, { type: "forfeit", forfeit: true })).toBe(START);
    expect(deletionStep(START, { type: "wrong_code", attemptsLeft: 1, problem: null })).toBe(START);
    expect(deletionStep(CODE, { type: "pending", pending: [], problem: null })).toBe(CODE);
    expect(canDelete(START)).toBe(false);
    const done = deletionStep(CONFIRM, { type: "forfeit", forfeit: true });
    const finished = deletionStep(done, { type: "erased" });
    expect(deletionStep(finished, { type: "code_sent", challengeToken: "x" })).toEqual({
      step: "done",
    });
  });
});
