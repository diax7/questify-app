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

const PACKAGES = ["react-native-view-shot", "expo-sharing"];

/**
 * Whether a source file loads one of the packages as it loads: a static import or re-export of a value (not `import
 * type` or `export type`), a bare `import "pkg"`, or a dynamic `import("pkg")`. A `require` is checked apart.
 */
function loadsOnImport(source: string, name: string): boolean {
  const quoted = `["']${name}["']`;
  return [
    new RegExp(`^\\s*(import|export)\\s+(?!type\\b)[^;]*?\\bfrom\\s+${quoted}`, "m"),
    new RegExp(`^\\s*import\\s+${quoted}`, "m"),
    new RegExp(`\\bimport\\(\\s*${quoted}`),
  ].some((pattern) => pattern.test(source));
}

describe("the scan for loading either package", () => {
  it.each([
    'import { shareAsync } from "expo-sharing";',
    'import * as Sharing from "expo-sharing";',
    'import Sharing from "expo-sharing";',
    'import Sharing, { shareAsync } from "expo-sharing";',
    'import {\n  shareAsync,\n} from "expo-sharing";',
    'import "expo-sharing";',
    "import 'expo-sharing';",
    'const sharing = await import("expo-sharing");',
    "const sharing = import( 'expo-sharing' );",
    'export * from "expo-sharing";',
    'export { shareAsync } from "expo-sharing";',
    'export { default } from "expo-sharing";',
    'import { captureRef } from "react-native-view-shot";',
    'import "react-native-view-shot";',
    'import("react-native-view-shot");',
    'export * from "react-native-view-shot";',
    '  import { captureRef } from "react-native-view-shot";',
  ])("catches %j", (source) => {
    expect(PACKAGES.some((name) => loadsOnImport(source, name))).toBe(true);
  });

  it.each([
    'import type { ShareOptions } from "expo-sharing";',
    'import type * as Sharing from "expo-sharing";',
    'import type * as ViewShot from "react-native-view-shot";',
    'export type * from "expo-sharing";',
    'export type { SharingOptions } from "expo-sharing";',
    'import { Share } from "react-native";',
    'import { thing } from "expo-sharing-helpers";',
    '// import "expo-sharing";',
  ])("lets %j through", (source) => {
    expect(PACKAGES.some((name) => loadsOnImport(source, name))).toBe(false);
  });
});

/**
 * A plain import of either package throws as it loads on a build without its native module (react-native-view-shot
 * calls `TurboModuleRegistry.getEnforcing` at load). Types are erased and safe; only `recap-share-native.ts` may
 * require them, inside `loadModules`.
 */
describe("where the two packages may be loaded", () => {
  const roots = [join(import.meta.dirname, "..", "..", "app"), join(import.meta.dirname, "..")];

  const files = roots.flatMap((root) =>
    readdirSync(root, { withFileTypes: true, recursive: true })
      .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
      .map((entry) => join(entry.parentPath, entry.name)),
  );

  it("finds the app's sources", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("never loads either package on import, outside the type-only imports", () => {
    // This file holds the scan's own samples, written as strings.
    const scanned = files.filter((file) => !file.endsWith("recap-share-native.test.ts"));
    const offenders = scanned.filter((file) => {
      const source = readFileSync(file, "utf8");
      return PACKAGES.some((name) => loadsOnImport(source, name));
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
