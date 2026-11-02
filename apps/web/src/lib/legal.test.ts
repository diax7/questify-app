import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LEGAL_DOCUMENT_IDS } from "@questify/shared";
import { fillContactPlaceholders, legalBlocks, legalTextBlocks } from "#src/lib/legal.ts";

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

  it("reads a published text, which holds one language, into the same blocks", () => {
    expect(legalTextBlocks("## The terms\n\nA paragraph.\n\n- one\n- two")).toEqual([
      { kind: "heading", level: 2, text: "The terms" },
      { kind: "paragraph", text: "A paragraph." },
      { kind: "list", items: ["one", "two"] },
    ]);
    expect(legalTextBlocks("<script>alert(1)</script>\n[x](javascript:y)")).toEqual([
      { kind: "paragraph", text: "x" },
    ]);
  });

  it.each([...LEGAL_DOCUMENT_IDS])(
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

describe("fillContactPlaceholders", () => {
  const blocks = legalTextBlocks(
    [
      "## Contact",
      "",
      "Privacy: {{PRIVACY_CONTACT}}. Support: {{CONTACT_EMAIL}}.",
      "",
      "- Write to {{CONTACT_EMAIL}}",
      "- Entity: {{LEGAL_ENTITY_NAME}}",
    ].join("\n"),
  );

  it("puts the support email in the contact placeholders, headings, paragraphs and lists alike", () => {
    expect(fillContactPlaceholders(blocks, "help@questify.sa")).toEqual([
      { kind: "heading", level: 2, text: "Contact" },
      { kind: "paragraph", text: "Privacy: help@questify.sa. Support: help@questify.sa." },
      { kind: "list", items: ["Write to help@questify.sa", "Entity: {{LEGAL_ENTITY_NAME}}"] },
    ]);
  });

  it("leaves every placeholder when no email is set", () => {
    expect(fillContactPlaceholders(blocks, null)).toEqual(blocks);
  });
});
