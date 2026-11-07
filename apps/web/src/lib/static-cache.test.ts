import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STATIC_FILE_RULES } from "#src/lib/static-cache.ts";

const PUBLIC = join(import.meta.dirname, "..", "..", "public");

/** Every file under `public/`, as the address it is served at. */
function addresses(folder: string, prefix = ""): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? addresses(join(folder, entry.name), `${prefix}/${entry.name}`)
      : [`${prefix}/${entry.name}`],
  );
}

/** A rule's source as a pattern: the two forms the rules use, `:name(a|b)` and `:name*`. */
function pattern(source: string): RegExp {
  const text = source
    .replace(/\./g, "\\.")
    .replace(/:[a-z]+\(([^)]+)\)/g, "(?:$1)")
    .replace(/:[a-z]+\*/g, ".*");
  return new RegExp(`^${text}$`);
}

describe("the cache rules for the files in public/", () => {
  const rules = STATIC_FILE_RULES.map((rule) => ({
    matches: pattern(rule.source),
    value: rule.headers.find((header) => header.key === "Cache-Control")?.value ?? "",
  }));

  it.each(addresses(PUBLIC))("%s is covered by exactly one rule", (address) => {
    expect(rules.filter((rule) => rule.matches.test(address))).toHaveLength(1);
  });

  it("keeps only the versioned decoder for a year", () => {
    const year = rules.filter((rule) => rule.value.includes("immutable"));
    expect(year).toHaveLength(1);
    expect(year[0]?.matches.test("/zxing/zxing_reader-3.1.6.wasm")).toBe(true);
  });
});
