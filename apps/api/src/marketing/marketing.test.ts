import { describe, expect, it } from "vitest";
import {
  consentLanguage,
  readConsentHistory,
  readPromoAudience,
  refusalOf,
  setMarketing,
} from "#src/marketing/marketing";
import { fakePool, pgError } from "#test/support/fake-pool";
import type { Pool, PoolClient } from "pg";

const clientOf = async (pool: Pool): Promise<PoolClient> => pool.connect();

describe("readPromoAudience", () => {
  it("asks the audience door for one channel and returns the ids", async () => {
    const seen: (readonly unknown[])[] = [];
    const { pool } = fakePool((_sql, values) => {
      seen.push(values);
      return { rows: [{ player_id: "a" }, { player_id: "b" }] };
    });
    const ids = await readPromoAudience(await clientOf(pool), {
      channel: "sms",
      cityId: "sa-riyadh",
      anyOf: ["sport"],
      after: "z",
      pageSize: 50,
    });
    expect(ids).toEqual(["a", "b"]);
    expect(seen).toEqual([["sms", "sa-riyadh", ["sport"], "z", 50]]);
  });

  it("sends no city, no interests and no cursor as nulls", async () => {
    const seen: (readonly unknown[])[] = [];
    const { pool } = fakePool((_sql, values) => {
      seen.push(values);
      return { rows: [] };
    });
    expect(
      await readPromoAudience(await clientOf(pool), { channel: "push", pageSize: 10 }),
    ).toEqual([]);
    expect(seen).toEqual([["push", null, null, null, 10]]);
  });
});

describe("consentLanguage", () => {
  it.each([
    ["ar", "ar"],
    ["en", "en"],
    ["EN-us,ar;q=0.8", "en"],
    ["ar-SA", "ar"],
    [" en ", "en"],
    ["fr", null],
    ["", null],
    [undefined, null],
    [["en"], null],
  ])("reads %j as %s", (header, expected) => {
    expect(consentLanguage(header)).toBe(expected);
  });
});

describe("refusalOf", () => {
  it.each([
    ["PI401", undefined, 401, "unauthenticated"],
    ["MK403", "age", 403, "consent_age"],
    ["PF422", "interests", 422, "invalid_preferences"],
    ["QY403", undefined, 404, "not_found"],
    ["QY404", undefined, 404, "not_found"],
  ])("maps %s to its HTTP error", (code, detail, status, name) => {
    expect(() => refusalOf(pgError({ code, ...(detail === undefined ? {} : { detail }) }))).toThrow(
      expect.objectContaining({ status, envelope: expect.objectContaining({ code: name }) }),
    );
  });

  it("rethrows what it does not know", () => {
    const fault = pgError({ code: "42501" });
    expect(() => refusalOf(fault)).toThrow(fault);
  });
});

describe("the doors", () => {
  it("send the channels as JSON and surface a refusal as an HTTP error", async () => {
    const { pool } = fakePool(() => {
      throw pgError({ code: "MK403", detail: "age" });
    });
    await expect(
      setMarketing(await clientOf(pool), {
        textVersion: "1",
        method: "settings",
        channels: { sms: true },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("read a player's consent history as the admin and pass the request id for the audit row", async () => {
    const seen: (readonly unknown[])[] = [];
    const { pool } = fakePool((_sql, values) => {
      seen.push(values);
      return { rows: [{ r: { channels: {}, history: [] } }] };
    });
    const admin = "33333333-3333-4333-8333-333333333333";
    const player = "11111111-1111-4111-8111-111111111111";
    const request = "44444444-4444-4444-8444-444444444444";
    await readConsentHistory(pool, admin, player, request);
    expect(seen).toEqual([[player, request]]);
  });
});
