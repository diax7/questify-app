import {
  DEFAULT_LAYOUT,
  EMPTY_CONTENT,
  HOME_CARDS_MAX,
  PAGE_BLOCKS_MAX,
  composedLayoutOf,
  readEventLayout,
  type EventLayout,
  type HomeContent,
  type MessageKey,
} from "@questify/shared";
import { describe, expect, it } from "vitest";
import {
  addCard,
  canAddCard,
  canAddPart,
  contentProblem,
  emptyContact,
  emptyFaq,
  emptyLink,
  emptyPage,
  emptyPart,
  emptySlide,
  homeLabel,
  moveWithin,
  newCountdownCard,
  newTextCard,
  newCardId,
  pickText,
  removeCard,
  replaceCard,
} from "#src/lib/home-content-editor.ts";

const AT = "2030-01-01T09:00:00.000Z";
const t = (key: MessageKey) => key;
const text = (id: string, en: string) => ({ ...newTextCard(id), body: { ar: "", en } });

describe("newCardId", () => {
  it("gives eight lowercase letters or digits, which a card id may be", () => {
    for (let run = 0; run < 50; run += 1) {
      expect(newCardId()).toMatch(/^[a-z0-9]{8}$/);
    }
    expect(newCardId(new Uint8Array([0, 1, 25, 26, 35, 36, 255, 7]))).toBe("abz09adh");
  });
});

describe("adding, changing and removing a card", () => {
  it("adds a card shown at the end of Home, and the new layout passes the server's check", () => {
    const layout = addCard(DEFAULT_LAYOUT, text("aaaaaa11", "Doors open"));
    expect(layout.home.order.at(-1)).toBe("card:aaaaaa11");
    expect(layout.home.hidden).toEqual(DEFAULT_LAYOUT.home.hidden);
    expect(layout.content.cards).toHaveLength(1);
    expect(readEventLayout(layout)).toEqual(layout);
  });

  it("changes one card and leaves the others", () => {
    const two = addCard(addCard(DEFAULT_LAYOUT, text("aaaaaa11", "One")), text("bbbbbb22", "Two"));
    const changed = replaceCard(two, text("bbbbbb22", "Changed"));
    expect(changed.content.cards.map((card) => card.kind === "text" && card.body.en)).toEqual([
      "One",
      "Changed",
    ]);
  });

  it("removes a card with its place and its switch, and nothing else", () => {
    const hiddenCard: EventLayout = {
      ...addCard(addCard(DEFAULT_LAYOUT, text("aaaaaa11", "One")), text("bbbbbb22", "Two")),
    };
    const switchedOff: EventLayout = {
      ...hiddenCard,
      home: { ...hiddenCard.home, hidden: ["card:aaaaaa11"] },
    };
    const removed = removeCard(switchedOff, "aaaaaa11");
    expect(removed.content.cards.map((card) => card.id)).toEqual(["bbbbbb22"]);
    expect(removed.home.order).not.toContain("card:aaaaaa11");
    expect(removed.home.hidden).toEqual([]);
    expect(removed.home.order.at(-1)).toBe("card:bbbbbb22");
  });

  it("stops offering a card at the limit", () => {
    let layout: EventLayout = DEFAULT_LAYOUT;
    for (let index = 0; index < HOME_CARDS_MAX; index += 1) {
      expect(canAddCard(layout)).toBe(true);
      layout = addCard(layout, text(`card${index}xxx`, "x"));
    }
    expect(canAddCard(layout)).toBe(false);
  });

  it("starts a countdown that hides at zero, with its moment", () => {
    expect(newCountdownCard("cccccc33", AT)).toMatchObject({
      kind: "countdown",
      at: AT,
      atZero: "hide",
    });
  });
});

