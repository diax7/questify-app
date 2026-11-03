import {
  checkGroupPushText,
  groupPushAudienceSchema,
  groupPushListSchema,
  groupPushPreviewAnswerSchema,
  type GroupPushBody,
  type GroupPushIssueCode,
  type GroupPushPreview,
  type GroupPushView,
  type MessageKey,
  type MessageTemplateAdmin,
} from "@questify/shared";

/** The console's push to a group (T-706b, FR-1777). */
export const GROUP_PUSH_API = "/v1/admin/group-pushes";
export const GROUP_PUSH_PREVIEW_API = `${GROUP_PUSH_API}/preview`;

/** The reasons a text is refused, as the messages that say them in the admin's language. */
export const GROUP_PUSH_ISSUE_KEYS = {
  required: "console.messages.issue.required",
  tooLong: "console.messages.issue.tooLong",
  language: "console.messages.issue.language",
  titleNotAllowed: "console.messages.issue.titleNotAllowed",
  placeholderUnknown: "console.messages.issue.placeholderUnknown",
  placeholderMissing: "console.messages.issue.placeholderMissing",
  braces: "console.messages.issue.braces",
  brandMissing: "console.messages.issue.brandMissing",
  purposeMissing: "console.messages.issue.purposeMissing",
  smsPartsLimit: "console.messages.issue.smsPartsLimit",
  control_characters: "announcements.page.issue.controlCharacters",
  looks_like_address: "announcements.page.issue.looksLikeAddress",
  looks_like_phone: "announcements.page.issue.looksLikePhone",
} as const satisfies Record<GroupPushIssueCode, MessageKey>;

/** Each reader answers undefined when the body is not the expected shape, so a changed API shows the error state. */
export function readPushes(body: unknown): GroupPushView[] | undefined {
  const parsed = groupPushListSchema.safeParse(body);
  return parsed.success ? parsed.data.pushes : undefined;
}

export function readPreview(body: unknown): GroupPushPreview | undefined {
  const parsed = groupPushPreviewAnswerSchema.safeParse(body);
  return parsed.success ? parsed.data.preview : undefined;
}

export type PushDraft = Readonly<{
  kind: "event" | "promo";
  joinCode: string;
  /** A city id, or an empty text for any city. */
  cityId: string;
  interests: readonly string[];
  titleAr: string;
  titleEn: string;
  bodyAr: string;
  bodyEn: string;
}>;

export const BLANK_PUSH: PushDraft = {
  kind: "event",
  joinCode: "",
  cityId: "",
  interests: [],
  titleAr: "",
  titleEn: "",
  bodyAr: "",
  bodyEn: "",
};

export type PushCheck =
  | Readonly<{ ok: true; body: GroupPushBody }>
  | Readonly<{
      ok: false;
      /** Each refused field (`body.ar`, `joinCode`) with the reasons, as the messages that say them. */
      problems: ReadonlyMap<string, readonly MessageKey[]>;
    }>;

/** Whether the admin has typed anything yet: a blank form shows no refusals. */
export const isBlankPush = (draft: PushDraft): boolean =>
  [draft.joinCode, draft.titleAr, draft.titleEn, draft.bodyAr, draft.bodyEn].every(
    (text) => text.trim() === "",
  );

function audienceOf(draft: PushDraft): unknown {
  return draft.kind === "event"
    ? { kind: "event", joinCode: draft.joinCode.trim() }
    : {
        kind: "promo",
        cityId: draft.cityId === "" ? null : draft.cityId,
        interests: draft.interests,
      };
}

/**
 * The same checks the API makes, so the form says what is wrong before anything is sent: the audience's shape, then the
 * text's rules (`checkGroupPushText`, the promotional push's template rules and the name rule). Success carries the body
 * as it will be sent, with the text cleaned.
 */
export function checkPush(draft: PushDraft): PushCheck {
  const problems = new Map<string, MessageKey[]>();
  const add = (field: string, key: MessageKey) =>
    problems.set(field, [...(problems.get(field) ?? []), key]);
  const audience = groupPushAudienceSchema.safeParse(audienceOf(draft));
  if (!audience.success) add("joinCode", "console.catalog.invalid");
  const text = checkGroupPushText({
    title: { ar: draft.titleAr, en: draft.titleEn },
    body: { ar: draft.bodyAr, en: draft.bodyEn },
  });
  if (!text.ok) {
    for (const issue of text.issues) add(issue.path, GROUP_PUSH_ISSUE_KEYS[issue.message]);
  }
  if (!audience.success || !text.ok) return { ok: false, problems };
  return { ok: true, body: { audience: audience.data, ...text.text } };
}

/** The saved promotional push, as the composer's starting text (the slot the promotional push is edited in). */
export function savedPushText(
  templates: readonly MessageTemplateAdmin[],
): Pick<PushDraft, "titleAr" | "titleEn" | "bodyAr" | "bodyEn"> | undefined {
  const slot = templates.find((row) => row.key === "promo_push");
  return slot?.title == null
    ? undefined
    : {
        titleAr: slot.title.ar,
        titleEn: slot.title.en,
        bodyAr: slot.body.ar,
        bodyEn: slot.body.en,
      };
}
