/**
 * The legal documents (FR-1705, FR-1706, FR-1726, FR-1781). Which version of each is in force is data an admin publishes
 * (`legal_version`, migration 0123), read from the API as `LegalInForce`; this module holds what never changes: the six
 * ids, the request field each is named by, and the rules that compare accepted versions with the ones in force.
 */
export const LEGAL_DOCUMENT_IDS = [
  "terms_of_use",
  "privacy_policy",
  "community_guidelines",
  "organizer_terms",
  "organizer_dpa",
  "organizer_content_rules",
] as const;
export type LegalDocumentId = (typeof LEGAL_DOCUMENT_IDS)[number];

export type OrganizerDocumentId = "organizer_terms" | "organizer_dpa" | "organizer_content_rules";
export type PlayerDocumentId = "terms_of_use" | "privacy_policy" | "community_guidelines";

/** A version number such as `2`, `1.1` or `1.0.3`. */
export const LEGAL_VERSION = /^[0-9]{1,4}(\.[0-9]{1,4}){0,2}$/;

/** The version in force of each document, as `legal_in_force()` and `GET /v1/legal` answer. */
export type LegalInForce = readonly Readonly<{ document: LegalDocumentId; version: string }>[];

export type OrganizerDocument = Readonly<{
  id: OrganizerDocumentId;
  /** The field the sign-up request names it by. */
  field: "terms" | "dpa" | "contentRules";
  version: string;
}>;

export type PlayerDocument = Readonly<{
  id: PlayerDocumentId;
  /** The field a request names it by. */
  field: "terms" | "privacy" | "guidelines";
  version: string;
}>;

const ORGANIZER_FIELDS: readonly Omit<OrganizerDocument, "version">[] = [
  { id: "organizer_terms", field: "terms" },
  { id: "organizer_dpa", field: "dpa" },
  { id: "organizer_content_rules", field: "contentRules" },
];

const PLAYER_FIELDS: readonly Omit<PlayerDocument, "version">[] = [
  { id: "terms_of_use", field: "terms" },
  { id: "privacy_policy", field: "privacy" },
  { id: "community_guidelines", field: "guidelines" },
];

function withVersions<D extends { id: LegalDocumentId }>(
  fields: readonly D[],
  inForce: LegalInForce,
): (D & { version: string })[] {
  return fields.flatMap((field) => {
    const version = inForce.find((item) => item.document === field.id)?.version;
    return version === undefined ? [] : [{ ...field, version }];
  });
}

/** The three organizer documents with the versions in force (a document with no version in force is left out). */
export function organizerDocuments(inForce: LegalInForce): readonly OrganizerDocument[] {
  return withVersions(ORGANIZER_FIELDS, inForce);
}

/** The three player documents with the versions in force. */
export function playerDocuments(inForce: LegalInForce): readonly PlayerDocument[] {
  return withVersions(PLAYER_FIELDS, inForce);
}

export type Acceptance = Readonly<Record<OrganizerDocument["field"], string>>;

/**
 * The organizer documents whose accepted version is not the one in force (empty when everything is accepted).
 *
 * @returns the ids of the documents still to accept, in a fixed order.
 */
export function missingAcceptances(
  inForce: LegalInForce,
  accepted: Partial<Acceptance>,
): OrganizerDocumentId[] {
  return organizerDocuments(inForce)
    .filter((document) => accepted[document.field] !== document.version)
    .map((document) => document.id);
}

/** What a person accepts before their phone or email is stored: the terms and the privacy policy. */
export type SignupAcceptance = Readonly<{ terms: string; privacy: string }>;

/** The documents accepted before a phone or email is stored: the terms and the privacy policy, in force now. */
export function signupDocuments(inForce: LegalInForce): readonly PlayerDocument[] {
  return playerDocuments(inForce).filter(
    (document) => document.field === "terms" || document.field === "privacy",
  );
}

/**
 * The sign-up documents (terms, privacy) whose given version is not the one in force; never the guidelines, which are
 * accepted before a first submission instead.
 */
export function missingSignupAcceptances(
  inForce: LegalInForce,
  accepted: Readonly<Partial<Record<PlayerDocument["field"], string>>>,
): PlayerDocumentId[] {
  return signupDocuments(inForce)
    .filter((document) => accepted[document.field] !== document.version)
    .map((document) => document.id);
}

export const isLegalDocumentId = (value: unknown): value is LegalDocumentId =>
  typeof value === "string" && (LEGAL_DOCUMENT_IDS as readonly string[]).includes(value);
