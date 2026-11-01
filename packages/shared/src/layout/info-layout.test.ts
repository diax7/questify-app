import { describe, expect, it } from "vitest";
import { FEATURES } from "#src/config/registry";
import { EMPTY_CONTENT } from "#src/layout/home-content";
import {
  BAR_KEYS,
  DEFAULT_COMPOSED_LAYOUT,
  DEFAULT_LAYOUT,
  HOME_KEYS,
  HOME_PROTECTED,
  INFO_KEYS,
  INFO_PROTECTED,
  INFO_SECTIONS,
  composedLayoutOf,
  infoSections,
  readComposedLayout,
  readEventLayout,
  sameLayout,
} from "#src/layout/layout";
import { DEFAULT_LOOKS } from "#src/layout/looks";
import { applyPreset, presetLayout } from "#src/layout/presets";
import { layoutAfter, validateLayoutRequest } from "#src/layout/validate";

const words = { ar: "", en: "x" };
const without = (name: string) => INFO_KEYS.filter((key) => key !== name);

describe("the event info page's sections (T-613)", () => {
  it("draws the sections in the order the page always had, with the schedule link off", () => {
    expect(INFO_KEYS.join()).toBe("about,venue,when,schedule,faq,contacts,rules");
    expect(DEFAULT_LAYOUT.info).toEqual({ order: INFO_KEYS, hidden: ["schedule"] });
    expect(DEFAULT_COMPOSED_LAYOUT.info).toEqual([
      "about",
      "venue",
      "when",
      "faq",
      "contacts",
      "rules",
    ]);
  });

  it("protects the official rules and nothing else", () => {
    expect([...INFO_PROTECTED]).toEqual(["rules"]);
  });

  it("only names switches the app has", () => {
    for (const entry of INFO_SECTIONS) {
      for (const feature of entry.features) {
        expect(feature in FEATURES, `${entry.section}: ${feature}`).toBe(true);
      }
    }
  });

  it("reads an older layout as the default, and puts a section it lacks at the end", () => {
    expect(readEventLayout({}).info).toEqual(DEFAULT_LAYOUT.info);
    const older = readEventLayout({ info: { order: ["rules", "faq"], hidden: ["faq"] } });
    expect(older.info.order).toEqual([
      "rules",
      "faq",
      "about",
      "venue",
      "when",
      "schedule",
      "contacts",
    ]);
    expect(older.info.hidden).toEqual(["faq", "schedule"]);
  });

  it("never reads a stored layout that hides the rules, and drops a name the app does not know", () => {
    const damaged = readEventLayout({
      info: { order: ["rules", "poem", "rules"], hidden: ["rules"] },
    });
    expect(damaged.info.hidden).not.toContain("rules");
    expect(damaged.info.order.filter((name) => name === "rules")).toHaveLength(1);
    expect(damaged.info.order).not.toContain("poem");
  });

  it("composes the shown sections in the order the organizer set", () => {
    const layout = readEventLayout({
      info: {
        order: ["rules", "faq", ...without("rules").filter((k) => k !== "faq")],
        hidden: ["when"],
      },
    });
    expect(composedLayoutOf(layout).info).toEqual([
      "rules",
      "faq",
      "about",
      "venue",
      "schedule",
      "contacts",
    ]);
  });

  it("sends a section's words only while the section is shown", () => {
    const contact = { label: words, kind: "phone", value: "0501234567" };
    const entry = { question: words, answer: words };
    const layout = readEventLayout({
      info: { order: INFO_KEYS, hidden: ["about", "faq"] },
      content: { about: words, faq: [entry], contacts: [contact] },
    });
    const sent = composedLayoutOf(layout).content;
    expect(sent.about).toEqual(EMPTY_CONTENT.about);
    expect(sent.faq).toEqual([]);
    expect(sent.contacts).toHaveLength(1);
    expect(layout.content.faq).toHaveLength(1);
  });

  it("sends the custom page only while its Home link is shown", () => {
    const page = { title: { ar: "", en: "Rules" }, blocks: [{ kind: "text", text: words }] };
    expect(composedLayoutOf(readEventLayout({ content: { page } })).content.page).toEqual(page);
    const hidden = readEventLayout({
      home: { order: HOME_KEYS, hidden: ["page"] },
      content: { page },
    });
    expect(composedLayoutOf(hidden).content.page).toBeNull();
    expect(hidden.content.page).toEqual(page);
  });

  it("puts the extra page on Home after the quick links, shown and not protected", () => {
    expect(HOME_KEYS.indexOf("page")).toBe(HOME_KEYS.indexOf("quickLinks") + 1);
    expect(HOME_PROTECTED.has("page")).toBe(false);
    expect(DEFAULT_LAYOUT.home.hidden).not.toContain("page");
  });

  it("round-trips through the copy the app caches, and falls back when the rules are missing", () => {
    const layout = readEventLayout({ info: { order: ["faq", ...without("faq")], hidden: [] } });
    const composed = composedLayoutOf(layout);
    expect(readComposedLayout(composed).info).toEqual(composed.info);
    expect(readComposedLayout({ info: ["faq", "about"] }).info).toEqual(
      DEFAULT_COMPOSED_LAYOUT.info,
    );
    expect(readComposedLayout({ info: ["rules", "poem", "faq"] }).info).toEqual(["rules", "faq"]);
  });

  it("hides a section whose event switch is off, whatever the layout says", () => {
    const all = ["about", "schedule", "rules"] as const;
    expect(infoSections(() => true, all)).toEqual(all);
    expect(infoSections((feature) => feature !== "agenda", all)).toEqual(["about", "rules"]);
  });

  it("counts a different order of the info page as a different layout", () => {
    const moved = readEventLayout({
      info: { order: ["faq", ...without("faq")], hidden: ["schedule"] },
    });
    expect(sameLayout(DEFAULT_LAYOUT, moved)).toBe(false);
    expect(sameLayout(moved, readEventLayout(moved))).toBe(true);
  });
});

