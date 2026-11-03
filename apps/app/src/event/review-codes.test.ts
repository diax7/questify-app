import { MESSAGES } from "@questify/shared";
import { describe, expect, it } from "vitest";
import type { AuthedResult } from "#src/api/session.ts";
import { readHome } from "#src/event/home-api.ts";
import {
  REVIEW_KIND_TEXT,
  fetchReviewCodes,
  fetchReviewMeetCode,
  pickOf,
  readReviewCodes,
  reviewMeetAnswerOf,
  type ReviewCode,
} from "#src/event/review-codes.ts";
import { isReviewDemoEvent, noteReviewDemo } from "#src/event/review-demo-flag.ts";

const headers = new Headers();
const ok = (body: unknown, status = 200): AuthedResult => ({ kind: "ok", status, body, headers });
const refused = (status: number, code: string): AuthedResult => ({
  kind: "error",
  status,
  code,
  message: null,
  details: {},
  headers,
});
const title = { ar: "البوابة", en: "Gate" };
const code = (fields: Partial<ReviewCode> = {}): ReviewCode => ({
  kind: "quest",
  id: "q1",
  questId: "q1",
  title,
  label: null,
  url: "https://questify.sa/q/abc",
  ...fields,
});

describe("the review demo's code picker (T-710b)", () => {
  it("reads the list, leaving out a code this build cannot read", () => {
    const tag = code({ kind: "tag", id: "t1", label: { ar: "بوابة", en: "Gate" } });
    expect(
      readReviewCodes({
        codes: [code(), tag, { ...code(), kind: "kiosk" }, { ...code(), title: 3 }, null],
      }),
    ).toEqual([code(), tag]);
    expect(readReviewCodes({ codes: [] })).toEqual([]);
    for (const body of [null, {}, { codes: "x" }, "codes"]) {
      expect(readReviewCodes(body)).toBeUndefined();
    }
  });

  it("feeds a QR, step or secret code to the scanner, a tag to the tag handler, and a meet quest asks first", () => {
    for (const kind of ["quest", "step", "reveal"] as const) {
      expect(pickOf(code({ kind }))).toEqual({ kind: "scan", data: "https://questify.sa/q/abc" });
    }
    expect(pickOf(code({ kind: "tag", url: "https://questify.sa/t/xyz" }))).toEqual({
      kind: "tap",
      url: "https://questify.sa/t/xyz",
    });
    expect(pickOf(code({ kind: "meet", id: "m1", url: null }))).toEqual({
      kind: "meet",
      questId: "m1",
    });
    expect(pickOf(code({ url: null }))).toBeUndefined();
  });

  it("names every kind in both languages", () => {
    for (const key of Object.values(REVIEW_KIND_TEXT)) {
      expect(MESSAGES[key].ar).not.toBe("");
      expect(MESSAGES[key].en).not.toBe("");
    }
  });

  it("asks the review routes and reads a refusal as failed, a 409 as none left", async () => {
    const asked: unknown[] = [];
    const session = (answer: AuthedResult) => ({
      request: async (request: unknown) => {
        asked.push(request);
        return answer;
      },
    });
    expect(await fetchReviewCodes(session(ok({ codes: [code()] })), "e 1")).toEqual({
      kind: "codes",
      codes: [code()],
    });
    expect(await fetchReviewCodes(session(refused(404, "not_found")), "e1")).toEqual({
      kind: "failed",
    });
    expect(await fetchReviewCodes(session({ kind: "signed_out" }), "e1")).toEqual({
      kind: "signed_out",
    });
    expect(
      await fetchReviewMeetCode(session(ok({ code: "questify/meet/v1/x" }, 201)), "e1", "m1"),
    ).toEqual({ kind: "code", code: "questify/meet/v1/x" });
    expect(asked[0]).toEqual({ method: "GET", path: "/v1/events/e%201/review-codes" });
    expect(asked.at(-1)).toEqual({
      method: "POST",
      path: "/v1/events/e1/review-codes/meet",
      body: { questId: "m1" },
    });
    expect(reviewMeetAnswerOf(refused(409, "none_left"))).toEqual({ kind: "none_left" });
    expect(reviewMeetAnswerOf(refused(404, "not_found"))).toEqual({ kind: "failed" });
    expect(reviewMeetAnswerOf({ kind: "network" })).toEqual({ kind: "failed" });
    expect(reviewMeetAnswerOf(ok({}))).toEqual({ kind: "failed" });
  });

  it("reads Home's flag only when it is exactly true", () => {
    const home = {
      event: {
        id: "e1",
        name: title,
        venue: title,
        startsAt: null,
        endsAt: null,
        timezone: "Asia/Riyadh",
        statusNow: "live",
      },
      standing: { status: "active", score: 0, balance: 0, questsDone: 0, questsTotal: 0 },
      upNext: null,
      rankingOn: true,
    };
    expect(readHome({ ...home, reviewDemo: true })?.reviewDemo).toBe(true);
    expect(readHome(home)?.reviewDemo).toBe(false);
    expect(readHome({ ...home, reviewDemo: "true" })?.reviewDemo).toBe(false);
  });

  it("offers the picker only in the event whose Home said so, until a Home says otherwise", () => {
    expect(isReviewDemoEvent("e1")).toBe(false);
    noteReviewDemo("e1", true);
    expect(isReviewDemoEvent("e1")).toBe(true);
    expect(isReviewDemoEvent("e2")).toBe(false);
    noteReviewDemo("e2", false);
    expect(isReviewDemoEvent("e1")).toBe(true);
    noteReviewDemo("e1", false);
    expect(isReviewDemoEvent("e1")).toBe(false);
  });
});
