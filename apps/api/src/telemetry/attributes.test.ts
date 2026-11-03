import { describe, expect, it } from "vitest";
import { ATTRIBUTE_RULES, RESOURCE_KEYS, safeAttributes, TICKS } from "#src/telemetry/attributes";

/** Words that, in an attribute key, mean the value could identify a person or open an account. */
const PERSONAL_KEY =
  /phone|msisdn|e-?mail|user|name|token|\bip\b|address|secret|password|cookie|authori[sz]ation|session|player|contact|otp|passcode|\bkey\b|body|url|query|header|agent/;

describe("safeAttributes", () => {
  it("keeps allowed keys whose values have the right shape", () => {
    expect(
      safeAttributes({
        "http.request.method": "POST",
        "http.route": "/v1/quests/:questId/complete",
        "http.response.status_code": 201,
        "questify.event": "community.settle_failed",
        "questify.tick": "community",
      }),
    ).toEqual({
      "http.request.method": "POST",
      "http.route": "/v1/quests/:questId/complete",
      "http.response.status_code": 201,
      "questify.event": "community.settle_failed",
      "questify.tick": "community",
    });
  });

  it("drops a key that is not on the list, however harmless it looks", () => {
    expect(
      safeAttributes({ "enduser.id": "42", "user.email": "a@b.sa", "http.target": "/x" }),
    ).toEqual({});
  });

  it.each([
    ["http.route", "/v1/players/someone?email=a@b.sa"],
    ["http.route", "/v1/players/a b"],
    ["http.route", `/${"a".repeat(200)}`],
    ["http.request.method", "post"],
    ["http.response.status_code", "200"],
    ["http.response.status_code", 99],
    ["http.response.status_code", 200.5],
    ["questify.event", "Alice@example.sa"],
    ["questify.event", "community"],
    ["questify.event", "a.b.c.d"],
    ["questify.provider", "+966500000000"],
    ["questify.outcome", "Sent to 0500"],
    ["questify.tick", "someone"],
    ["questify.pool", "main"],
  ] as const)("drops %s = %j", (key, value) => {
    expect(safeAttributes({ [key]: value })).toEqual({});
  });

  it("drops an undefined value", () => {
    expect(safeAttributes({ "http.route": undefined })).toEqual({});
  });
});

describe("the attribute list", () => {
  it("has no key that names personal data, a credential or free text", () => {
    expect(Object.keys(ATTRIBUTE_RULES).filter((key) => PERSONAL_KEY.test(key))).toEqual([]);
  });

  it("describes the resource by the service, its build, its instance and its deployment only", () => {
    expect(RESOURCE_KEYS).toEqual([
      "service.name",
      "service.version",
      "service.instance.id",
      "deployment.environment.name",
    ]);
  });

  it("accepts every background loop's name", () => {
    for (const tick of TICKS) {
      expect(safeAttributes({ "questify.tick": tick })).toEqual({ "questify.tick": tick });
    }
  });
});
