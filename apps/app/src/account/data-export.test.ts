import { MESSAGES } from "@questify/shared";
import { describe, expect, it, vi } from "vitest";
import { downloadMyData, type DataExportDeps, type FileModules } from "#src/account/data-export.ts";
import type { AuthedResult } from "#src/api/session.ts";

const FILE = { format: "questify-data-export", version: 1, contacts: { phone: "+966512345678" } };
const ok = (body: unknown): AuthedResult => ({
  kind: "ok",
  status: 200,
  body,
  headers: new Headers(),
});

function setup(answer: AuthedResult, overrides: Partial<FileModules> = {}, present = true) {
  const modules = {
    writeCacheFile: vi.fn((name: string) => `file:///cache/${name}`),
    share: vi.fn(async () => undefined),
    remove: vi.fn(),
    ...overrides,
  };
  const request = vi.fn(async () => answer);
  const deps: DataExportDeps = {
    session: { request },
    modulesPresent: () => present,
    loadModules: () => modules,
    now: () => new Date("2026-11-03T08:00:00Z"),
  };
  return { deps, modules, request };
}

describe("downloading my data (T-708)", () => {
  it("writes the file to the cache, shares it and deletes it after", async () => {
    const { deps, modules, request } = setup(ok(FILE));
    expect(await downloadMyData(deps)).toEqual({ kind: "shared" });
    expect(request).toHaveBeenCalledWith({ method: "POST", path: "/v1/me/data-export", body: {} });
    expect(modules.writeCacheFile).toHaveBeenCalledWith(
      "questify-data-2026-11-03.json",
      JSON.stringify(FILE, null, 2),
    );
    expect(modules.share).toHaveBeenCalledWith("file:///cache/questify-data-2026-11-03.json");
    expect(modules.remove).toHaveBeenCalledWith("file:///cache/questify-data-2026-11-03.json");
  });

  it("deletes the cache file when the share sheet fails", async () => {
    const { deps, modules } = setup(ok(FILE), {
      share: vi.fn(async () => {
        throw new Error("sheet");
      }),
    });
    expect(await downloadMyData(deps)).toEqual({
      kind: "problem",
      message: MESSAGES["dataExport.failed"],
    });
    expect(modules.remove).toHaveBeenCalledTimes(1);
  });

  it("writes nothing when the write itself fails, and still answers", async () => {
    const { deps, modules } = setup(ok(FILE), {
      writeCacheFile: vi.fn(() => {
        throw new Error("disk");
      }),
    });
    expect((await downloadMyData(deps)).kind).toBe("problem");
    expect(modules.share).not.toHaveBeenCalled();
    expect(modules.remove).not.toHaveBeenCalled();
  });

  it("says the API's own words on a refusal and writes nothing", async () => {
    const message = { ar: "محاولات كثيرة.", en: "Too many attempts." };
    const { deps, modules } = setup({
      kind: "error",
      status: 429,
      code: "too_many_attempts",
      message,
      details: {},
      headers: new Headers(),
    });
    expect(await downloadMyData(deps)).toEqual({ kind: "problem", message });
    expect(modules.writeCacheFile).not.toHaveBeenCalled();
  });

  it("answers offline, signed out, and an old build without the modules", async () => {
    expect(await downloadMyData(setup({ kind: "network" }).deps)).toEqual({
      kind: "problem",
      message: MESSAGES["signIn.offline"],
    });
    expect(await downloadMyData(setup({ kind: "signed_out" }).deps)).toEqual({
      kind: "problem",
      message: MESSAGES["signIn.sessionEnded"],
    });
    const old = setup(ok(FILE), {}, false);
    expect(await downloadMyData(old.deps)).toEqual({ kind: "unavailable" });
    expect(old.request).not.toHaveBeenCalled();
  });
});
