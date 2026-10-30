import { SURVEY_SHARE_TOKEN, type Language } from "@questify/shared";

/** Where the speaker's page lives. The token rides in the fragment, so no server log or referrer holds it. */
export function surveyLinkOf(origin: string, language: Language, token: string): string {
  return `${origin}/${language}/r#${token}`;
}

/** The token in a page's fragment, or undefined when there is none or it is not the shape of ours. */
export function tokenFromHash(hash: string): string | undefined {
  const token = hash.startsWith("#") ? hash.slice(1) : hash;
  return SURVEY_SHARE_TOKEN.test(token) ? token : undefined;
}
