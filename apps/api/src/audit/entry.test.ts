import { FEATURES, TUNING } from "@questify/shared";
import { describe, expect, it } from "vitest";
import { diff, findSecretKey, isAction } from "#src/audit/entry";

describe("the settings registry and the deny-list", () => {
  it("never clash, or every settings save would be refused", () => {
    const keys = [...Object.keys(FEATURES), ...Object.keys(TUNING)];
    expect(keys.length).toBeGreaterThan(0);
    expect(findSecretKey(Object.fromEntries(keys.map((key) => [key, 1])))).toBeUndefined();
  });
});

describe("diff", () => {
  it("keeps only the top-level keys whose value changed", () => {
    expect(diff({ a: 1, b: 2, c: 3 }, { a: 1, b: 5, c: 3 })).toEqual({
      before: { b: 2 },
      after: { b: 5 },
    });
  });

  it("compares nested values by content, not by reference", () => {
    expect(diff({ a: { x: [1, 2] } }, { a: { x: [1, 2] } })).toEqual({ before: {}, after: {} });
    expect(diff({ a: { x: [1, 2] } }, { a: { x: [2, 1] } })).toEqual({
      before: { a: { x: [1, 2] } },
      after: { a: { x: [2, 1] } },
    });
  });

  it("shows an added key as missing before and a removed key as missing after", () => {
    expect(diff({ a: 1 }, { a: 1, b: 2 })).toStrictEqual({ before: {}, after: { b: 2 } });
    expect(diff({ a: 1, b: 2 }, { a: 1 })).toStrictEqual({ before: { b: 2 }, after: {} });
  });

  it("treats an empty object and nothing alike", () => {
    expect(diff({}, {})).toEqual({ before: {}, after: {} });
  });
});

describe("findSecretKey", () => {
  it.each([
    "password",
    "passwordHash",
    "token",
    "tokenHash",
    "code",
    "codeHash",
    "secret",
    "Password",
    "TOKEN",
  ])("finds %j", (key) => {
    expect(findSecretKey({ [key]: "x" })).toBe(key);
  });

  it("finds a secret at any depth, inside objects and arrays", () => {
    expect(findSecretKey({ a: { b: [{ c: 1 }, { token: "x" }] } })).toBe("token");
  });

  it("finds nothing in ordinary data", () => {
    expect(
      findSecretKey({ features: { shop: { enabled: false } }, tuning: { qr: 30 } }),
    ).toBeUndefined();
    expect(findSecretKey(null)).toBeUndefined();
    expect(findSecretKey("token")).toBeUndefined();
    expect(findSecretKey([1, "code"])).toBeUndefined();
  });

  it.each([
    "password_hash",
    "token_hash",
    "code_hash",
    "api-key",
    "session_token",
    "newPassword",
    "client_secret",
  ])("finds the database and variant spelling %j", (key) => {
    expect(findSecretKey({ row: { [key]: "x" } })).toBe(key);
  });

  it.each([
    "email",
    "Email",
    "phone",
    "phone_e164",
    "ip",
    "user_agent",
    "userAgent",
    "cookie",
    "authorization",
  ])("finds the personal or credential field %j", (key) => {
    expect(findSecretKey({ [key]: "x" })).toBe(key);
  });

  it("does not mistake a longer word for a secret or personal field", () => {
    expect(
      findSecretKey({
        codeName: "x",
        joinCode: "NAJD1",
        tokens: 3,
        secretary: "y",
        passwordPolicy: "z",
        emailAlerts: true,
        ipAllowed: false,
      }),
    ).toBeUndefined();
  });
});

describe("isAction", () => {
  it.each(["platform_settings.update", "event.features.update", "staff.session.open"])(
    "accepts %j",
    (action) => {
      expect(isAction(action)).toBe(true);
    },
  );

  it.each([
    "",
    "update",
    "Event.update",
    "event..update",
    "event.update.",
    ".event",
    "event.up date",
    "évent.x",
  ])("refuses %j", (action) => {
    expect(isAction(action)).toBe(false);
  });
});
