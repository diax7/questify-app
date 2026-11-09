import { describe, expect, it } from "vitest";
import {
  challengeOf,
  inspectedState,
  inviteModeOf,
  isInvite,
  tokenFromHash,
  type Invite,
} from "#src/lib/invite-link.ts";

const TOKEN = "A".repeat(43);
const INVITE: Invite = {
  organizerName: "Najd",
  role: "editor",
  email: "a@b.sa",
  accountExists: false,
};

describe("the token in the URL fragment", () => {
  const cases: readonly [string, string, string | undefined][] = [
    ["alone", `#token=${TOKEN}`, TOKEN],
    ["after another parameter", `#x=1&token=${TOKEN}`, TOKEN],
    ["before another parameter", `#token=${TOKEN}&x=1`, TOKEN],
    ["with the URL-safe characters", `#token=${"a-_Z9".repeat(8)}abc`, `${"a-_Z9".repeat(8)}abc`],
    ["too short", `#token=${"A".repeat(42)}`, undefined],
    ["too long", `#token=${"A".repeat(44)}`, undefined],
    ["a bad character", `#token=${"A".repeat(42)}!`, undefined],
    ["no hash sign", `token=${TOKEN}`, undefined],
    ["another name", `#tokens=${TOKEN}`, undefined],
    ["as a suffix of another name", `#xtoken=${TOKEN}`, undefined],
    ["empty", "", undefined],
  ];
  it.each(cases)("%s", (_name, hash, expected) => {
    expect(tokenFromHash(hash)).toBe(expected);
  });
});

describe("what counts as an invite", () => {
  const cases: readonly [string, unknown, boolean][] = [
    ["a full invite", INVITE, true],
    ["only the organizer name and email", { organizerName: "N", email: "e" }, true],
    ["no email", { organizerName: "N" }, false],
    ["no organizer name", { email: "e" }, false],
    ["a numeric name", { organizerName: 1, email: "e" }, false],
    ["a numeric email", { organizerName: "N", email: 1 }, false],
    ["null", null, false],
    ["a string", "invite", false],
    ["undefined", undefined, false],
  ];
  it.each(cases)("%s", (_name, value, expected) => {
    expect(isInvite(value)).toBe(expected);
  });
});

describe("the page once the link is inspected", () => {
  const said: string[] = [];
  const words = (body: unknown) => {
    said.push(JSON.stringify(body));
    return "words";
  };

  it("shows the invite for a good answer, and never asks for words", () => {
    said.length = 0;
    expect(inspectedState({ ok: true, body: INVITE }, TOKEN, words)).toEqual({
      kind: "ready",
      token: TOKEN,
      invite: INVITE,
    });
    expect(said).toEqual([]);
  });

  const failing: readonly [string, { ok: boolean; body: unknown }][] = [
    ["a refusal", { ok: false, body: { code: "invite_used" } }],
    ["an ok answer that is no invite", { ok: true, body: { organizerName: "N" } }],
    ["a failed answer that looks like an invite", { ok: false, body: INVITE }],
    ["no body", { ok: false, body: undefined }],
  ];
  it.each(failing)("says why for %s", (_name, result) => {
    said.length = 0;
    expect(inspectedState(result, TOKEN, words)).toEqual({ kind: "no_link", message: "words" });
    expect(said).toEqual([JSON.stringify(result.body)]);
  });
});

describe("the sign-in code challenge", () => {
  const cases: readonly [string, { ok: boolean; body: unknown }, string | undefined][] = [
    ["a good answer", { ok: true, body: { challengeToken: "c1" } }, "c1"],
    ["a failed call carrying one", { ok: false, body: { challengeToken: "c1" } }, undefined],
    ["a numeric token", { ok: true, body: { challengeToken: 1 } }, undefined],
    ["an empty answer", { ok: true, body: {} }, undefined],
    ["no body", { ok: true, body: undefined }, undefined],
    ["null body", { ok: true, body: null }, undefined],
  ];
  it.each(cases)("%s", (_name, result, expected) => {
    expect(challengeOf(result)).toBe(expected);
  });
});

describe("what the invite page offers", () => {
  const known = { ...INVITE, accountExists: true };
  const cases: readonly [string, string | null, Invite, string][] = [
    ["signed in with the invited email", "a@b.sa", INVITE, "accept"],
    ["signed in with the invited email, account known", "a@b.sa", known, "accept"],
    ["signed in as someone else", "other@b.sa", INVITE, "otherSignedIn"],
    ["signed in as someone else, account known", "other@b.sa", known, "otherSignedIn"],
    ["signed in with a different case", "A@B.SA", INVITE, "otherSignedIn"],
    ["signed out, account known", null, known, "signIn"],
    ["signed out, someone new", null, INVITE, "join"],
  ];
  it.each(cases)("%s", (_name, signedIn, invite, expected) => {
    expect(inviteModeOf(signedIn, invite)).toBe(expected);
  });
});
