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
