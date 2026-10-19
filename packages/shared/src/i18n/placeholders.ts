import { formatNumber, type Language } from "./digits";

const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9]*)\}/g;

/** The names inside {braces} in a text, each once, sorted. */
export function placeholdersOf(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((match) => match[1] ?? ""))].toSorted();
}

/**
 * Fills the placeholders of a text. Numbers are shown in Western digits (FR-1507). A placeholder with no value
 * stays as it is, so a missing value is visible instead of silently blank. Values are not filled in again.
 */
export function interpolate(
  template: string,
  params: Readonly<Record<string, string | number>>,
  language: Language,
): string {
  return template.replace(PLACEHOLDER, (whole, name: string) => {
    const value = params[name];
    if (value === undefined) {
      return whole;
    }
    return typeof value === "number" ? formatNumber(value, language) : value;
  });
}
