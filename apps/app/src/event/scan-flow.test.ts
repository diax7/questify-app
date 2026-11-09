import { describe, expect, it } from "vitest";
import {
  answerBuzz,
  answerQuestId,
  scanDecision,
  type ScanDecision,
} from "#src/event/scan-flow.ts";
import { readScan } from "#src/event/scan.ts";
import { inviteTokenOf } from "#src/operator/station.ts";

const ID = "5f0c2b1e-8d4a-4c3b-9e7f-0a1b2c3d4e5f";
const STAGING = "https://questify-web-staging-4ecphq.cranl.net";

/** A token laid out as `apps/api/src/quests/qr.ts` signs it: format, quest id, version, a 16-byte tag. */
function token(format: number): string {
  return Buffer.concat([
    Buffer.from([format]),
    Buffer.from(ID.replaceAll("-", ""), "hex"),
    Buffer.from([0, 0, 0, 1]),
    Buffer.alloc(16, 7),
  ]).toString("base64url");
}

const INVITE = "A".repeat(50);
const MEET = `questify/meet/v1/${"A".repeat(22)}`;

// The scanner's `scanned` as it read a code before the decision moved out of it: the id and token it sent on.
function oldDecision(data: string, extraOrigin: string | null): ScanDecision {
  const invite = inviteTokenOf(data);
  if (invite !== null) {
    return { kind: "invite", token: invite };
  }
  const scan = readScan(data, extraOrigin);
  if (scan.kind === "other") {
    return { kind: "other" };
  }
  if (scan.kind === "join") {
    return { kind: "join", code: scan.code };
  }
  if (scan.kind === "meet") {
    return { kind: "read", id: "meet", token: scan.code };
  }
  const id =
    scan.kind === "step" ? scan.stepId : scan.kind === "reveal" ? scan.categoryId : scan.questId;
  return { kind: "read", id, token: scan.token };
}

// The buzz chain after a server answer, as the scanner held it: stamped|revealed -> success; completed -> its own
// buzz; else if not network -> error (a signed-out answer is handled before it).
function oldBuzz(kind: string): string {
  if (kind === "stamped" || kind === "revealed") {
    return "success";
  }
  if (kind === "completed") {
    return "none";
  }
  return kind !== "network" ? "error" : "none";
}

describe("scanDecision", () => {
  it.each<[string, string, ScanDecision]>([
    ["a quest code", `${STAGING}/q/${token(0x01)}`, { kind: "read", id: ID, token: token(0x01) }],
    [
      "a passport step's code",
      `${STAGING}/q/${token(0x04)}`,
      { kind: "read", id: ID, token: token(0x04) },
    ],
    [
      "a hidden category's secret code",
      `${STAGING}/q/${token(0x05)}`,
      { kind: "read", id: ID, token: token(0x05) },
    ],
    [
      "a station's rotating code",
      `${STAGING}/s/${token(0x07)}`,
      { kind: "read", id: ID, token: token(0x07) },
    ],
    ["another player's meet code", MEET, { kind: "read", id: "meet", token: MEET }],
    ["a join link", "https://questify.sa/ar/e/NAJD1", { kind: "join", code: "NAJD1" }],
    [
      "a personal operator code",
      `https://questify.sa/ar/op#${INVITE}`,
      { kind: "invite", token: INVITE },
    ],
    [
      "an operator app link",
      `questify://operator-invite/${INVITE}`,
      { kind: "invite", token: INVITE },
    ],
    ["a quest code of an unknown host", `https://example.com/q/${token(0x01)}`, { kind: "other" }],
    ["a bare word", "hello world", { kind: "other" }],
    ["nothing", "", { kind: "other" }],
  ])("%s", (_name, data, expected) => {
    expect(scanDecision(data, STAGING)).toEqual(expected);
    expect(oldDecision(data, STAGING)).toEqual(expected);
  });

  it("only trusts the extra origin when the build names it", () => {
    const data = `${STAGING}/q/${token(0x01)}`;
    expect(scanDecision(data, null)).toEqual({ kind: "other" });
    expect(scanDecision(data, null)).toEqual(oldDecision(data, null));
  });
});

describe("answerBuzz", () => {
  it.each<[string, "success" | "error" | "none"]>([
    ["stamped", "success"],
    ["revealed", "success"],
    ["completed", "none"],
    ["network", "none"],
    ["reload", "error"],
    ["refused", "error"],
    ["forbidden", "error"],
    ["not_found", "error"],
  ])("%s -> %s", (kind, buzz) => {
    expect(answerBuzz(kind)).toBe(buzz);
  });

  it("is the old chain after a signed-out answer is handled first", () => {
    for (const kind of ["stamped", "revealed", "completed", "network", "reload", "x", ""]) {
      expect(answerBuzz(kind)).toBe(oldBuzz(kind));
    }
  });
});

describe("answerQuestId", () => {
  it.each<[string, object, string]>([
    ["a station or meet answer names its quest", { kind: "completed", questId: "q9" }, "q9"],
    ["a plain answer keeps the id the code held", { kind: "completed" }, "q1"],
    ["a quest id that is not text is ignored", { kind: "completed", questId: 7 }, "q1"],
    ["a missing quest id is ignored", { kind: "completed", questId: undefined }, "q1"],
    ["an empty quest id still counts as text", { kind: "completed", questId: "" }, ""],
  ])("%s", (_name, answer, expected) => {
    expect(answerQuestId(answer, "q1")).toBe(expected);
    const old = "questId" in answer && typeof answer.questId === "string" ? answer.questId : "q1";
    expect(old).toBe(expected);
  });
});
