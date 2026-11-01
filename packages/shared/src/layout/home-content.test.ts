import { describe, expect, it } from "vitest";
import {
  BANNER_SLIDES_MAX,
  CONTENT_LIMITS,
  EMPTY_CONTENT,
  HOME_CARDS_MAX,
  QUICK_LINKS_MAX,
  checkHomeContent,
  cleanBlockText,
  countdownReached,
  isAllowedLink,
  linkHost,
  readHomeContent,
  sameContent,
} from "#src/layout/home-content";

const QUEST = "0f8fad5b-d9cb-469f-a165-70867728950e";
const none = { type: "none" } as const;
const empty = { ar: "", en: "" };

const slide = (title = "Welcome", action: unknown = none) => ({
  title: { ar: "", en: title },
  subtitle: empty,
  action,
});
const text = (id = "aaaaaa11", body = "Doors open at nine") => ({
  id,
  kind: "text",
  title: empty,
  body: { ar: "", en: body },
});
const countdown = (extra: Record<string, unknown> = {}) => ({
  id: "bbbbbb22",
  kind: "countdown",
  label: { ar: "", en: "Doors open" },
  at: "2030-01-01T09:00:00.000Z",
  atZero: "hide",
  message: empty,
  ...extra,
});
const content = (changes: Record<string, unknown> = {}) => ({ ...EMPTY_CONTENT, ...changes });

const over = (max: number) => "\u{1F600}".repeat(max + 1);
const agendaLink = { label: { ar: "", en: "A" }, icon: "star", action: { type: "agenda" } };
const link = (changes: Record<string, unknown>) => ({
  label: { ar: "", en: "Go" },
  icon: "star",
  action: { type: "shop" },
  ...changes,
});
const issuePaths = (input: unknown): string[] => {
  const checked = checkHomeContent(input);
  return checked.ok ? [] : checked.issues.map((issue) => issue.path);
};