type Part = Partial<{ order: readonly string[]; hidden: readonly string[] }>;
const body = (info: Part) => ({
  bar: { order: BAR_KEYS, hidden: [] },
  home: { order: HOME_KEYS, hidden: [] },
  info: { order: INFO_KEYS, hidden: [], ...info },
  content: EMPTY_CONTENT,
  looks: DEFAULT_LOOKS,
});
const issuesOf = (input: unknown) => {
  const checked = validateLayoutRequest(input);
  return checked.ok ? [] : checked.issues;
};

describe("validateLayoutRequest info page", () => {
  it("accepts a reorder of the info page and a hidden section", () => {
    const order = ["faq", "about", "venue", "when", "schedule", "contacts", "rules"];
    const checked = validateLayoutRequest(body({ order, hidden: ["when"] }));
    expect(checked.ok ? checked.value.layout.info : null).toEqual({ order, hidden: ["when"] });
  });

  it("refuses to hide the official rules and names the item", () => {
    expect(issuesOf(body({ hidden: ["rules"] }))).toEqual([
      expect.objectContaining({ path: "info.hidden.0", protectedItem: "rules" }),
    ]);
  });

  it("refuses a section the page does not have, one listed twice and one left out", () => {
    expect(issuesOf(body({ order: [...INFO_KEYS, "poem"] }))).toEqual([
      expect.objectContaining({ path: "info.order.7" }),
    ]);
    expect(issuesOf(body({ order: [...INFO_KEYS, "faq"] }))).toEqual([
      expect.objectContaining({ path: "info.order.7", message: "is listed twice" }),
    ]);
    expect(issuesOf(body({ order: INFO_KEYS.slice(1) }))).toEqual([
      expect.objectContaining({ path: "info.order" }),
    ]);
  });

  it("refuses a layout that leaves the info page out", () => {
    const { info: _left, ...rest } = body({});
    expect(issuesOf(rest)).toEqual([expect.objectContaining({ path: "info" })]);
  });

  it("refuses a text the strict check finds wrong, with the path of the info content", () => {
    const wrong = { ...body({}), content: { ...EMPTY_CONTENT, faq: [{ question: words }] } };
    expect(issuesOf(wrong)).toEqual([expect.objectContaining({ path: "content.faq.0.answer" })]);
  });

  it("keeps the event's info page order and words when a preset is laid over it", () => {
    const current = readEventLayout({
      info: { order: ["rules", ...without("rules")], hidden: [] },
      content: { about: words },
    });
    const preset = presetLayout("essentials");
    expect(preset).toBeDefined();
    const applied = applyPreset(current, preset ?? DEFAULT_LAYOUT);
    expect(applied.info).toEqual(current.info);
    expect(applied.content.about).toEqual(words);
    const checked = validateLayoutRequest({ preset: "essentials" });
    expect(checked.ok ? layoutAfter(checked.value, current).info : null).toEqual(current.info);
  });
});
