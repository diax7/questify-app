import { describe, expect, it } from "vitest";
import {
  confirmFailedStep,
  confirmedStep,
  prepareFailedStep,
  writeFailedStep,
  type Pending,
} from "#src/nfc/write-flow.ts";

const PENDING: Pending = {
  questId: "q1",
  quest: { ar: "س", en: "Q" },
  url: "https://example.test/c/abc",
  ticket: "t1",
  uid: "04:aa",
  label: "Door",
  locked: true,
  lockMissed: false,
  key: "k1",
};
const MESSAGE = { ar: "مرفوض", en: "Refused" };

describe("prepareFailedStep", () => {
  it("shows the API's own words for a refusal that has some", () => {
    expect(prepareFailedStep({ kind: "refused", message: MESSAGE })).toEqual({
      kind: "refused",
      message: MESSAGE,
    });
  });

  it("reads a refusal without words, a network failure and a signed-out answer as a network problem", () => {
    const network = { kind: "problem", key: "join.network", rewrite: false };
    expect(prepareFailedStep({ kind: "refused", message: null })).toEqual(network);
    expect(prepareFailedStep({ kind: "network" })).toEqual(network);
    expect(prepareFailedStep({ kind: "signed_out" })).toEqual(network);
  });
});

describe("writeFailedStep", () => {
  it("names the problem of each failure and offers Rewrite only for a taken tag", () => {
    expect(writeFailedStep("taken")).toEqual({
      kind: "problem",
      key: "operator.nfc.taken",
      rewrite: true,
    });
    expect(writeFailedStep("locked")).toEqual({
      kind: "problem",
      key: "operator.nfc.locked",
      rewrite: false,
    });
    expect(writeFailedStep("off")).toMatchObject({ key: "operator.nfc.off", rewrite: false });
    expect(writeFailedStep("unusable")).toMatchObject({ key: "operator.nfc.unusable" });
    expect(writeFailedStep("unsupported")).toMatchObject({ key: "operator.nfc.unsupported" });
    expect(writeFailedStep("failed")).toMatchObject({ key: "operator.nfc.failed" });
  });
});

describe("confirmFailedStep", () => {
  it("shows a refusal in the API's words", () => {
    expect(confirmFailedStep({ kind: "refused", message: MESSAGE }, PENDING)).toEqual({
      kind: "refused",
      message: MESSAGE,
    });
  });

  it("keeps the pending write for a retry when the answer never came or had no words", () => {
    const unconfirmed = { kind: "unconfirmed", pending: PENDING };
    expect(confirmFailedStep({ kind: "network" }, PENDING)).toEqual(unconfirmed);
    expect(confirmFailedStep({ kind: "refused", message: null }, PENDING)).toEqual(unconfirmed);
  });
});

describe("confirmedStep", () => {
  it("carries the quest, the confirm and whether the lock was missed", () => {
    const confirmed = { kind: "confirmed", replaced: null } as const;
    expect(confirmedStep({ ...PENDING, lockMissed: true }, confirmed)).toEqual({
      kind: "done",
      quest: PENDING.quest,
      confirmed,
      lockMissed: true,
    });
  });
});
