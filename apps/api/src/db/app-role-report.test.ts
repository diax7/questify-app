import { describe, expect, it } from "vitest";
import { appRoleReport, type AppRoleFacts } from "#src/db/app-role-report";

const sound: AppRoleFacts = {
  role: { who: "questify_app", superuser: false, bypass_rls: false },
  staffRows: 0,
  eventRows: 3,
  blockedWrite: true,
  migrationTableReadable: false,
  ownerSeesSessions: true,
};

describe("appRoleReport", () => {
  it("is ok when every limit holds, and reports the facts in order", () => {
    const report = appRoleReport(sound);
    expect(report.ok).toBe(true);
    expect(Object.keys(report)).toEqual([
      "ok",
      "role",
      "superuser",
      "bypassRls",
      "staffRowsVisible",
      "eventsVisible",
      "unidentifiedInsertBlocked",
      "migrationTableReadable",
      "ownerSeesSessions",
    ]);
    expect(report).toMatchObject({
      role: "questify_app",
      superuser: false,
      bypassRls: false,
      staffRowsVisible: 0,
      eventsVisible: 3,
      unidentifiedInsertBlocked: true,
      migrationTableReadable: false,
      ownerSeesSessions: true,
    });
  });

  it.each<[string, Partial<AppRoleFacts>]>([
    ["no role row", { role: undefined }],
    ["a superuser", { role: { who: "x", superuser: true, bypass_rls: false } }],
    ["a role that bypasses RLS", { role: { who: "x", superuser: false, bypass_rls: true } }],
    ["staff rows visible", { staffRows: 1 }],
    ["no staff count", { staffRows: undefined }],
    ["an unblocked insert", { blockedWrite: false }],
    ["a readable migration table", { migrationTableReadable: true }],
    ["an owner that cannot see the sessions", { ownerSeesSessions: false }],
  ])("is not ok with %s", (_name, change) => {
    expect(appRoleReport({ ...sound, ...change }).ok).toBe(false);
  });

  it("leaves the role fields out of the JSON when there is no role row", () => {
    const text = JSON.stringify(appRoleReport({ ...sound, role: undefined }));
    expect(text).not.toContain("superuser");
    expect(text).not.toContain('"role"');
  });
});
