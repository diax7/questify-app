import { describe, expect, it } from "vitest";
import {
  canSend,
  mySubmissionsOf,
  sendAnswer,
  sendKey,
  sentLine,
  submissionStep,
  type OwnSubmission,
} from "#src/event/submissions.ts";

const fresh = () => "new";

const own = (fields: Partial<OwnSubmission> = {}): OwnSubmission => ({
  id: "1",
  questId: "q1",
  status: "pending",
  points: 150,
  text: "Hello",
  reason: null,
  reasonSystem: false,
  resubmit: false,
  ...fields,
});

const ok = (body: unknown) => ({ kind: "ok" as const, status: 201, body, headers: new Headers() });
const error = (code: string) => ({
  kind: "error" as const,
  status: 409,
  code,
  message: { ar: "ع", en: "e" },
  details: {},
  headers: new Headers(),
});

describe("mySubmissionsOf", () => {
  it("reads the list and the pending points", () => {
    expect(mySubmissionsOf({ submissions: [own()], pendingPoints: 150 })).toEqual({
      submissions: [own()],
      pendingPoints: 150,
    });
  });

  it.each([
    null,
    {},
    { submissions: [], pendingPoints: "1" },
    { submissions: [{ ...own(), status: "lost" }], pendingPoints: 0 },
    { submissions: [{ ...own(), points: "150" }], pendingPoints: 0 },
    { submissions: [{ ...own(), resubmit: undefined }], pendingPoints: 0 },
  ])("reads %j as nothing", (body) => {
    expect(mySubmissionsOf(body)).toBeUndefined();
  });
});

describe("submissionStep", () => {
  it("offers writing when there is nothing for this quest, or the latest was approved", () => {
    expect(submissionStep("q1", [])).toEqual({ kind: "write" });
    expect(submissionStep("q1", [own({ questId: "q2" })])).toEqual({ kind: "write" });
    expect(submissionStep("q1", [own({ status: "approved" })])).toEqual({ kind: "write" });
  });

  it("follows the latest one for the quest (the list is newest first)", () => {
    expect(
      submissionStep("q1", [own({ status: "pending", points: 40 }), own({ status: "rejected" })]),
    ).toEqual({ kind: "pending", points: 40 });
  });

  it("says whether a rejection can be sent again, and hides a system code", () => {
    expect(submissionStep("q1", [own({ status: "rejected", reason: "Off topic" })])).toEqual({
      kind: "rejected",
      reason: "Off topic",
      again: false,
      system: false,
    });
    expect(
      submissionStep("q1", [own({ status: "rejected", reason: "x", resubmit: true })]),
    ).toMatchObject({ again: true });
    expect(
      submissionStep("q1", [own({ status: "rejected", reason: "left_event", reasonSystem: true })]),
    ).toEqual({ kind: "rejected", reason: null, again: true, system: true });
  });

  it("shows a removal with its reason", () => {
    expect(submissionStep("q1", [own({ status: "removed", reason: "Spam" })])).toEqual({
      kind: "removed",
      reason: "Spam",
    });
  });
});

describe("sendAnswer", () => {
  it("reads a pending and an approved answer", () => {
    expect(sendAnswer(ok({ status: "pending", points: 150, levelUp: null }))).toEqual({
      kind: "sent",
      status: "pending",
      points: 150,
      levelUp: null,
    });
    const approved = sendAnswer(
      ok({ status: "approved", points: 150, levelUp: { level: 2, title: { ar: "أ", en: "E" } } }),
    );
    expect(approved).toEqual({
      kind: "sent",
      status: "approved",
      points: 150,
      levelUp: { level: 2, title: { ar: "أ", en: "E" } },
    });
    expect(sentLine(approved as Extract<typeof approved, { kind: "sent" }>)).toBe(
      "submission.sentApproved",
    );
    expect(sentLine({ kind: "sent", status: "pending", points: 1, levelUp: null })).toBe(
      "submission.sentPending",
    );
  });

  it("tells the guidelines step apart from other refusals", () => {
    expect(sendAnswer(error("guidelines_required"))).toEqual({ kind: "guidelines" });
    expect(sendAnswer(error("submission_pending"))).toEqual({
      kind: "refused",
      message: { ar: "ع", en: "e" },
    });
  });

  it("passes network and sign-out through, and reads a malformed body as a network problem", () => {
    expect(sendAnswer({ kind: "network" })).toEqual({ kind: "network" });
    expect(sendAnswer({ kind: "signed_out" })).toEqual({ kind: "signed_out" });
    expect(sendAnswer(ok({ status: "lost", points: 1 }))).toEqual({ kind: "network" });
    expect(sendAnswer(ok({ status: "pending" }))).toEqual({ kind: "network" });
    expect(sendAnswer(ok(null))).toEqual({ kind: "network" });
  });
});

describe("canSend and sendKey", () => {
  it("bounds the text as the server does", () => {
    expect(canSend("   ")).toBe(false);
    expect(canSend(" a ")).toBe(true);
    expect(canSend("x".repeat(1000))).toBe(true);
    expect(canSend("x".repeat(1001))).toBe(false);
  });

  it("keeps the key for the same text and takes a new one for new text", () => {
    expect(sendKey(undefined, "a", fresh)).toBe("new");
    expect(sendKey({ key: "old", text: "a" }, "a", fresh)).toBe("old");
    expect(sendKey({ key: "old", text: "a" }, "b", fresh)).toBe("new");
  });
});
