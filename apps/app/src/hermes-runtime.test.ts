import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";

/**
 * Built-ins that Node (where the tests run) has and the Hermes engine in the release app lacks. Calling one passes
 * every unit test and then crashes the phone with "undefined is not a function" (the T-302 APK crashed at launch on
 * Array.prototype.toSorted in fontFor). Remove an entry only once the shipped Hermes has it.
 */
const MISSING_METHODS = new Set([
  "toSorted",
  "toReversed",
  "toSpliced",
  "with",
  "isWellFormed",
  "toWellFormed",
  "union",
  "intersection",
  "difference",
  "symmetricDifference",
  "isSubsetOf",
  "isSupersetOf",
  "isDisjointFrom",
]);
const MISSING_STATICS = new Set([
  "Object.groupBy",
  "Map.groupBy",
  "Promise.withResolvers",
  "Array.fromAsync",
  "Iterator.from",
  "Error.isError",
  "Math.sumPrecise",
]);
const MISSING_GLOBALS = new Set(["structuredClone", "FinalizationRegistry"]);

/** Every source file bundled into the app: its screens, its modules and the shared package. */
const ROOTS = [
  ["..", "app"],
  ["..", "src"],
  ["..", "..", "..", "packages", "shared", "src"],
].map((parts) => join(import.meta.dirname, ...parts));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter(
      (entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name),
    )
    .map((entry) => `${entry.parentPath}/${entry.name}`);
}

type Node = { type: string; loc?: { start: { line: number } } | null } & Record<string, unknown>;

function isNode(value: unknown): value is Node {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function nameOf(node: unknown): string | undefined {
  return isNode(node) && node.type === "Identifier" ? (node["name"] as string) : undefined;
}

/** The missing built-in a call expression calls, if any. */
function callee(target: unknown): string | undefined {
  const global = nameOf(target);
  if (global !== undefined) {
    return MISSING_GLOBALS.has(global) ? global : undefined;
  }
  if (!isNode(target) || target.type !== "MemberExpression" || target["computed"] === true) {
    return undefined;
  }
  const name = nameOf(target["property"]) ?? "";
  const owner = `${nameOf(target["object"]) ?? ""}.${name}`;
  if (MISSING_STATICS.has(owner)) {
    return owner;
  }
  return MISSING_METHODS.has(name) ? `.${name}()` : undefined;
}

/** Each call in the text to a built-in the release Hermes lacks, as "file:line name". */
function missingCalls(fileName: string, text: string): string[] {
  const ast = parse(text, { sourceType: "module", plugins: ["typescript", "jsx"] });
  const found: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isNode(value)) {
      return;
    }
    const name = value.type === "CallExpression" ? callee(value["callee"]) : undefined;
    if (name !== undefined) {
      found.push(`${fileName}:${value.loc?.start.line ?? 0} ${name}`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== "loc" && typeof child === "object") {
        visit(child);
      }
    }
  };
  visit(ast.program);
  return found;
}

describe("the app bundle calls only built-ins the release Hermes has", () => {
  it("finds no call to a missing built-in in the app or the shared package", () => {
    const files = ROOTS.flatMap(sourceFiles);
    expect(files.length).toBeGreaterThan(50);
    expect(files.flatMap((file) => missingCalls(file, readFileSync(file, "utf8")))).toEqual([]);
  });

  it("catches methods, statics and globals, and leaves the safe forms alone", () => {
    const text = [
      "const a = list.toSorted((x, y) => x - y);",
      "const b = Object.groupBy(list, key);",
      "const c = structuredClone(value);",
      "const d = [...list].sort().at(-1);",
      "const e = names.toSorted;",
    ].join("\n");
    expect(missingCalls("sample.ts", text)).toEqual([
      "sample.ts:1 .toSorted()",
      "sample.ts:2 Object.groupBy",
      "sample.ts:3 structuredClone",
    ]);
  });
});
