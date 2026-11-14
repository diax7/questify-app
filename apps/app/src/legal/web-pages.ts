import {
  JOIN_LINK_HOST,
  type Language,
  type MessageKey,
  type PlayerDocumentId,
} from "@questify/shared";

/**
 * The pages the web serves for the store's "about and privacy" links (FR-1707, Q-769): the three player documents
 * (`/{lang}/legal/{id}`), the contact page and the account-deletion page. The host is the join-link host every legal
 * link of the app already uses, until Q-771 settles one web origin.
 */
export type WebPage = PlayerDocumentId | "contact" | "delete-account";

export function webPageUrl(language: Language, page: WebPage): string {
  const path = page === "contact" || page === "delete-account" ? page : `legal/${page}`;
  return `https://${JOIN_LINK_HOST}/${language}/${path}`;
}

/** The About and privacy screen's rows, in the order shown. */
export const ABOUT_PAGES: readonly Readonly<{ page: WebPage; label: MessageKey }>[] = [
  { page: "privacy_policy", label: "signIn.privacy" },
  { page: "terms_of_use", label: "signIn.terms" },
  { page: "community_guidelines", label: "submission.guidelines" },
  { page: "contact", label: "contact.title" },
  { page: "delete-account", label: "about.deletionPage" },
];
