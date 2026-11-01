import { describe, expect, it } from "vitest";
import { checkHomeContent, EMPTY_CONTENT, readHomeContent } from "#src/layout/home-content";
import {
  CONTACTS_MAX,
  FAQ_MAX,
  INFO_LIMITS,
  LIST_ITEMS_MAX,
  PAGE_BLOCKS_MAX,
  listItems,
  pageShown,
} from "#src/layout/info-content";

const empty = { ar: "", en: "" };
const words = (en: string, ar = "") => ({ ar, en });

const faq = (question = "Is parking free?", answer = "Yes, in lot B.") => ({
  question: words(question),
  answer: words(answer),
});
const contact = (kind: string, value: string, label = "Front desk") => ({
  label: words(label),
  kind,
  value,
});
const part = (changes: Record<string, unknown> = {}) => ({
  kind: "text",
  text: words("No bags inside."),
  ...changes,
});
const page = (changes: Record<string, unknown> = {}) => ({
  title: words("Venue rules"),
  blocks: [part()],
  ...changes,
});
const items = (lines: string[]) => ({ kind: "list", items: words(lines.join("\n")) });
const content = (changes: Record<string, unknown> = {}) => ({ ...EMPTY_CONTENT, ...changes });

const checked = (changes: Record<string, unknown>) => checkHomeContent(content(changes));
const issuePaths = (changes: Record<string, unknown>): string[] => {
  const result = checked(changes);
  return result.ok ? [] : result.issues.map((issue) => issue.path);
};
const stored = (changes: Record<string, unknown>) => {
  const result = checked(changes);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
};

describe("the About text and the questions", () => {
  it("accepts all of them and keeps a line break in the About text and in an answer", () => {
    const value = stored({
      about: words("A day of games.\n\nBring a friend.", "يوم من الألعاب."),
      faq: [faq("Where?", "Hall 2.\nLevel 1.")],
    });
    expect(value.about.en).toBe("A day of games.\n\nBring a friend.");
    expect(value.faq[0]?.answer.en).toBe("Hall 2.\nLevel 1.");
  });

  it("cleans the text: invisible and control characters go, Arabic-Indic digits become Western", () => {
    const value = stored({ about: words("Doors\u0000 open​ at ٩"), faq: [faq("Q\u0007?", "A")] });
    expect(value.about.en).toBe("Doors open at 9");
    expect(value.faq[0]?.question.en).toBe("Q?");
  });

  it("needs a question and an answer in some language, and no more than the limits", () => {
    expect(issuePaths({ faq: [faq("", "x")] })).toEqual(["content.faq.0.question"]);
    expect(issuePaths({ faq: [{ question: words("x"), answer: empty }] })).toEqual([
      "content.faq.0.answer",
    ]);
    expect(issuePaths({ about: words("x".repeat(INFO_LIMITS.about + 1)) })).toEqual([
      "content.about.en",
    ]);
    expect(issuePaths({ faq: Array.from({ length: FAQ_MAX + 1 }, () => faq()) })).toEqual([
      "content.faq",
    ]);
  });

  it("refuses a field the entry does not have", () => {
    expect(issuePaths({ faq: [{ ...faq(), html: "<b>x</b>" }] })).toEqual(["content.faq.0.html"]);
  });
});

describe("contacts", () => {
  it("accepts an email address, a phone number and an https link", () => {
    const value = stored({
      contacts: [
        contact("email", "desk@example.com"),
        contact("phone", "+966 50 123-4567"),
        contact("link", "https://example.com/event"),
      ],
    });
    expect(value.contacts.map((entry) => entry.value)).toEqual([
      "desk@example.com",
      "+966501234567",
      "https://example.com/event",
    ]);
  });

  it("makes Arabic-Indic digits Western in a phone number", () => {
    expect(stored({ contacts: [contact("phone", "٠٥٠١٢٣٤٥٦٧")] }).contacts[0]?.value).toBe(
      "0501234567",
    );
  });

  it.each([
    ["email", "desk@example"],
    ["email", "desk@example.com?subject=hi"],
    ["email", "a%0d%0ab@example.com"],
    ["email", "desk@example.com&bcc=x@y.com"],
    ["email", "a b@example.com"],
    ["phone", "12345"],
    ["phone", "+966501234567890123"],
    ["phone", "tel:+966501234567"],
    ["phone", "050-abc"],
    ["link", "http://example.com"],
    ["link", "javascript:alert(1)"],
    ["link", "https://user@example.com"],
    ["link", "mailto:desk@example.com"],
    ["kind", "desk@example.com"],
  ])("refuses a %s contact of %j", (kind, value) => {
    expect(issuePaths({ contacts: [contact(kind, value)] })).toEqual(
      kind === "kind" ? ["content.contacts.0.kind"] : ["content.contacts.0.value"],
    );
  });

  it("needs a name, and takes at most five", () => {
    expect(issuePaths({ contacts: [contact("email", "a@example.com", "")] })).toEqual([
      "content.contacts.0.label",
    ]);
    const many = Array.from({ length: CONTACTS_MAX + 1 }, () => contact("phone", "0501234567"));
    expect(issuePaths({ contacts: many })).toEqual(["content.contacts"]);
  });
});

