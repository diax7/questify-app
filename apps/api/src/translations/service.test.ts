import { describe, expect, it } from "vitest";
import type { PublicAccount } from "#src/auth/staff-store";
import { createTranslationService } from "#src/translations/service";
import { fakePool } from "#test/support/fake-pool";

const ADMIN = {
  id: "11111111-1111-4111-8111-111111111111",
  platformRole: "admin",
  status: "active",
} as unknown as PublicAccount;

function service() {
  const fake = fakePool(() => ({ rows: [] }));
  return { ...fake, service: createTranslationService({ pool: fake.pool }) };
}

describe("save: the refusals that come before the database", () => {
  it.each([
    ["a staff member who is not an admin", { ...ADMIN, platformRole: "support" }],
    ["a disabled admin", { ...ADMIN, status: "disabled" }],
  ])("answers forbidden to %s, before reading the body", async (_label, who) => {
    const { service: translations, queries } = service();
    const result = await translations.save(who as PublicAccount, "nav.home", null);
    expect(result).toEqual({ ok: false, reason: "forbidden" });
    expect(queries).toEqual([]);
  });

  it.each([
    ["an empty body", {}],
    ["a number", { en: 5 }],
    ["an unknown field", { en: "x", fr: "y" }],
    ["no body", null],
  ])("answers invalid to %s", async (_label, body) => {
    const { service: translations, queries } = service();
    expect(await translations.save(ADMIN, "nav.home", body)).toEqual({
      ok: false,
      reason: "invalid",
      issues: [{ path: "body", message: "must have ar, en or both, as text" }],
    });
    expect(queries).toEqual([]);
  });

  it("answers the issues of a key the app does not have", async () => {
    const { service: translations, queries } = service();
    expect(await translations.save(ADMIN, "nope.nothing", { en: "x" })).toEqual({
      ok: false,
      reason: "invalid",
      issues: [{ path: "key", message: "is not a text of the app" }],
    });
    expect(queries).toEqual([]);
  });

  it("answers locked to a legal text with valid values", async () => {
    const { service: translations, queries } = service();
    expect(await translations.save(ADMIN, "signIn.terms", { en: "Terms" })).toEqual({
      ok: false,
      reason: "locked",
    });
    expect(queries).toEqual([]);
  });

  it("stores a valid change and answers the key's row", async () => {
    const { service: translations, queries } = service();
    const result = await translations.save(ADMIN, "nav.home", { en: "Start" }, { requestId: "r1" });
    expect(result).toMatchObject({ ok: true, row: { key: "nav.home" } });
    expect(queries[0]).toContain("FOR UPDATE");
    expect(queries[1]).toContain("INSERT INTO translation");
    expect(queries[2]).toContain("INSERT INTO audit_log");
    expect(queries).toHaveLength(3);
  });
});
