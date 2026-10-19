import { describe, expect, it } from "vitest";
import { SESSION_COOKIE, clearedSessionCookie, readCookie, sessionCookie } from "#src/auth/session";

describe("readCookie", () => {
  it("finds a cookie among several, ignoring spaces", () => {
    expect(readCookie(`a=1; ${SESSION_COOKIE}=abc ; b=2`, SESSION_COOKIE)).toBe("abc");
  });

  it("returns undefined when the header or the cookie is missing", () => {
    expect(readCookie(undefined, SESSION_COOKIE)).toBeUndefined();
    expect(readCookie("a=1; b=2", SESSION_COOKIE)).toBeUndefined();
    expect(readCookie("", SESSION_COOKIE)).toBeUndefined();
  });

  it("does not match another cookie whose name only contains this one", () => {
    expect(readCookie(`x${SESSION_COOKIE}=evil; y=1`, SESSION_COOKIE)).toBeUndefined();
    expect(readCookie(`${SESSION_COOKIE}x=evil`, SESSION_COOKIE)).toBeUndefined();
  });

  it("ignores a part with no equals sign", () => {
    expect(readCookie(`${SESSION_COOKIE}; ${SESSION_COOKIE}=ok`, SESSION_COOKIE)).toBe("ok");
  });

  it("keeps equals signs inside the value", () => {
    expect(readCookie(`${SESSION_COOKIE}=a=b=`, SESSION_COOKIE)).toBe("a=b=");
  });

  it("does not read a part with no equals sign as if it ended in the name", () => {
    expect(readCookie(`${SESSION_COOKIE}X`, SESSION_COOKIE)).toBeUndefined();
    expect(readCookie(`${SESSION_COOKIE}X; a=1`, SESSION_COOKIE)).toBeUndefined();
  });

  it("takes the first cookie of that name", () => {
    expect(readCookie(`${SESSION_COOKIE}=one; ${SESSION_COOKIE}=two`, SESSION_COOKIE)).toBe("one");
  });
});

describe("cookie strings", () => {
  it("sets a host-only, secure, same-site cookie that lasts as long as the session may", () => {
    expect(sessionCookie("tok", 43_200)).toBe(
      "__Host-qs_session=tok; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200",
    );
  });

  it("clears it with the same attributes and an age of zero", () => {
    expect(clearedSessionCookie()).toBe(
      "__Host-qs_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0",
    );
  });
});
