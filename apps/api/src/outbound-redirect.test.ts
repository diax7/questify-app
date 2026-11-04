import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAst } from "vitest/node";

/**
 * Outside calls never follow a redirect (V15.3.2, ADR-701): every `fetch` call in the API, and in the web's server-side
 * calls to the API, passes `redirect: "error"`, so a hostile or hijacked provider cannot bounce a request, its bearer
 * or its body somewhere else. Parsed, not matched by text: a call counts when its callee is named like a fetch
 * (`fetch`, `options.fetch`, `request.fetchImpl ?? fetch`) or is a variable set from one (`const call = options.fetch
 * ?? fetch`). The forwarder (`forward.ts`) keeps `"manual"`: it passes the API's own answer through.
 */
const WEB_SERVER_CALLS = [
  "event-card.ts",
  "event-terms.ts",
  "event-rules.ts",
  "legal-api.ts",
  "staff-api.ts",
];

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
  const program = parseAst(text, { lang: "ts", sourceType: "module" }) as unknown as Node;
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

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sources(path);
    }
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("outside calls never follow a redirect (ADR-701)", () => {
  const api = join(import.meta.dirname);
  const web = join(import.meta.dirname, "..", "..", "web", "src", "lib");
  const files = [
    ...sources(api).map((path) => ({ name: `api/${relative(api, path)}`, path })),
    ...WEB_SERVER_CALLS.map((name) => ({ name: `web/lib/${name}`, path: join(web, name) })),
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

  it("does not count a call that is not a fetch", () => {
    expect(fetchCallsIn("x.ts", "await fetchCard(request); send(url, {});")).toEqual([]);
  });
});
