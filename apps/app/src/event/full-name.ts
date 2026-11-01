/**
 * A full name the server sent, or null (FR-1842, ADR-400). An older API sends none, the server sends none where the event
 * does not show it, and nothing but non-blank text is ever drawn as a name.
 */
export const fullNameOf = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

/**
 * A full name inside a first-strong isolate (FSI ... PDI): the name takes its own direction from its first letter and
 * cannot reorder the text around it. The server has already removed any isolate or override the player typed.
 */
export const isolatedName = (name: string): string => `\u2068${name}\u2069`;