describe("checkHomeContent", () => {
  it("accepts empty content and content with every kind of block", () => {
    expect(checkHomeContent(EMPTY_CONTENT).ok).toBe(true);
    const full = content({
      banner: [slide("One", { type: "quest", questId: QUEST }), slide("Two", { type: "agenda" })],
      quickLinks: [
        { label: { ar: "الجدول", en: "" }, icon: "calendar", action: { type: "agenda" } },
        {
          label: { ar: "", en: "Site" },
          icon: "info",
          action: { type: "link", url: "https://a.example.com/x?y=1#z" },
        },
      ],
      featured: { kind: "reward", id: QUEST },
      cards: [text(), countdown({ atZero: "message", message: { ar: "", en: "We are open" } })],
    });
    const checked = checkHomeContent(full);
    expect(checked.ok).toBe(true);
    expect(checked.ok ? checked.value.cards : []).toHaveLength(2);
  });

  it.each(["banner", "quickLinks", "featured", "cards"])("requires %s to be sent", (key) => {
    const { [key]: _left, ...rest } = EMPTY_CONTENT as Record<string, unknown>;
    expect(issuePaths(rest)).toEqual([`content.${key}`]);
  });

  it.each([undefined, null, "x", 4, []])("refuses content that is %j", (input) => {
    expect(checkHomeContent(input).ok).toBe(false);
  });

  it("refuses a field a block does not have, in every part", () => {
    expect(issuePaths(content({ extra: 1 }))).toEqual(["content.extra"]);
    expect(issuePaths(content({ banner: [{ ...slide(), image: "x.png" }] }))).toEqual([
      "content.banner.0.image",
    ]);
    expect(issuePaths(content({ cards: [{ ...text(), at: "2030-01-01T09:00:00Z" }] }))).toEqual([
      "content.cards.0.at",
    ]);
    expect(
      issuePaths(content({ banner: [{ ...slide(), title: { ar: "", en: "x", fr: "y" } }] })),
    ).toEqual(["content.banner.0.title.fr"]);
  });

  it("cleans a text before it is judged: spaces, invisible characters and Arabic-Indic digits", () => {
    const checked = checkHomeContent(
      content({ cards: [text("aaaaaa11", "  Hall​   ٣ \n opens ")] }),
    );
    expect(checked.ok ? checked.value.cards[0] : null).toMatchObject({
      body: { en: "Hall 3\nopens" },
    });
  });

  it("keeps a text card's line breaks, one blank line at most", () => {
    expect(cleanBlockText("one\r\n\r\n\r\n\ntwo\nthree  ", true)).toBe("one\n\ntwo\nthree");
    expect(cleanBlockText("one\ntwo", false)).toBe("one two");
  });

  it("removes control characters, which Postgres refuses in stored JSON, and the gap they leave", () => {
    expect(cleanBlockText("a\u0000b\u001Bc\u007Fd\u0085e", false)).toBe("abcde");
    expect(cleanBlockText("a \u0000 b", false)).toBe("a b");
    expect(cleanBlockText("\u0000 one\u0000\n\u0001\n\n\u0002\ntwo \u009F", true)).toBe(
      "one\n\ntwo",
    );
    const checked = checkHomeContent(content({ cards: [text("aaaaaa11", "Doors\u0000 open")] }));
    expect(checked.ok ? checked.value.cards[0] : null).toMatchObject({
      body: { en: "Doors open" },
    });
  });

  it("needs a title in one language, and a text only of spaces counts as none", () => {
    expect(issuePaths(content({ banner: [slide("   ")] }))).toEqual(["content.banner.0.title"]);
    expect(
      issuePaths(content({ banner: [{ ...slide(), title: { ar: "عنوان", en: "" } }] })),
    ).toEqual([]);
  });

  it("enforces each text limit in code points and the counts of each list", () => {
    expect(issuePaths(content({ banner: [slide(over(CONTENT_LIMITS.slideTitle))] }))).toEqual([
      "content.banner.0.title.en",
    ]);
    expect(
      checkHomeContent(content({ banner: [slide("\u{1F600}".repeat(CONTENT_LIMITS.slideTitle))] }))
        .ok,
    ).toBe(true);
    expect(
      issuePaths(content({ cards: [text("aaaaaa11", over(CONTENT_LIMITS.cardBody))] })),
    ).toEqual(["content.cards.0.body.en"]);
    expect(
      issuePaths(content({ banner: Array.from({ length: BANNER_SLIDES_MAX + 1 }, () => slide()) })),
    ).toEqual(["content.banner"]);
    expect(
      issuePaths(
        content({ quickLinks: Array.from({ length: QUICK_LINKS_MAX + 1 }, () => agendaLink) }),
      ),
    ).toEqual(["content.quickLinks"]);
    const cards = Array.from({ length: HOME_CARDS_MAX + 1 }, (_, index) => text(`card${index}xx`));
    expect(issuePaths(content({ cards }))).toEqual(["content.cards"]);
  });

  it("refuses a repeated or badly formed card id", () => {
    expect(issuePaths(content({ cards: [text("aaaaaa11"), text("aaaaaa11")] }))).toEqual([
      "content.cards",
    ]);
    for (const id of ["short", "UPPERCASE1", "has space1", "toolongtoolongid", "a-b-c-d-e"]) {
      expect(issuePaths(content({ cards: [text(id)] })), id).toEqual(["content.cards.0.id"]);
    }
  });

  it("needs a quick link to open something, with an icon of the set", () => {
    expect(issuePaths(content({ quickLinks: [link({ action: none })] }))).toEqual([
      "content.quickLinks.0.action",
    ]);
    expect(issuePaths(content({ quickLinks: [link({ icon: "skull" })] }))).toEqual([
      "content.quickLinks.0.icon",
    ]);
    expect(issuePaths(content({ quickLinks: [link({ label: empty })] }))).toEqual([
      "content.quickLinks.0.label",
    ]);
  });

  it("needs a message when a countdown shows one at zero, and a real moment", () => {
    expect(issuePaths(content({ cards: [countdown({ atZero: "message" })] }))).toEqual([
      "content.cards.0.message",
    ]);
    expect(issuePaths(content({ cards: [countdown({ atZero: "vanish" })] }))).toEqual([
      "content.cards.0.atZero",
    ]);
    for (const at of [
      "",
      "tomorrow",
      "2030-01-01",
      "2030-01-01T09:00",
      "1999-12-31T23:59:00Z",
      "2101-01-01T00:00:00Z",
      "2030-02-30T09:00:00Z",
      "2030-01-01T24:00:00Z",
      "2030-01-01T09:60:00Z",
    ]) {
      expect(issuePaths(content({ cards: [countdown({ at })] })), at).toEqual([
        "content.cards.0.at",
      ]);
    }
    const stored = checkHomeContent(
      content({ cards: [countdown({ at: "2030-01-01T12:00:00+03:00" })] }),
    );
    expect(stored.ok ? stored.value.cards[0] : null).toMatchObject({
      at: "2030-01-01T09:00:00.000Z",
    });
  });

  it("refuses a quest or reward id that is not an id", () => {
    expect(issuePaths(content({ featured: { kind: "quest", id: "not-an-id" } }))).toEqual([
      "content.featured.id",
    ]);
    expect(issuePaths(content({ featured: { kind: "badge", id: QUEST } }))).toEqual([
      "content.featured.kind",
    ]);
    expect(
      issuePaths(content({ banner: [slide("x", { type: "quest", questId: "../../etc" })] })),
    ).toEqual(["content.banner.0.action.questId"]);
  });

  it("reports every problem with its own path", () => {
    expect(
      issuePaths(content({ banner: [slide("   "), slide("ok")], cards: [text("aaaaaa11", "")] })),
    ).toEqual(["content.banner.0.title", "content.cards.0.body"]);
  });
});

