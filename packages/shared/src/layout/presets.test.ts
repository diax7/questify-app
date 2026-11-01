import { describe, expect, it } from "vitest";
import { MESSAGES } from "#src/i18n/messages";
import { BAR_PROTECTED, HOME_PROTECTED, readEventLayout, sameLayout } from "#src/layout/layout";
import { LAYOUT_PRESETS, applyPreset, matchingPreset, presetLayout } from "#src/layout/presets";
import { validateLayoutRequest } from "#src/layout/validate";

describe("the approved layout presets", () => {
  it("has a named, translated preset of each id once", () => {
    const ids = LAYOUT_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("classic");
    for (const preset of LAYOUT_PRESETS) {
      expect(MESSAGES[preset.title].ar, preset.id).not.toBe("");
      expect(MESSAGES[preset.title].en, preset.id).not.toBe("");
    }
  });

  it.each(LAYOUT_PRESETS.map((preset) => [preset.id, preset.layout] as const))(
    "%s passes the same check as an organizer's own layout and hides no protected item",
    (_id, layout) => {
      expect(validateLayoutRequest(layout).ok).toBe(true);
      expect(readEventLayout(layout)).toEqual(layout);
      for (const item of BAR_PROTECTED) {
        expect(layout.bar.hidden).not.toContain(item);
      }
      for (const block of HOME_PROTECTED) {
        expect(layout.home.hidden).not.toContain(block);
      }
    },
  );

  it("differ from each other, so picking another changes what players see", () => {
    for (const a of LAYOUT_PRESETS) {
      for (const b of LAYOUT_PRESETS) {
        expect(sameLayout(a.layout, b.layout), `${a.id} / ${b.id}`).toBe(a.id === b.id);
      }
    }
  });

  it("offers one preset with the Rewards tab and one without", () => {
    const hidden = LAYOUT_PRESETS.map((preset) => preset.layout.bar.hidden.includes("rewards"));
    expect(hidden).toContain(true);
    expect(hidden).toContain(false);
  });

  it("finds a preset by id, and tells which one a layout is, or none for the organizer's own", () => {
    expect(presetLayout("nope")).toBeUndefined();
    for (const preset of LAYOUT_PRESETS) {
      expect(presetLayout(preset.id)).toEqual(preset.layout);
      expect(matchingPreset(preset.layout)?.id).toBe(preset.id);
    }
    const own = readEventLayout({ bar: { order: ["profile", "scan", "index"], hidden: [] } });
    expect(matchingPreset(own)).toBeNull();
  });
});

describe("a preset laid over an event's layout (FR-1831)", () => {
  const card = {
    id: "aaaaaa11",
    kind: "text",
    title: { ar: "", en: "" },
    body: { ar: "", en: "Doors open at nine" },
  } as const;
  const content = {
    banner: [
      { title: { ar: "", en: "Hello" }, subtitle: { ar: "", en: "" }, action: { type: "none" } },
    ],
    quickLinks: [],
    featured: null,
    cards: [card],
  } as const;
  const own = readEventLayout({
    home: {
      order: [...presetLayout("classic")!.home.order, "card:aaaaaa11"],
      hidden: ["card:aaaaaa11"],
    },
    content,
  });

  it("arranges Questify's blocks and keeps every card, every word and each card's switch", () => {
    const essentials = presetLayout("essentials")!;
    const applied = applyPreset(own, essentials);
    expect(applied.home.order.slice(0, essentials.home.order.length)).toEqual(
      essentials.home.order,
    );
    expect(applied.home.order.at(-1)).toBe("card:aaaaaa11");
    expect(applied.home.hidden).toContain("card:aaaaaa11");
    expect(applied.content).toEqual(content);
    expect(applied.bar).toEqual(essentials.bar);
  });

  it("is what Reset to default does: the default order returns and the words stay", () => {
    const moved = readEventLayout({
      home: {
        order: [...presetLayout("classic")!.home.order.toReversed(), "card:aaaaaa11"],
        hidden: ["streak"],
      },
      content,
    });
    const reset = applyPreset(moved, presetLayout("classic")!);
    expect(reset.home.order.slice(0, 15)).toEqual(presetLayout("classic")!.home.order);
    expect(reset.home.hidden).toEqual(["podium"]);
    expect(reset.content).toEqual(content);
  });

  it("still tells which preset the blocks follow when cards trail them, and none once a card leads", () => {
    expect(matchingPreset(applyPreset(own, presetLayout("play_first")!))?.id).toBe("play_first");
    const cardFirst = readEventLayout({
      home: { order: ["card:aaaaaa11", ...presetLayout("classic")!.home.order], hidden: [] },
      content,
    });
    expect(matchingPreset(cardFirst)).toBeNull();
  });

  it("keeps the podium off in every preset", () => {
    for (const preset of LAYOUT_PRESETS) {
      expect(preset.layout.home.hidden, preset.id).toContain("podium");
    }
  });
});