describe("the custom page", () => {
  it("accepts a title and parts of every kind", () => {
    const value = stored({
      page: page({
        blocks: [
          { kind: "heading", text: words("Before you come") },
          part(),
          { kind: "list", items: words("ID card\n\nTicket\nWater bottle") },
          { kind: "link", label: words("Map of the hall"), url: "https://example.com/map" },
        ],
      }),
    });
    expect(value.page?.blocks).toHaveLength(4);
    expect(value.page?.blocks[2]).toEqual({
      kind: "list",
      items: words("ID card\nTicket\nWater bottle"),
    });
    expect(pageShown(value.page)).toBe(true);
  });

  it("allows no page", () => {
    expect(checked({ page: null }).ok).toBe(true);
    expect(pageShown(null)).toBe(false);
  });

  it("needs a title and at least one part", () => {
    expect(issuePaths({ page: page({ title: empty }) })).toEqual(["content.page.title"]);
    expect(issuePaths({ page: page({ blocks: [] }) })).toEqual(["content.page.blocks"]);
  });

  it("refuses a part that is not valid, naming where", () => {
    expect(issuePaths({ page: page({ blocks: [part({ text: empty })] }) })).toEqual([
      "content.page.blocks.0.text",
    ]);
    expect(issuePaths({ page: page({ blocks: [{ kind: "video", url: "x" }] }) })).toEqual([
      "content.page.blocks.0.kind",
    ]);
    expect(issuePaths({ page: page({ blocks: [part({ image: "x" })] }) })).toEqual([
      "content.page.blocks.0.image",
    ]);
    const badLink = { kind: "link", label: words("Go"), url: "http://example.com" };
    expect(issuePaths({ page: page({ blocks: [badLink] }) })).toEqual([
      "content.page.blocks.0.url",
    ]);
    const tooMany = Array.from({ length: PAGE_BLOCKS_MAX + 1 }, () => part());
    expect(issuePaths({ page: page({ blocks: tooMany }) })).toEqual(["content.page.blocks"]);
  });

  it("limits a list to ten items of 120 characters", () => {
    const ten = Array.from({ length: LIST_ITEMS_MAX }, (_, i) => `Item ${i}`);
    expect(checked({ page: page({ blocks: [items(ten)] }) }).ok).toBe(true);
    expect(issuePaths({ page: page({ blocks: [items([...ten, "One more"])] }) })).toEqual([
      "content.page.blocks.0.items",
    ]);
    expect(issuePaths({ page: page({ blocks: [items(["x".repeat(121)])] }) })).toEqual([
      "content.page.blocks.0.items",
    ]);
  });

  it("needs a list to hold an item", () => {
    expect(
      issuePaths({ page: page({ blocks: [{ kind: "list", items: words("\n \n") }] }) }),
    ).toEqual(["content.page.blocks.0.items"]);
  });

  it("cleans a heading, a paragraph and a link label like any other text", () => {
    const value = stored({
      page: page({
        title: words("Rules\u0000 ​"),
        blocks: [{ kind: "heading", text: words("Safe\u0001ty") }],
      }),
    });
    expect(value.page?.title.en).toBe("Rules");
    expect(value.page?.blocks[0]).toEqual({ kind: "heading", text: words("Safety") });
  });
});

describe("the strict check asks for every part", () => {
  it("lists the four parts of the info page and the page as required", () => {
    const result = checkHomeContent({
      banner: [],
      quickLinks: [],
      featured: null,
      cards: [],
    });
    expect(result.ok ? [] : result.issues.map((issue) => issue.path)).toEqual([
      "content.about",
      "content.faq",
      "content.contacts",
      "content.page",
    ]);
  });
});

describe("readHomeContent on what was stored", () => {
  it("reads content saved before the info page existed as empty", () => {
    const older = { banner: [], quickLinks: [], featured: null, cards: [] };
    expect(readHomeContent(older)).toEqual(EMPTY_CONTENT);
  });

  it("leaves out an entry or a part that is damaged and keeps the rest", () => {
    const read = readHomeContent(
      content({
        faq: [faq(), { question: 3 }, "x"],
        contacts: [contact("email", "bad"), contact("phone", "0501234567")],
        page: page({ blocks: [{ kind: "video" }, part(), 7] }),
      }),
    );
    expect(read.faq).toEqual([faq()]);
    expect(read.contacts.map((entry) => entry.kind)).toEqual(["phone"]);
    expect(read.page?.blocks).toEqual([part()]);
  });

  it.each([
    ["a page with no valid part", page({ blocks: [{ kind: "video" }] })],
    ["a page with no title", page({ title: empty })],
    ["a page that is not an object", "oops"],
    ["a page whose parts are not a list", { title: words("x"), blocks: "no" }],
  ])("reads %s as no page", (_name, damaged) => {
    expect(readHomeContent(content({ page: damaged })).page).toBeNull();
  });

  it("reads a phone number the way it is saved, so a draft's preview agrees with the saved page", () => {
    const read = readHomeContent(
      content({
        contacts: [contact("phone", " ٠٥٠ 123-4567 "), contact("email", " desk@example.com ")],
      }),
    );
    expect(read.contacts.map((entry) => entry.value)).toEqual(["0501234567", "desk@example.com"]);
  });

  it("never throws, whatever it is given", () => {
    for (const value of [null, 3, "x", [], { about: 5, faq: "x", contacts: {}, page: [] }]) {
      expect(() => readHomeContent(value)).not.toThrow();
    }
    expect(readHomeContent({ about: 5, faq: "x", contacts: {}, page: [] })).toEqual(EMPTY_CONTENT);
  });
});

describe("listItems", () => {
  it("is one item per non-empty line", () => {
    expect(listItems("a\n\n b \n \nc")).toEqual(["a", " b ", "c"]);
    expect(listItems("")).toEqual([]);
  });
});