describe("what a tap may open", () => {
  it.each([
    "https://example.com",
    "https://example.com/path?x=1&y=2#top",
    "https://sub.example.co.uk:8443/a",
    "HTTPS://EXAMPLE.COM/A",
  ])("allows %s", (url) => {
    expect(isAllowedLink(url)).toBe(true);
  });

  it.each([
    "http://example.com",
    "javascript:alert(1)",
    "data:text/html,<script>1</script>",
    "intent://scan/#Intent;scheme=zxing;end",
    "tel:+966500000000",
    "mailto:a@b.com",
    "//example.com",
    "https://",
    "https://localhost/",
    "https://127.0.0.1/",
    "https://[::1]/",
    "https://user:pass@example.com/",
    "https://example.com@evil.example/",
    "https://example.com\\@evil.example/",
    "https://exa mple.com/",
    "https://example.com/a b",
    "https://example.com/\u0000",
    "https://example.com/\n",
    "https://-bad.example.com/",
    "https://example",
    `https://example.com/${"a".repeat(300)}`,
    " https://example.com",
  ])("refuses %j", (url) => {
    expect(isAllowedLink(url)).toBe(false);
  });

  it("refuses a link action that is not allowed and trims one that is", () => {
    const bad = content({ banner: [slide("x", { type: "link", url: "javascript:alert(1)" })] });
    expect(issuePaths(bad)).toEqual(["content.banner.0.action.url"]);
    const padded = checkHomeContent(
      content({ banner: [slide("x", { type: "link", url: "  https://example.com/a  " })] }),
    );
    expect(padded.ok ? padded.value.banner[0]?.action : null).toEqual({
      type: "link",
      url: "https://example.com/a",
    });
    expect(issuePaths(content({ banner: [slide("x", { type: "call" })] }))).toEqual([
      "content.banner.0.action.type",
    ]);
  });

  it("names the host a link opens", () => {
    expect(linkHost("https://Sub.Example.com:8443/a?b#c")).toBe("sub.example.com");
  });
});

describe("readHomeContent", () => {
  it.each([
    undefined,
    null,
    "x",
    3,
    [],
    {},
    { banner: "x", cards: 4, quickLinks: {}, featured: [] },
  ])("gives empty content for %j", (stored) => {
    expect(readHomeContent(stored)).toEqual(EMPTY_CONTENT);
  });

  it("leaves out an item that is not valid and keeps the rest", () => {
    const read = readHomeContent({
      banner: [slide("Good"), { title: 5 }, null, slide("Also good")],
      cards: [
        text("aaaaaa11"),
        text("BAD"),
        countdown({ at: "soon" }),
        text("aaaaaa11"),
        countdown(),
      ],
      featured: { kind: "quest", id: "nope" },
    });
    expect(read.banner.map((entry) => entry.title.en)).toEqual(["Good", "Also good"]);
    expect(read.cards.map((card) => card.id)).toEqual(["aaaaaa11", "bbbbbb22"]);
    expect(read.featured).toBeNull();
  });

  it("cuts a list to its limit and never throws on a stored value that is too long", () => {
    const read = readHomeContent({
      banner: Array(40).fill(slide()),
      cards: [text("aaaaaa11", "x".repeat(CONTENT_LIMITS.cardBody + 1))],
    });
    expect(read.banner).toHaveLength(BANNER_SLIDES_MAX);
    expect(read.cards).toEqual([]);
  });

  it("keeps a field a newer server added, instead of dropping the item", () => {
    const read = readHomeContent({ banner: [{ ...slide("New"), image: "later.png" }] });
    expect(read.banner).toHaveLength(1);
    expect(read.banner[0]).not.toHaveProperty("image");
  });

  it("returns what a save stored, unchanged", () => {
    const saved = content({ banner: [slide()], cards: [text(), countdown()] });
    const checked = checkHomeContent(saved);
    expect(checked.ok && readHomeContent(checked.value)).toEqual(checked.ok ? checked.value : null);
  });
});

describe("sameContent and countdownReached", () => {
  it("ignores the order of an object's fields and sees a changed word", () => {
    const a = content({ banner: [slide("A")] });
    const b = content({
      banner: [{ action: none, subtitle: empty, title: { en: "A", ar: "" } }],
    });
    expect(sameContent(a as never, b as never)).toBe(true);
    expect(sameContent(a as never, content({ banner: [slide("B")] }) as never)).toBe(false);
  });

  it("is reached at the moment itself and not before", () => {
    const card = readHomeContent({ cards: [countdown()] }).cards[0];
    const at = Date.parse("2030-01-01T09:00:00.000Z");
    expect(card?.kind === "countdown" && countdownReached(card, at - 1)).toBe(false);
    expect(card?.kind === "countdown" && countdownReached(card, at)).toBe(true);
  });
});
