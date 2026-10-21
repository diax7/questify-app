/**
 * The documents an organizer accepts at sign-up (FR-1726), with the version in force. The texts live in
 * `docs/legal/`; a new version is a change here, recorded in DECISIONS. Read them through `organizerDocuments()` so
 * T-707 can move the source to console data without touching the callers.
 */
export type OrganizerDocumentId = "organizer_terms" | "organizer_dpa" | "organizer_content_rules";

export type OrganizerDocument = Readonly<{
  id: OrganizerDocumentId;
  /** The field the sign-up request names it by. */
  field: "terms" | "dpa" | "contentRules";
  version: string;
}>;

const ORGANIZER_DOCUMENTS: readonly OrganizerDocument[] = [
  { id: "organizer_terms", field: "terms", version: "0.1" },
  { id: "organizer_dpa", field: "dpa", version: "0.1" },
  { id: "organizer_content_rules", field: "contentRules", version: "0.1" },
];

/** The three organizer documents and the versions in force now. */
export function organizerDocuments(): readonly OrganizerDocument[] {
  return ORGANIZER_DOCUMENTS;
}

export type Acceptance = Readonly<Record<OrganizerDocument["field"], string>>;

/**
 * The documents whose accepted version is not the one in force (empty when everything is accepted).
 *
 * @returns the ids of the documents still to accept, in a fixed order.
 */
export function missingAcceptances(accepted: Partial<Acceptance>): OrganizerDocumentId[] {
  return organizerDocuments()
    .filter((document) => accepted[document.field] !== document.version)
    .map((document) => document.id);
}

/**
 * The documents a player accepts (FR-1705, FR-1706), with the version in force. The texts live in `docs/legal/` and are
 * shown as the web pages; the app learns these versions from `GET /v1/config`, never from its own build.
 */
export type PlayerDocumentId = "terms_of_use" | "privacy_policy" | "community_guidelines";

export type PlayerDocument = Readonly<{
  id: PlayerDocumentId;
  /** The field a request names it by. */
  field: "terms" | "privacy" | "guidelines";
  version: string;
}>;

const PLAYER_DOCUMENTS: readonly PlayerDocument[] = [
  { id: "terms_of_use", field: "terms", version: "0.1" },
  { id: "privacy_policy", field: "privacy", version: "0.1" },
  { id: "community_guidelines", field: "guidelines", version: "0.1" },
];

/** The three player documents and the versions in force now. */
export function playerDocuments(): readonly PlayerDocument[] {
  return PLAYER_DOCUMENTS;
}

/** What a person accepts before their phone or email is stored: the terms and the privacy policy. */
export type SignupAcceptance = Readonly<{ terms: string; privacy: string }>;

/**
 * The sign-up documents (terms, privacy) whose given version is not the one in force; never the guidelines, which are
 * accepted before a first submission instead.
 */
export function missingSignupAcceptances(
  accepted: Readonly<Partial<Record<PlayerDocument["field"], string>>>,
): PlayerDocumentId[] {
  return signupDocuments()
    .filter((document) => accepted[document.field] !== document.version)
    .map((document) => document.id);
}

/** The documents accepted before a phone or email is stored: the terms and the privacy policy, in force now. */
export function signupDocuments(): readonly PlayerDocument[] {
  return playerDocuments().filter(
    (document) => document.field === "terms" || document.field === "privacy",
  );
}
