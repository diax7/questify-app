import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const natives = vi.hoisted(() => ({
  optional: vi.fn<(name: string) => unknown>(),
  turbo: vi.fn<(name: string) => unknown>(),
  share: vi.fn<(content: { message: string }) => Promise<unknown>>(),
}));

vi.mock("expo", () => ({ requireOptionalNativeModule: natives.optional }));
vi.mock("react-native", () => ({
  TurboModuleRegistry: { get: natives.turbo },
  Share: { share: natives.share },
}));

const { recapShareDeps } = await import("#src/event/recap-share-native.ts");
const { createRecapSharer } = await import("#src/event/recap-share.ts");

const present = { name: "native" };

function builtWith(modules: Readonly<{ sharing: boolean; viewShot: boolean }>) {
  natives.optional.mockImplementation((name) =>
    name === "ExpoSharing" && modules.sharing ? present : null,
  );
  natives.turbo.mockImplementation((name) =>
    name === "RNViewShot" && modules.viewShot ? present : null,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  natives.share.mockResolvedValue({ action: "sharedAction" });
});

describe("the two native checks", () => {
  it("reports the modules present only when expo-sharing and view-shot are both in the build", () => {
    builtWith({ sharing: true, viewShot: true });
    expect(recapShareDeps.modulesPresent()).toBe(true);
    expect(natives.optional).toHaveBeenCalledWith("ExpoSharing");
    expect(natives.turbo).toHaveBeenCalledWith("RNViewShot");
  });

  it.each([
    ["both", { sharing: false, viewShot: false }],
    ["expo-sharing", { sharing: false, viewShot: true }],
    ["react-native-view-shot", { sharing: true, viewShot: false }],
  ])("reports them missing when %s is not in the build", (_name, modules) => {
    builtWith(modules);
    expect(recapShareDeps.modulesPresent()).toBe(false);
  });

  it("reads an undefined answer as missing too", () => {
    natives.optional.mockReturnValue(undefined);
    natives.turbo.mockReturnValue(present);
    expect(recapShareDeps.modulesPresent()).toBe(false);
  });
});

describe("the share on a build without the modules", () => {
  it("sends the fixed text line through React Native's Share and requires neither package", async () => {
    builtWith({ sharing: false, viewShot: false });
    const load = vi.spyOn(recapShareDeps, "loadModules");
    const sharer = createRecapSharer(recapShareDeps);
    const kind = await sharer.share(
      { current: null },
      { message: "My recap from Najd Meetup", dialogTitle: "Share your recap" },
    );
    expect(kind).toBe("text");
    expect(natives.share).toHaveBeenCalledExactlyOnceWith({ message: "My recap from Najd Meetup" });
    expect(load).not.toHaveBeenCalled();
  });

  it.each([
    ["expo-sharing", { sharing: false, viewShot: true }],
    ["react-native-view-shot", { sharing: true, viewShot: false }],
  ])("does the same when only %s is missing", async (_name, modules) => {
    builtWith(modules);
    const load = vi.spyOn(recapShareDeps, "loadModules");
    const kind = await createRecapSharer(recapShareDeps).share(
      { current: null },
      { message: "My recap from Najd Meetup", dialogTitle: "Share your recap" },
    );
    expect(kind).toBe("text");
    expect(natives.share).toHaveBeenCalledOnce();
    expect(load).not.toHaveBeenCalled();
  });
});

/**
 * A plain import of either package throws as it loads on a build without its native module (react-native-view-shot
 * calls `TurboModuleRegistry.getEnforcing` at load). Types are erased and safe; only `recap-share-native.ts` may
 * require them, inside `loadModules`.
 */
describe("where the two packages may be loaded", () => {
  const PACKAGES = ["react-native-view-shot", "expo-sharing"];
  const roots = [join(import.meta.dirname, "..", "..", "app"), join(import.meta.dirname, "..")];

  const files = roots.flatMap((root) =>
    readdirSync(root, { withFileTypes: true, recursive: true })
      .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
      .map((entry) => join(entry.parentPath, entry.name)),
  );

  it("finds the app's sources", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("never imports either package for a value, outside the type-only imports", () => {
    const offenders = files.filter((file) => {
      const source = readFileSync(file, "utf8");
      return PACKAGES.some((name) =>
        new RegExp(`^\\s*(import|export)\\s+(?!type\\b)[^;]*?from\\s+["']${name}["']`, "m").test(
          source,
        ),
      );
    });
    expect(offenders).toEqual([]);
  });

  it("requires them only in recap-share-native.ts", () => {
    const requirers = files.filter((file) => {
      const source = readFileSync(file, "utf8");
      return PACKAGES.some((name) => new RegExp(`require\\(\\s*["']${name}["']`).test(source));
    });
    expect(requirers.map((file) => file.replaceAll("\\", "/").split("/").pop())).toEqual([
      "recap-share-native.ts",
    ]);
  });
});
