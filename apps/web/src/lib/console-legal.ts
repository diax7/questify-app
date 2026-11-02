import {
  helpAdminListSchema,
  helpDocSchema,
  legalAdminListSchema,
  legalPublishSchema,
  legalTextSchema,
  type HelpAdmin,
  type HelpDoc,
  type LegalAdminList,
  type LegalDocumentId,
  type LegalPublish,
  type LegalText,
  type MessageKey,
} from "@questify/shared";
import { checked, type Checked } from "#src/lib/console-catalog.ts";

/** The console's legal documents and help articles (T-707, FR-1781, FR-1782). */
export const LEGAL_API = "/v1/admin/legal";
export const HELP_API = "/v1/admin/help";

export const LEGAL_TABS = ["documents", "help"] as const;
export type LegalTab = (typeof LEGAL_TABS)[number];

/** The documents a player accepts, then the documents an organizer accepts, in the order the page lists them. */
export const PLAYER_DOCUMENTS = ["terms_of_use", "privacy_policy", "community_guidelines"] as const;
export const ORGANIZER_DOCUMENTS = [
  "organizer_terms",
  "organizer_dpa",
  "organizer_content_rules",
] as const;

/** The message of each document's name. */
export const DOCUMENT_NAMES = {
  terms_of_use: "console.legal.doc.termsOfUse",
  privacy_policy: "console.legal.doc.privacyPolicy",
  community_guidelines: "console.legal.doc.communityGuidelines",
  organizer_terms: "console.legal.doc.organizerTerms",
  organizer_dpa: "console.legal.doc.organizerDpa",
  organizer_content_rules: "console.legal.doc.organizerContentRules",
} as const satisfies Record<LegalDocumentId, MessageKey>;

export const versionsPath =(document: LegalDocumentId): string =>
  `${LEGAL_API}/${document}/versions`;
export const publicTextPath = (document: LegalDocumentId): string => `/v1/legal/${document}`;

export type LegalDocuments = LegalAdminList["documents"];

/** Each reader answers undefined when the body is not the expected shape, so a changed API shows the error state. */
export function readLegal(body: unknown): LegalDocuments | undefined {
  const parsed = legalAdminListSchema.safeParse(body);
  return parsed.success ? parsed.data.documents : undefined;
}
export function readHelp(body: unknown): HelpAdmin[] | undefined {
  const parsed = helpAdminListSchema.safeParse(body);
  return parsed.success ? parsed.data.articles : undefined;
}
export function readPublicText(body: unknown): LegalText | undefined {
  const parsed = legalTextSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

// ---------------------------------------------------------------- publishing a version

export type PublishDraft = Readonly<{ version: string; ar: string; en: string; note: string }>;

/** The next version to suggest: the in-force version with its last number raised ("0.1" becomes "0.2", "3" becomes "4"). */
export function nextVersion(current: string): string {
  const parts = current.split(".");
  const last = Number(parts.at(-1) ?? "0");
  return [...parts.slice(0, -1), String(last + 1)].join(".");
}

export const publishDraftOf = (current: string): PublishDraft => ({
  version: nextVersion(current),
  ar: "",
  en: "",
  note: "",
});

export function checkPublish(draft: PublishDraft): Checked<LegalPublish> {
  const note = draft.note.trim();
  return checked(legalPublishSchema, {
    version: draft.version.trim(),
    text: { ar: draft.ar, en: draft.en },
    ...(note === "" ? {} : { note }),
  });
}

// ---------------------------------------------------------------- help articles

export type HelpDraft = Readonly<{
  id: string;
  questionAr: string;
  questionEn: string;
  answerAr: string;
  answerEn: string;
  position: string;
  published: boolean;
}>;

export const helpDraftOf = (row: HelpAdmin): HelpDraft => ({
  id: row.id,
  questionAr: row.question.ar,
  questionEn: row.question.en,
  answerAr: row.answer.ar,
  answerEn: row.answer.en,
  position: String(row.position),
  published: row.published,
});

/** A new article goes last, hidden until it is ready. */
export const newHelpDraft = (rows: readonly HelpAdmin[]): HelpDraft => ({
  id: "",
  questionAr: "",
  questionEn: "",
  answerAr: "",
  answerEn: "",
  position: String(Math.max(0, ...rows.map((row) => row.position)) + 1),
  published: false,
});

const wholeNumber = (text: string): number => (/^\d{1,4}$/.test(text.trim()) ? Number(text) : NaN);

export function checkHelp(draft: HelpDraft): Checked<HelpDoc> {
  return checked(helpDocSchema, {
    question: { ar: draft.questionAr, en: draft.questionEn },
    answer: { ar: draft.answerAr, en: draft.answerEn },
    position: wholeNumber(draft.position),
    published: draft.published,
  });
}

export function isHelpDirty(row: HelpAdmin, draft: HelpDraft): boolean {
  const same = helpDraftOf(row);
  return (
    same.questionAr !== draft.questionAr.trim() ||
    same.questionEn !== draft.questionEn.trim() ||
    same.answerAr !== draft.answerAr.trim() ||
    same.answerEn !== draft.answerEn.trim() ||
    same.position !== draft.position.trim() ||
    same.published !== draft.published
  );
}
