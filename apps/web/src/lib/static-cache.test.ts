import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STATIC_FILE_RULES } from "#src/lib/static-cache.ts";

const PUBLIC = join(import.meta.dirname, "..", "..", "public");

/** Every file under `public/`, as the address it is served at; `play/` is the generated player build (gitignored). */
function addresses(folder: string, prefix = ""): string[] {
  return readdirSync(folder, { withFileTypes: true })
    .filter((entry) => prefix !== "" || entry.name !== "play")
    .flatMap((entry) =>
      entry.isDirectory()
        ? addresses(join(folder, entry.name), `${prefix}/${entry.name}`)
        : [`${prefix}/${entry.name}`],
    );
}

/** A rule's source as a pattern: the three forms the rules use, `:name(a|b)`, `:name*` and a plain `:name`. */
function pattern(source: string): RegExp {
  const text = source
    .replace(/\./g, "\\.")
    .replace(/:[a-z]+(?![a-z(*])/g, "[^/]+")
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

  it.each(["/avatars", "/avatars/", "/brand/missing", "/currency/missing.gif", "/avatars/a/b.txt"])(
    "%s, which is no file of the art, is covered by no rule",
    (address) => {
      expect(rules.filter((rule) => rule.matches.test(address))).toHaveLength(0);
    },
  );

  it("keeps only the versioned decoder and the hashed player build for a year", () => {
    const year = rules.filter((rule) => rule.value.includes("immutable"));
    expect(year).toHaveLength(3);
    expect(year[0]?.matches.test("/zxing/zxing_reader-3.1.6.wasm")).toBe(true);
  });

  it.each([
    "/play/_expo/static/js/web/entry-4ba5283d49d67717391304b9e8999e0e.js",
    "/play/assets/assets/icons/flame.c2a93ac71c7488df14e3874578a52dcc.webp",
  ])("keeps the player build's hashed file %s for a year", (address) => {
    const hit = rules.filter((rule) => rule.matches.test(address));
    expect(hit).toHaveLength(1);
    expect(hit[0]?.value).toContain("immutable");
  });

  it.each(["/play", "/play/", "/play/index.html", "/play/metadata.json", "/play/event/1"])(
    "%s, the player page, is covered by no rule (it stays no-store)",
    (address) => {
      expect(rules.filter((rule) => rule.matches.test(address))).toHaveLength(0);
    },
  );
});
