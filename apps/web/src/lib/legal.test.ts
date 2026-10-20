import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { organizerDocuments } from "@questify/shared";
import { legalBlocks } from "#src/lib/legal.ts";

const SAMPLE = [
  "---",
  "document: x",
  "---",
  "",
  "# عنوان | Title",
  "",
  '<div dir="rtl" lang="ar">',
  "",
  "## الشروط",
  "",
  "نص **مهم** في سطرين",
  "يكمل هنا.",
  "",
  "- بند أول",
  "- بند [ثانٍ](https://x.test)",
  "",
  "</div>",
  "",
  "---",
  "",
  "## The terms",
  "",
  "### 1. Who we are",
  "",
  "A paragraph.",
  "<script>alert(1)</script>",
  "- one",
  "- two",
  "After the list.",
].join("\n");

describe("legalBlocks", () => {
  it("takes the Arabic half and turns it into headings, paragraphs and lists, as plain text", () => {
    expect(legalBlocks(SAMPLE, "ar")).toEqual([
      { kind: "heading", level: 2, text: "الشروط" },
      { kind: "paragraph", text: "نص مهم في سطرين يكمل هنا." },
      { kind: "list", items: ["بند أول", "بند ثانٍ"] },
    ]);
  });

  it("takes the English half, and never passes HTML from the file through", () => {
    expect(legalBlocks(SAMPLE, "en")).toEqual([
      { kind: "heading", level: 2, text: "The terms" },
      { kind: "heading", level: 3, text: "1. Who we are" },
      { kind: "paragraph", text: "A paragraph." },
      { kind: "list", items: ["one", "two"] },
      { kind: "paragraph", text: "After the list." },
    ]);
  });

  it("gives nothing for a file without the two halves", () => {
    expect(legalBlocks("# just a title", "en")).toEqual([]);
  });

  it.each(organizerDocuments().map((document) => document.id))(
    "reads the %s draft in both languages, starting with a heading",
    (id) => {
      const file = readFileSync(
        join(
          import.meta.dirname,
          "..",
          "..",
          "..",
          "..",
          "docs",
          "legal",
          `${id.replaceAll("_", "-")}.md`,
        ),
        "utf8",
      );
      for (const language of ["ar", "en"] as const) {
        const blocks = legalBlocks(file, language);
        expect(blocks.length).toBeGreaterThan(5);
        expect(blocks[0]?.kind).toBe("heading");
      }
    },
  );
});
