import { describe, expect, it } from "vitest";
import { nfcPlatformOn, nfcRefusalOf, runNfc } from "#src/nfc/tags";
import type { ConfigResult } from "#src/settings/service";
import { fakePool, pgError } from "#test/support/fake-pool";

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

const failing = (error: Error) =>
  fakePool(() => {
    throw error;
  }).pool;
const work = async (client: { query: (sql: string) => Promise<unknown> }) => {
  await client.query("SELECT tap_quest()");
  return "paid";
};
const settingsOf = (result: unknown) => ({
  forEvent: async () => result as ConfigResult,
});

describe("runNfc", () => {
  it("answers the work's value, or the refusal the database raised", async () => {
    expect(await runNfc(fakePool(() => ({ rows: [] })).pool, {}, work)).toEqual({
      kind: "done",
      value: "paid",
    });
    expect(await runNfc(failing(pgError({ code: "NT404" })), {}, work)).toEqual({
      kind: "unknown_tag",
    });
  });

  it("throws any other error", async () => {
    const broken = pgError({ code: "XX000" });
    await expect(runNfc(failing(broken), {}, work)).rejects.toBe(broken);
  });
});

const withFeatures = (features: object) => settingsOf({ kind: "ok", config: { features } });

describe("the platform's nfcTags switch (ADR-234)", () => {
  it("is on unless switched off, even when the switch is not written", async () => {
    expect(await nfcPlatformOn(withFeatures({}))).toBe(true);
    expect(await nfcPlatformOn(withFeatures({ nfcTags: { enabled: true } }))).toBe(true);
    expect(await nfcPlatformOn(withFeatures({ nfcTags: { enabled: false } }))).toBe(false);
  });

  it("is off when the settings cannot be read", async () => {
    expect(await nfcPlatformOn(settingsOf({ kind: "event_not_found" }))).toBe(false);
  });
});
