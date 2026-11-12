import type { EventLayout } from "@questify/shared";
import type { ImageRef } from "#src/storage/image-refs";

/**
 * The organizer images an event's layout names (T-610b, T-613b): a slide's banner, a text card's and the featured item's
 * picture, and each image part of the custom page, each with its path in the layout so a refusal names the field.
 */
export function layoutImages(layout: EventLayout): ImageRef[] {
  const { content } = layout;
  const refs: ImageRef[] = [];
  content.banner.forEach((slide, index) => {
    if (slide.image !== undefined) {
      refs.push({ field: `content.banner.${index}.image`, id: slide.image, purpose: "banner" });
    }
  });
  content.cards.forEach((card, index) => {
    if (card.kind === "text" && card.image !== undefined) {
      refs.push({ field: `content.cards.${index}.image`, id: card.image, purpose: "picture" });
    }
  });
  if (content.featured?.image !== undefined) {
    refs.push({ field: "content.featured.image", id: content.featured.image, purpose: "picture" });
  }
  content.page?.blocks.forEach((block, index) => {
    if (block.kind === "image") {
      refs.push({
        field: `content.page.blocks.${index}.image`,
        id: block.image,
        purpose: "picture",
      });
    }
  });
  return refs;
}
