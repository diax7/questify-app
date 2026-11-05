import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAst } from "vitest/node";

/**
 * Outside calls never follow a redirect (V15.3.2, ADR-701): every `fetch` call in the API, and in every server-side
 * file of the web (all of `apps/web/src` but client files, the forwarder and `post-json.ts`), passes
 * `redirect: "error"`, so a hostile or hijacked provider cannot bounce a request, its bearer or its body somewhere
 * else. Parsed, not matched by text: a call counts when its callee is named like a fetch (`fetch`, `options.fetch`,
 * `request.fetchImpl ?? fetch`) or is a variable set from one (`const call = options.fetch ?? fetch`). The forwarder
 * (`forward.ts`) keeps `"manual"`: it passes the API's own answer through.
 */

/** Web files known to call the API from the server: the walk must find each of them. */
const WEB_SERVER_CALLS = [
  "event-card.ts",
  "event-terms.ts",
  "event-rules.ts",
  "legal-api.ts",
  "staff-api.ts",
];

/** Web files left out of the walk: the forwarder (`"manual"`, see above) and the browser's own same-origin calls. */
const WEB_NOT_SERVER_CALLS = new Set(["lib/forward.ts", "lib/post-json.ts"]);

/** A file that runs in the browser (a `"use client"` directive), whose calls never leave the web origin. */
const CLIENT_FILE = /^\s*["']use client["']/mu;

type Node = Readonly<Record<string, unknown>> & { type: string };

const FETCH_NAME = /fetch(Impl)?$/i;

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof (value as Node).type === "string";

function children(node: Node): Node[] {
  return Object.values(node).flatMap((value) =>
    Array.isArray(value) ? value.filter(isNode) : isNode(value) ? [value] : [],
  );
}

function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (const child of children(node)) {
    walk(child, visit);
  }
}

/** Whether an expression is, or may evaluate to, a fetch function. */
function isFetchLike(node: unknown, aliases: ReadonlySet<string>): boolean {
  if (!isNode(node)) {
    return false;
  }
  switch (node.type) {
    case "Identifier":
      return FETCH_NAME.test(String(node["name"])) || aliases.has(String(node["name"]));
    case "MemberExpression":
      return isFetchLike(node["property"], new Set());
    case "LogicalExpression":
      return isFetchLike(node["left"], aliases) || isFetchLike(node["right"], aliases);
    case "ConditionalExpression":
      return isFetchLike(node["consequent"], aliases) || isFetchLike(node["alternate"], aliases);
    case "ParenthesizedExpression":
    case "TSAsExpression":
    case "TSNonNullExpression":
      return isFetchLike(node["expression"], aliases);
    default:
      return false;
  }
}

function passesRedirectError(init: unknown): boolean {
  if (!isNode(init) || init.type !== "ObjectExpression") {
    return false;
  }
  return (init["properties"] as Node[]).some((property) => {
    const key = property["key"];
    const value = property["value"];
    return (
      property.type === "Property" &&
      isNode(key) &&
      (key["name"] === "redirect" || key["value"] === "redirect") &&
      isNode(value) &&
      value["value"] === "error"
    );
  });
}

type FetchCall = Readonly<{ file: string; line: number; redirectError: boolean }>;

/** Every fetch call in one file, with whether it refuses redirects. */
export function fetchCallsIn(file: string, text: string): FetchCall[] {
  const lang = file.endsWith(".tsx") ? "tsx" : "ts";
  const program = parseAst(text, { lang, sourceType: "module" }) as unknown as Node;
  const aliases = new Set<string>();
  walk(program, (node) => {
    const id = node["id"];
    if (node.type === "VariableDeclarator" && isNode(id) && isFetchLike(node["init"], aliases)) {
      aliases.add(String(id["name"]));
    }
  });
  const calls: FetchCall[] = [];
  walk(program, (node) => {
    if (node.type === "CallExpression" && isFetchLike(node["callee"], aliases)) {
      const args = node["arguments"] as unknown[];
      calls.push({
        file,
        line: text.slice(0, Number(node["start"])).split("\n").length,
        redirectError: passesRedirectError(args[1]),
      });
    }
  });
  return calls;
}

const TEST_FILE = /\.test(-support)?\.tsx?$/u;

function sources(directory: string, extension: RegExp): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sources(path, extension);
    }
    return extension.test(entry.name) && !TEST_FILE.test(entry.name) ? [path] : [];
  });
}

/** Every web source file whose calls run on the server: all but the forwarder, the browser helper and client files. */
function webServerSources(web: string): string[] {
  return sources(web, /\.tsx?$/u)
    .filter((path) => !WEB_NOT_SERVER_CALLS.has(relative(web, path).replaceAll("\\", "/")))
    .filter((path) => !CLIENT_FILE.test(readFileSync(path, "utf8")));
}

describe("outside calls never follow a redirect (ADR-701)", () => {
  const api = join(import.meta.dirname);
  const web = join(import.meta.dirname, "..", "..", "web", "src");
  const files = [
    ...sources(api, /\.ts$/u).map((path) => ({ name: `api/${relative(api, path)}`, path })),
    ...webServerSources(web).map((path) => ({ name: `web/${relative(web, path)}`, path })),
  ];
  const calls = files.flatMap(({ name, path }) =>
    fetchCallsIn(name.replaceAll("\\", "/"), readFileSync(path, "utf8")),
  );

  it("finds the calls it guards, so the check cannot pass on nothing", () => {
    const where = new Set(calls.map((call) => call.file));
    for (const file of [
      "api/auth/breached.ts",
      "api/auth/email/gmail.ts",
      "api/auth/email/resend.ts",
      "api/auth/google-token.ts",
      "api/players/sms.ts",
      ...WEB_SERVER_CALLS.map((name) => `web/lib/${name}`),
    ]) {
      expect(where, file).toContain(file);
    }
  });

  it("walks the web's server files and leaves out its client files, the forwarder and the browser helper", () => {
    const names = files.map((file) => file.name.replaceAll("\\", "/"));
    expect(names.some((name) => name.startsWith("web/app/"))).toBe(true);
    for (const left of [
      "web/lib/forward.ts",
      "web/lib/post-json.ts",
      "web/components/SignOutButton.tsx",
      "web/components/AnalyticsExports.tsx",
    ]) {
      expect(names, left).not.toContain(left);
    }
  });

  it('passes redirect: "error" on every one', () => {
    expect(calls.filter((call) => !call.redirectError)).toEqual([]);
  });

  it.each([
    ["a bare fetch", 'await fetch(url, { method: "POST" });'],
    ["an injected one", "await options.fetch(url, { signal });"],
    ["a fallback", "await (request.fetchImpl ?? fetch)(url, {});"],
    ["an alias", "const call = options.fetch ?? fetch;\nawait call(url, { redirect: 'follow' });"],
    ["no init at all", "await fetch(url);"],
  ])("catches %s that forgets it", (_name, text) => {
    expect(fetchCallsIn("x.ts", text)).toEqual([expect.objectContaining({ redirectError: false })]);
  });

  it("reads a .tsx file", () => {
    expect(fetchCallsIn("x.tsx", "const page = <main />;\nawait fetch(url);")).toEqual([
      expect.objectContaining({ redirectError: false }),
    ]);
  });

  it("does not count a call that is not a fetch", () => {
    expect(fetchCallsIn("x.ts", "await fetchCard(request); send(url, {});")).toEqual([]);
  });
});
