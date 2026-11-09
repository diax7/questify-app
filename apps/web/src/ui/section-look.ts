export type SectionLook = "section" | "sub";

/**
 * How a section's title looks, apart from its heading level: `section` is the large display title, `sub` the
 * smaller body-font one. Without a `look` it follows the level (`2` is a section title, `3` a sub title).
 */
export function sectionLook(level: 2 | 3, look?: SectionLook): SectionLook {
  return look ?? (level === 2 ? "section" : "sub");
}
