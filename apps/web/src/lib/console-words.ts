import {
  retiredPageSchema,
  wordsPageSchema,
  type RetiredName,
  type WordLanguage,
  type WordMatch,
  type WordsPage,
} from "@questify/shared";

/** The console's word lists and retired usernames (T-705, FR-1779). */
export const WORDS_API = "/v1/admin/words";
export const RETIRED_API = "/v1/admin/retired-usernames";
export const RELEASE_API = `${RETIRED_API}/release`;

export type WordFilter = Readonly<{
  q: string;
  language: WordLanguage | "";
  match: WordMatch | "";
}>;

/** One page of the lists: the filter as typed, after the last word of the page before. */
export function wordsPath(filter: WordFilter, after: string | null): string {
  const params = new URLSearchParams();
  if (filter.q.trim() !== "") {
    params.set("q", filter.q.trim());
  }
  if (filter.language !== "") {
    params.set("language", filter.language);
  }
  if (filter.match !== "") {
    params.set("match", filter.match);
  }
  if (after !== null) {
    params.set("after", after);
  }
  const text = params.toString();
  return `${WORDS_API}${text === "" ? "" : `?${text}`}`;
}

/** A list word in the path of its removal; the API folds it again. */
export const wordPath = (word: string): string => `${WORDS_API}/${encodeURIComponent(word)}`;

/** One page of retired names, filtered by a part of the name. */
export function retiredPath(q: string, after: string | null): string {
  const params = new URLSearchParams();
  if (q.trim() !== "") {
    params.set("q", q.trim());
  }
  if (after !== null) {
    params.set("after", after);
  }
  const text = params.toString();
  return `${RETIRED_API}${text === "" ? "" : `?${text}`}`;
}

/** Each reader answers undefined when the body is not the expected shape, so a changed API shows the error state. */
export function readWords(body: unknown): WordsPage | undefined {
  const parsed = wordsPageSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

export function readRetired(body: unknown): RetiredName[] | undefined {
  const names = typeof body === "object" && body !== null ? Reflect.get(body, "names") : undefined;
  const parsed = retiredPageSchema.safeParse(names);
  return parsed.success ? parsed.data : undefined;
}