describe("moveWithin", () => {
  it("swaps with the neighbour and leaves the ends alone", () => {
    expect(moveWithin(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveWithin(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"]);
    expect(moveWithin(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
    expect(moveWithin(["a", "b", "c"], 2, 1)).toEqual(["a", "b", "c"]);
    expect(moveWithin([], 0, 1)).toEqual([]);
  });
});

describe("homeLabel", () => {
  it("names a block by its title and a card by its own words, or by its kind while it has none", () => {
    const layout = addCard(
      addCard(DEFAULT_LAYOUT, { ...text("aaaaaa11", "x"), title: { ar: "أهلًا", en: "Welcome" } }),
      newCountdownCard("bbbbbb22", AT),
    );
    expect(homeLabel("banner", layout.content, "en", t)).toBe("layout.block.banner");
    expect(homeLabel("card:aaaaaa11", layout.content, "en", t)).toBe("Welcome");
    expect(homeLabel("card:aaaaaa11", layout.content, "ar", t)).toBe("أهلًا");
    expect(homeLabel("card:bbbbbb22", layout.content, "en", t)).toBe("layout.card.countdown");
    expect(homeLabel("card:gone0000", layout.content, "en", t)).toBe("card:gone0000");
  });

  it("falls back to the other language", () => {
    expect(pickText({ ar: "", en: "Only English" }, "ar")).toBe("Only English");
  });
});

const content = (changes: Partial<HomeContent>): HomeContent => ({
  ...EMPTY_CONTENT,
  ...changes,
});
const titled = { ...emptySlide(), title: { ar: "", en: "Hi" } };
const labelled = { ...emptyLink(), label: { ar: "", en: "Go" } };

describe("contentProblem", () => {
  it("finds nothing wrong with empty content or with content that can be saved", () => {
    expect(contentProblem(content({}))).toBeNull();
    expect(
      contentProblem(
        content({ banner: [titled], quickLinks: [labelled], cards: [text("aaaaaa11", "x")] }),
      ),
    ).toBeNull();
  });

  it.each([
    [content({ banner: [titled, emptySlide()] }), "layout.problem.slideTitle", 2],
    [
      content({ quickLinks: [{ ...labelled, label: { ar: "", en: "" } }] }),
      "layout.problem.linkLabel",
      1,
    ],
    [
      content({ quickLinks: [{ ...labelled, action: { type: "link", url: "" } }] }),
      "layout.problem.url",
      1,
    ],
    [
      content({ banner: [{ ...titled, action: { type: "link", url: "http://a.example.com" } }] }),
      "layout.problem.url",
      1,
    ],
    [
      content({ banner: [{ ...titled, action: { type: "quest", questId: "" } }] }),
      "layout.problem.quest",
      1,
    ],
    [content({ featured: { kind: "reward", id: "" } }), "layout.problem.featured", 1],
    [
      content({ cards: [text("aaaaaa11", "x"), newTextCard("bbbbbb22")] }),
      "layout.problem.cardText",
      2,
    ],
    [
      content({ cards: [{ ...newCountdownCard("bbbbbb22", ""), label: { ar: "", en: "L" } }] }),
      "layout.problem.cardTime",
      1,
    ],
    [
      content({
        cards: [
          {
            ...newCountdownCard("bbbbbb22", AT),
            label: { ar: "", en: "L" },
            atZero: "message",
          },
        ],
      }),
      "layout.problem.cardMessage",
      1,
    ],
  ] as const)("says what to fix, and where, for %#", (draft, key, n) => {
    expect(contentProblem(draft)).toEqual({ key, n });
  });

  it("a layout built by the editor reads back the same, and shows its content when its blocks are shown", () => {
    const layout = addCard(DEFAULT_LAYOUT, text("aaaaaa11", "Hello"));
    expect(composedLayoutOf(layout).content.cards).toHaveLength(1);
  });
});

const words = (en: string) => ({ ar: "", en });
const filledFaq = { question: words("Where?"), answer: words("Hall 2") };
const filledContact = { label: words("Desk"), kind: "phone", value: "0501234567" } as const;
const filledPage = {
  title: words("Rules"),
  blocks: [{ kind: "text", text: words("No bags") }],
} as const;

describe("the info page and the extra page", () => {
  it("starts every new entry empty, so it cannot be saved until it is written", () => {
    expect(contentProblem(content({ faq: [emptyFaq()] }))).toEqual({
      key: "layout.problem.faq",
      n: 1,
    });
    expect(contentProblem(content({ contacts: [emptyContact()] }))).toEqual({
      key: "layout.problem.contactLabel",
      n: 1,
    });
    expect(contentProblem(content({ page: emptyPage() }))).toEqual({
      key: "layout.problem.pageTitle",
      n: 1,
    });
  });

  it("finds nothing wrong once the entries are written, and for no page at all", () => {
    expect(
      contentProblem(
        content({
          about: words("Hi"),
          faq: [filledFaq],
          contacts: [filledContact],
          page: filledPage,
        }),
      ),
    ).toBeNull();
    expect(contentProblem(content({ page: null }))).toBeNull();
  });

  it.each([
    [content({ faq: [filledFaq, emptyFaq()] }), "layout.problem.faq", 2],
    [
      content({ contacts: [{ ...filledContact, label: { ar: "", en: "" } }] }),
      "layout.problem.contactLabel",
      1,
    ],
    [
      content({ contacts: [filledContact, { ...filledContact, value: "tel:123" }] }),
      "layout.problem.contactValue",
      2,
    ],
    [
      content({ contacts: [{ ...filledContact, kind: "link", value: "http://a.example.com" }] }),
      "layout.problem.contactValue",
      1,
    ],
    [content({ page: { ...filledPage, title: words("") } }), "layout.problem.pageTitle", 1],
    [content({ page: { ...filledPage, blocks: [] } }), "layout.problem.pageEmpty", 1],
    [
      content({ page: { ...filledPage, blocks: [filledPage.blocks[0], emptyPart("heading")] } }),
      "layout.problem.pagePart",
      2,
    ],
    [
      content({ page: { ...filledPage, blocks: [emptyPart("link")] } }),
      "layout.problem.pagePart",
      1,
    ],
  ] as const)("says what to fix, and where, for %#", (draft, key, n) => {
    expect(contentProblem(draft)).toEqual({ key, n });
  });

  it("makes a part of each kind, and stops offering parts at the limit", () => {
    expect(
      ["heading", "text", "list", "link"].map((kind) => emptyPart(kind as never).kind),
    ).toEqual(["heading", "text", "list", "link"]);
    const full = {
      ...filledPage,
      blocks: Array.from({ length: PAGE_BLOCKS_MAX }, () => emptyPart("text")),
    };
    expect(canAddPart(filledPage)).toBe(true);
    expect(canAddPart(full)).toBe(false);
  });
});
