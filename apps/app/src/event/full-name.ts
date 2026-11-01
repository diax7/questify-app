/**
 * A full name the server sent, or null (FR-1842, ADR-400). An older API sends none, the server sends none where the event
 * does not show it, and nothing but non-blank text is ever drawn as a name.
 */
export const fullNameOf = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;
