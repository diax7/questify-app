import { describe, expect, it } from "vitest";
import { EMPTY_CONTENT, checkHomeContent, readHomeContent } from "#src/layout/home-content";

const IMAGE = "0F0E0D0C-0B0A-4908-8706-050403020100";
const slide = {
  title: { ar: "", en: "Welcome" },
  subtitle: { ar: "", en: "" },
  action: { type: "none" },
};
const card = { id: "abcdef", kind: "text", title: { ar: "", en: "" }, body: { ar: "", en: "Hi" } };
const content = (patch: Record<string, unknown>) => ({ ...EMPTY_CONTENT, ...patch });

/** Organizer images on Home and the custom page (T-610b, T-613b, ADR-829): ids only, older readers drop them. */
describe("images in the event's content", () => {
  it("keeps an image id on a slide, a text card and the featured item, lowercased", () => {
    const checked = checkHomeContent(
      content({
        banner: [{ ...slide, image: IMAGE }],
        cards: [{ ...card, image: IMAGE }],
        featured: { kind: "quest", id: IMAGE, image: IMAGE },
      }),
    );
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const id = IMAGE.toLowerCase();
    expect(checked.value.banner[0]?.image).toBe(id);
    expect(checked.value.cards[0]).toMatchObject({ image: id });
    expect(checked.value.featured?.image).toBe(id);
  });

  it("refuses an image that is no id when saved, and drops it when read", () => {
    const stored = content({ banner: [{ ...slide, image: "https://evil.example/x.png" }] });
    const checked = checkHomeContent(stored);
    expect(checked.ok ? [] : checked.issues).toEqual([
      { path: "content.banner.0.image", message: "must be an image of the event" },
    ]);
    expect(readHomeContent(stored).banner).toEqual([slide]);
  });

  it("takes an image part on the custom page with its words, and drops a damaged one when read", () => {
    const page = (block: Record<string, unknown>) =>
      content({
        page: {
          title: { ar: "", en: "Venue" },
          blocks: [{ kind: "text", text: { ar: "", en: "Doors open at 9" } }, block],
        },
      });
    const good = { kind: "image", image: IMAGE, alt: { ar: "", en: "The hall" } };
    const checked = checkHomeContent(page(good));
    expect(checked.ok && checked.value.page?.blocks[1]).toEqual({
      ...good,
      image: IMAGE.toLowerCase(),
    });
    expect(checkHomeContent(page({ ...good, alt: { ar: "", en: "" } })).ok).toBe(false);
    expect(readHomeContent(page({ ...good, image: "nope" })).page?.blocks).toHaveLength(1);
  });
});
