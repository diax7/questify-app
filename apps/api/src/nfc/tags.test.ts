import { describe, expect, it } from "vitest";
import { nfcRefusalOf } from "#src/nfc/tags";

describe("the NFC doors' refusals (migration 0056)", () => {
  it("maps each SQLSTATE to one refusal", () => {
    expect(nfcRefusalOf({ code: "NT404" })).toEqual({ kind: "unknown_tag" });
    expect(nfcRefusalOf({ code: "OQ404" })).toEqual({ kind: "not_found" });
    expect(nfcRefusalOf({ code: "OP403" })).toEqual({ kind: "not_operator" });
    expect(nfcRefusalOf({ code: "OA403" })).toEqual({ kind: "ability_off" });
    expect(nfcRefusalOf({ code: "OS403" })).toEqual({ kind: "outside_quests" });
    expect(nfcRefusalOf({ code: "NT422", detail: "uid" })).toEqual({
      kind: "invalid_tag",
      field: "uid",
    });
    expect(nfcRefusalOf({ code: "NT422" })).toEqual({ kind: "invalid_tag", field: "tag" });
    for (const detail of ["event_closed", "not_nfc", "limit_reached", "already_registered"]) {
      expect(nfcRefusalOf({ code: "NT409", detail }), detail).toEqual({ kind: detail });
    }
  });

  it("lets anything else through", () => {
    expect(nfcRefusalOf({ code: "NT409", detail: "other" })).toBeUndefined();
    expect(nfcRefusalOf({ code: "NT409" })).toBeUndefined();
    expect(nfcRefusalOf({ code: "23505" })).toBeUndefined();
    expect(nfcRefusalOf({})).toBeUndefined();
  });
});
