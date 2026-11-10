import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The web build must never load a module that only exists on a phone (T-803). A native-only package may be imported,
 * statically or lazily, only by a file that has a `.web.ts` (or `.web.tsx`) counterpart, which the web bundle takes in its
 * place (`metro.config.js`). These read the sources, so a later static import in a screen fails here, not in a browser.
 */
const ROOT = join(import.meta.dirname, "..", "..");

/** Packages with no web build, or one that throws or is empty (`expo-secure-store`). A type-only import is always fine. */
const NATIVE_ONLY = [
  "expo-haptics",
  "expo-notifications",
  "expo-application",
  "expo-file-system",
  "expo-sharing",
  "expo-secure-store",
  "react-native-view-shot",
  "react-native-nfc-manager",
];

/** Packages that belong to the web bundle alone: a phone build must never pull them in. */
const WEB_ONLY = ["barcode-detector"];

/**
 * Files that still import a native-only package with no web counterpart. Each one is a known gap with an owner; the list
 * only shrinks. It is empty now: `app-session.ts` (the keychain session) has its web version, the cookie session (T-803 P2).
 */
const KNOWN_GAPS: ReadonlyMap<string, string> = new Map();

type Use = Readonly<{ module: string; how: "static" | "require" | "import()" }>;

const quoted = String.raw`["']([^"']+)["']`;

/** The modules a source file loads at run time: static imports and re-exports, `require(...)` and `import(...)`. */
export function usesIn(text: string): Use[] {
  const uses: Use[] = [];
  // `import type ...` and `export type ...` are erased by the compiler, so they load nothing.
  const statics = new RegExp(
    String.raw`(?:^|\n)\s*(?:import|export)\s+(?!type\b)(?:[^"';]*?\s+from\s+)?${quoted}`,
    "g",
  );
  for (const match of text.matchAll(statics)) {
    uses.push({ module: match[1] ?? "", how: "static" });
  }
  for (const match of text.matchAll(new RegExp(String.raw`\brequire\(\s*${quoted}\s*\)`, "g"))) {
    uses.push({ module: match[1] ?? "", how: "require" });
  }
  for (const match of text.matchAll(new RegExp(String.raw`\bimport\(\s*${quoted}\s*\)`, "g"))) {
    uses.push({ module: match[1] ?? "", how: "import()" });
  }
  return uses;
}

const isModule = (specifier: string, name: string): boolean =>
  specifier === name || specifier.startsWith(`${name}/`);

const sources = (): ReadonlyArray<{ path: string; text: string }> =>
  ["src", "app"].flatMap((folder) =>
    readdirSync(join(ROOT, folder), { withFileTypes: true, recursive: true })
      .filter((e) => e.isFile() && /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name))
      .map((e) => join(e.parentPath, e.name))
      .map((file) => ({
        path: relative(ROOT, file).replaceAll("\\", "/"),
        text: readFileSync(file, "utf8"),
      })),
  );

const isWebFile = (path: string): boolean => /\.web\.tsx?$/.test(path);
const webSibling = (path: string): boolean =>
  !isWebFile(path) && existsSync(join(ROOT, path.replace(/\.(tsx?)$/, ".web.$1")));

describe("the scan itself", () => {
  it("reads every kind of load and skips type-only imports", () => {
    const text = [
      `import * as Haptics from "expo-haptics";`,
      `import { a, b } from "expo-sharing";`,
      `import "expo-notifications";`,
      `import type * as Sharing from "expo-sharing";`,
      `import type { X } from "expo-file-system";`,
      `export { c } from "expo-secure-store";`,
      `export type { D } from "expo-application";`,
      // Spelled in two parts: another test scans every source for a literal require of these packages.
      `const m = ${["req", "uire"].join("")}("react-native-view-shot") as typeof V;`,
      `const n = await import("react-native-nfc-manager");`,
      `import {`,
      `  e,`,
      `} from "expo-file-system";`,
    ].join("\n");
    expect(usesIn(text)).toEqual([
      { module: "expo-haptics", how: "static" },
      { module: "expo-sharing", how: "static" },
      { module: "expo-notifications", how: "static" },
      { module: "expo-secure-store", how: "static" },
      { module: "expo-file-system", how: "static" },
      { module: "react-native-view-shot", how: "require" },
      { module: "react-native-nfc-manager", how: "import()" },
    ]);
  });

  it("sees the sources and the web counterparts it relies on", () => {
    expect(sources().length).toBeGreaterThan(300);
    const webFiles = sources().filter(({ path }) => isWebFile(path));
    expect(webFiles.map(({ path }) => path).sort()).toEqual(
      expect.arrayContaining([
        "src/platform/haptics.web.ts",
        "src/push/push-native.web.ts",
        "src/nfc/native.web.ts",
        "src/i18n/native.web.ts",
        "src/platform/camera-decoder.web.ts",
      ]),
    );
    for (const { path } of webFiles) {
      expect(existsSync(join(ROOT, path.replace(".web.", "."))), `${path} has no native file`).toBe(
        true,
      );
    }
  });
});

