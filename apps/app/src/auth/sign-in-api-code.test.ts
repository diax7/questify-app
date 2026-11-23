import { MESSAGES } from "@questify/shared";
import { describe, expect, it } from "vitest";
import type { ApiResult } from "#src/api/client.ts";
import { codeBody, codeRefusal, codeSentOf, type CodeInput } from "#src/auth/sign-in-api.ts";

const headers = new Headers();
const VERSIONS = { terms: "0.1", privacy: "0.1" };
const INPUT: CodeInput = {
  channel: "phone",
  value: "+966551234567",
  lang: "ar",
  versions: VERSIONS,
};
const refused = (code: string, details: Record<string, unknown> = {}): ApiResult => ({
  kind: "error",
  status: 422,
  code,
  message: null,
  details,
  headers,
});

describe("the code request's parts", () => {
  it("sends no previous key without an earlier challenge, and names it when there is one", () => {
    expect(Object.keys(codeBody(INPUT))).toEqual(["channel", "value", "lang", "accept"]);
    expect(codeBody({ ...INPUT, previous: "old" })).toMatchObject({ previous: "old" });
  });

  it("reads the clock only for a sent code", () => {
    let reads = 0;
    const now = () => {
      reads += 1;
      return 5_000;
    };
    for (const answer of [
      refused("rate_limited"),
      { kind: "network" } as const,
      { kind: "ok", status: 200, body: { challengeToken: 7 }, headers } as const,
    ]) {
      expect(codeSentOf(answer, INPUT, now)).toBeUndefined();
    }
    expect(reads).toBe(0);
    const sent = { kind: "ok", status: 200, body: { challengeToken: "t" }, headers } as const;
    expect(codeSentOf(sent, INPUT, now)).toMatchObject({ type: "code_sent", now: 5_000 });
    expect(reads).toBe(1);
  });

  it("asks the consent again on new terms, even when the answer also offers email", () => {
    expect(codeRefusal(refused("acceptance_required", { emailOffered: true }))).toEqual({
      type: "versions_changed",
      versions: undefined,
      problem: MESSAGES["signIn.versionsChanged"],
    });
    expect(codeRefusal(refused("x", { emailOffered: "yes" }))).toMatchObject({
      type: "refused",
      offerEmail: false,
    });
  });
});
