import {
  JOIN_FIELD_KINDS,
  JOIN_OPTION_MAX,
  JOIN_OPTION_MIN,
  type JoinFieldKind,
  type JoinOption,
} from "@questify/shared";

type Bilingual = Readonly<{ ar: string | null; en: string | null }>;

/** At most this many join fields an event, and lines one guest upload takes (API.md, T-212). */
export const JOIN_FIELD_LIMIT = 5;
export const GUESTS_PER_UPLOAD = 2000;

/** A field as `GET …/events/{eventId}/join` answers it. */
export type JoinFieldView = Readonly<{
  id: string;
  kind: JoinFieldKind;
  label: Bilingual;
  required: boolean;
  /** A choice field's options (ADR-171); null for a free-text answer. */
  options: readonly JoinOption[] | null;
}>;

export type JoinRules = Readonly<{
  guestListOnly: boolean;
  emailDomains: readonly string[];
  welcomePoints: number | null;
}>;

export type JoinSetup = Readonly<{
  version: number;
  fields: readonly JoinFieldView[];
  rules: JoinRules;
  welcomeLocked: boolean;
  guests: number;
}>;

/** An option in the editor: `key` names the row; `id` is set once it is saved. */
export type OptionDraft = Readonly<{ key: string; id: string | undefined; ar: string; en: string }>;

/**
 * A field in the editor: `key` names the row on the page; `id` is set once the field is saved. `options` is null for a
 * free-text answer, else the choices (a custom field only).
 */
export type FieldDraft = Readonly<{
  key: string;
  id: string | undefined;
  kind: JoinFieldKind;
  labelAr: string;
  labelEn: string;
  required: boolean;
  options: readonly OptionDraft[] | null;
}>;

export { JOIN_OPTION_MAX, JOIN_OPTION_MIN };

/** Whether saving these drafts deletes a saved field, and with it the answers players gave to it. */
export function removesSavedField(
  saved: readonly JoinFieldView[],
  drafts: readonly FieldDraft[],
): boolean {
  const kept = new Set(drafts.map((draft) => draft.id));
  return saved.some((field) => !kept.has(field.id));
}

export function draftsOf(fields: readonly JoinFieldView[]): FieldDraft[] {
  return fields.map((field) => ({
    key: field.id,
    id: field.id,
    kind: field.kind,
    labelAr: field.label.ar ?? "",
    labelEn: field.label.en ?? "",
    required: field.required,
    options:
      field.options?.map((option) => ({
        key: option.id,
        id: option.id,
        ar: option.ar ?? "",
        en: option.en ?? "",
      })) ?? null,
  }));
}

/** The kinds a row may take: its own, custom, and every named kind no other row uses. */
export function kindsFor(drafts: readonly FieldDraft[], index: number): JoinFieldKind[] {
  const taken = new Set(drafts.filter((_, at) => at !== index).map((draft) => draft.kind));
  return JOIN_FIELD_KINDS.filter((kind) => kind === "custom" || !taken.has(kind));
}

/** A new row: the first named kind still free, else a custom field. */
export function newDraft(drafts: readonly FieldDraft[], key: string): FieldDraft {
  const kind = kindsFor(drafts, -1)[0] ?? "custom";
  return { key, id: undefined, kind, labelAr: "", labelEn: "", required: false, options: null };
}

/** Moves a row up (-1) or down (+1); a move past either end changes nothing. */
export function moveDraft(
  drafts: readonly FieldDraft[],
  index: number,
  step: -1 | 1,
): FieldDraft[] {
  const target = index + step;
  if (target < 0 || target >= drafts.length) {
    return [...drafts];
  }
  const moved = [...drafts];
  const [row] = moved.splice(index, 1);
  moved.splice(target, 0, row as FieldDraft);
  return moved;
}

const optionBody = (option: OptionDraft) => ({
  ...(option.id === undefined ? {} : { id: option.id }),
  ...(option.ar.trim() === "" ? {} : { ar: option.ar }),
  ...(option.en.trim() === "" ? {} : { en: option.en }),
});

/**
 * The body of `PUT …/join/fields`: a label and options only for a custom field, an id only for a saved one or option.
 */
export function fieldsBody(version: number, drafts: readonly FieldDraft[]) {
  return {
    version,
    fields: drafts.map((draft) => ({
      ...(draft.id === undefined ? {} : { id: draft.id }),
      kind: draft.kind,
      ...(draft.kind === "custom"
        ? {
            label: {
              ...(draft.labelAr.trim() === "" ? {} : { ar: draft.labelAr }),
              ...(draft.labelEn.trim() === "" ? {} : { en: draft.labelEn }),
            },
            options: draft.options?.map(optionBody) ?? null,
          }
        : {}),
      required: draft.required,
    })),
  };
}

/** Whether a custom row still needs a label in at least one language. */
export const needsLabel = (draft: FieldDraft): boolean =>
  draft.kind === "custom" && draft.labelAr.trim() === "" && draft.labelEn.trim() === "";

/** Whether a choice row still needs options: at least two, each named in a language. */
export const needsOptions = (draft: FieldDraft): boolean =>
  draft.kind === "custom" &&
  draft.options !== null &&
  (draft.options.length < JOIN_OPTION_MIN ||
    draft.options.some((option) => option.ar.trim() === "" && option.en.trim() === ""));

/** The domains typed one per line (commas and spaces split too), without blanks. */
export function domainsOf(text: string): string[] {
  return text
    .split(/[\s,،]+/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** The welcome amount typed: null when empty, a whole number from 1 to 100 000, else "invalid". */
export function welcomeOf(text: string): number | null | "invalid" {
  const trimmed = text.trim();
  if (trimmed === "") {
    return null;
  }
  if (!/^[0-9]+$/.test(trimmed)) {
    return "invalid";
  }
  const amount = Number(trimmed);
  return amount >= 1 && amount <= 100_000 ? amount : "invalid";
}

/** The pasted guest list as lines, the empty ones kept so the API's line numbers match what was pasted. */
export function guestLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && lines.at(-1)?.trim() === "") {
    lines.pop();
  }
  return lines;
}