describe("native-only modules", () => {
  it("are loaded only by a file with a .web counterpart, never by the web file itself", () => {
    const found: string[] = [];
    for (const { path, text } of sources()) {
      for (const use of usesIn(text)) {
        const native = NATIVE_ONLY.find((name) => isModule(use.module, name));
        if (native === undefined) continue;
        if (isWebFile(path)) {
          found.push(`${path} (the web file) loads ${native}`);
        } else if (!webSibling(path) && !KNOWN_GAPS.has(path)) {
          found.push(`${path} loads ${native} (${use.how}) with no .web counterpart`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it("have no known gap that has since been closed", () => {
    for (const path of KNOWN_GAPS.keys()) {
      expect(webSibling(path), `${path} now has a web file: remove it from KNOWN_GAPS`).toBe(false);
    }
  });

  it("are not imported by name from a screen through a relative path that skips the web file", () => {
    // Metro swaps in `name.web.ts` only for an `#src/...` import (metro.config.js), so a relative import would not.
    const found: string[] = [];
    for (const { path, text } of sources()) {
      for (const { module } of usesIn(text)) {
        if (!module.startsWith(".")) continue;
        const target = resolve(dirname(join(ROOT, path)), module);
        if (existsSync(target) && webSibling(relative(ROOT, target).replaceAll("\\", "/"))) {
          found.push(`${path} imports ${module}`);
        }
      }
    }
    expect(found).toEqual([]);
  });
});

describe("web-only modules", () => {
  it("are loaded by .web files alone", () => {
    const found: string[] = [];
    for (const { path, text } of sources()) {
      for (const use of usesIn(text)) {
        const web = WEB_ONLY.find((name) => isModule(use.module, name));
        if (web !== undefined && !isWebFile(path)) {
          found.push(`${path} loads ${web}`);
        }
      }
    }
    expect(found).toEqual([]);
  });
});

/** The names a source file exports as values: type-only exports are erased, so a caller never needs them at run time. */
export function valueExportsOf(text: string): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(
    /^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    names.push(m[1] ?? "");
  }
  // `export const { native: pushNative, events: pushEvents } = ...`
  for (const m of text.matchAll(/^export\s+const\s+\{([^}]*)\}/gm)) {
    for (const part of (m[1] ?? "").split(",")) {
      const name = (part.split(":").pop() ?? "").trim();
      if (name !== "") names.push(name);
    }
  }
  // `export { a, b as c } from "..."`, but not `export type { ... }`.
  for (const m of text.matchAll(/^export\s+(?!type\b)\{([^}]*)\}/gm)) {
    for (const part of (m[1] ?? "").split(",")) {
      const name = (part.split(/\s+as\s+/).pop() ?? "").trim();
      if (name !== "") names.push(name);
    }
  }
  return [...new Set(names)].sort();
}

/** Native exports the browser never needs, each with the reason: `createPushNative` is the factory the push tests drive. */
const NATIVE_ONLY_EXPORTS: ReadonlyMap<string, string> = new Map([
  ["src/push/push-native.web.ts:createPushNative", "a test seam for the native sources"],
]);

describe("web shims keep the native file's shape", () => {
  it("reads the kinds of export it compares", () => {
    const text = [
      "export const a = 1;",
      "export async function b() {}",
      "export function c() {}",
      "export type D = string;",
      "export const { native: e, events: f } = make();",
      "export {",
      "  g,",
      "  h as i,",
      '} from "x";',
      'export type { J } from "y";',
    ].join("\n");
    expect(valueExportsOf(text)).toEqual(["a", "b", "c", "e", "f", "g", "i"]);
  });

  it("exports every value the native file exports", () => {
    const missing: string[] = [];
    const shims = sources().filter(({ path }) => isWebFile(path));
    expect(shims.length).toBeGreaterThan(5);
    for (const { path, text } of shims) {
      const native = readFileSync(join(ROOT, path.replace(".web.", ".")), "utf8");
      const have = new Set(valueExportsOf(text));
      for (const name of valueExportsOf(native)) {
        if (!have.has(name) && !NATIVE_ONLY_EXPORTS.has(`${path}:${name}`))
          missing.push(`${path} lacks ${name}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("#src imports", () => {
  it("always name a file extension, as Metro swaps in the .web file only for a full path", () => {
    const found: string[] = [];
    for (const { path, text } of sources()) {
      for (const { module } of usesIn(text)) {
        if (module.startsWith("#src/") && !/\.tsx?$/.test(module)) {
          found.push(`${path} imports ${module}`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it("is caught when an import has no extension", () => {
    const bad = usesIn(`import { x } from "#src/platform/haptics";`);
    expect(bad.map(({ module }) => module)).toEqual(["#src/platform/haptics"]);
    expect(/\.tsx?$/.test("#src/platform/haptics")).toBe(false);
  });
});
