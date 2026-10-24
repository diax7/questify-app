import { describe, expect, it } from "vitest";
import type { AuthedResult } from "#src/api/session.ts";
import { confirmedOf, tapAnswerOf, tapTag, writePageOf } from "#src/nfc/nfc-api.ts";

const headers = new Headers();
const ok = (body: unknown): AuthedResult => ({ kind: "ok", status: 200, body, headers });
const error = (status: number, code: string): AuthedResult => ({
  kind: "error",
  status,
  code,
  message: { ar: "لا", en: "No" },
  details: {},
  headers,
});
const PAID = {
  completionId: "1",
  points: 10,
  occurrence: 1,
  score: 10,
  balance: 10,
  replayed: false,
  levelUp: null,
  bonus: null,
  item: null,
  boost: null,
};

describe("tapAnswerOf", () => {
  it("reads a paid tap with its quest", () => {
    expect(tapAnswerOf(ok({ ...PAID, questId: "q1" }))).toMatchObject({
      kind: "completed",
      points: 10,
      questId: "q1",
    });
    expect(tapAnswerOf(ok(PAID))).not.toHaveProperty("questId");
  });

  it("says an unknown or foreign tag in the API's words, and the rest as a scan's refusals", () => {
    for (const code of ["unknown_tag", "invalid_proof"]) {
      expect(tapAnswerOf(error(code === "unknown_tag" ? 404 : 422, code))).toEqual({
        kind: "wrong_code",
        problem: { ar: "لا", en: "No" },
      });
    }
    expect(tapAnswerOf(error(409, "already_completed"))).toEqual({ kind: "limit" });
    expect(tapAnswerOf({ kind: "network" })).toEqual({ kind: "network" });
  });
});

describe("tapTag", () => {
  const sent: unknown[] = [];
  const session = {
    request: async (request: unknown) => {
      sent.push(request);
      return ok(PAID);
    },
  };

  it("sends the platform reason only from an iPhone without a sticker id (CTO A)", async () => {
    await tapTag(session, { code: "c", uid: null, platform: "ios", position: null }, "k1");
    await tapTag(session, { code: "c", uid: null, platform: "android", position: null }, "k2");
    await tapTag(session, { code: "c", uid: "04a1b2c3", platform: "ios", position: null }, "k3");
    expect(sent.map((request) => (request as { body: object }).body)).toEqual([
      { code: "c", uid: null, platform: "ios", uidReason: "platform" },
      { code: "c", uid: null, platform: "android" },
      { code: "c", uid: "04a1b2c3", platform: "ios" },
    ]);
    expect((sent[0] as { headers: object }).headers).toEqual({ "idempotency-key": "k1" });
  });
});

describe("the write page and the confirm", () => {
  it("keeps well-formed quests and active tags only", () => {
    expect(
      writePageOf({
        quests: [{ id: "q", title: { ar: "أ", en: null }, tags: 2 }, { title: {} }],
        tags: [
          {
            id: "t",
            quest: { en: "Gate" },
            label: "Door",
            locked: true,
            status: "active",
            writtenAt: "x",
          },
          { id: "r", status: "revoked" },
        ],
      }),
    ).toEqual({
      quests: [{ id: "q", title: { ar: "أ", en: null }, tags: 2 }],
      tags: [
        { id: "t", quest: { ar: null, en: "Gate" }, label: "Door", locked: true, writtenAt: "x" },
      ],
    });
    expect(writePageOf(null)).toEqual({ quests: [], tags: [] });
  });

  it("reads what a confirm replaced", () => {
    expect(confirmedOf({ replaced: null })).toEqual({ kind: "confirmed", replaced: null });
    expect(confirmedOf({ replaced: { label: "Old", quest: { ar: "ب", en: "B" } } })).toEqual({
      kind: "confirmed",
      replaced: { label: "Old", quest: { ar: "ب", en: "B" } },
    });
  });
});
