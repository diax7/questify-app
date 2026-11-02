import {
  MESSAGES,
  featureSwitchBodySchema,
  switchesViewSchema,
  type FeatureRow,
  type FeatureSwitchBody,
  type MessageKey,
  type SwitchesView,
  type TuningRow,
} from "@questify/shared";

/** The console's platform switches and tuning numbers (T-703, FR-1405, FR-1769, FR-1770). */
export const SWITCHES_API = "/v1/admin/switches";

export const SWITCH_TABS = ["features", "numbers"] as const;
export type SwitchTab = (typeof SWITCH_TABS)[number];

export const featurePath = (key: string): string =>
  `${SWITCHES_API}/features/${encodeURIComponent(key)}`;
export const tuningPath = (key: string): string =>
  `${SWITCHES_API}/tuning/${encodeURIComponent(key)}`;

/** Answers undefined when the body is not the expected shape, so a changed API shows the error state. */
export function readSwitches(body: unknown): SwitchesView | undefined {
  const parsed = switchesViewSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

/** The message key of a feature's or number's name, or undefined for one that has no name yet. */
export function nameKeyOf(kind: "feature" | "number", key: string): MessageKey | undefined {
  const id = `console.switches.${kind}.${key}`;
  return Object.hasOwn(MESSAGES, id) ? (id as MessageKey) : undefined;
}

export type MessageDraft = Readonly<{ ar: string; en: string }>;

export const messageDraftOf = (row: FeatureRow): MessageDraft => row.message ?? { ar: "", en: "" };

/** What was typed as the players' message: both languages, or neither (no message), or a refusal. */
export type CheckedMessage =
  | Readonly<{ ok: true; message: MessageDraft | null }>
  | Readonly<{ ok: false; fields: ReadonlySet<string> }>;

export function checkMessage(draft: MessageDraft): CheckedMessage {
  const message = { ar: draft.ar.trim(), en: draft.en.trim() };
  if (message.ar === "" && message.en === "") {
    return { ok: true, message: null };
  }
  const parsed = featureSwitchBodySchema.safeParse({ enabled: false, message });
  if (parsed.success) {
    return { ok: true, message };
  }
  const fields = new Set(parsed.error.issues.map((issue) => issue.path.map(String).join(".")));
  return { ok: false, fields };
}

/** The body that switches a feature on (no message) or off (with the message typed, when it is usable). */
export function featureBody(enabled: boolean, draft: MessageDraft): FeatureSwitchBody {
  const checked = enabled ? undefined : checkMessage(draft);
  return { enabled, message: checked?.ok === true ? checked.message : null };
}

/** True when the typed message differs from the saved one. */
export function isMessageDirty(row: FeatureRow, draft: MessageDraft): boolean {
  const saved = messageDraftOf(row);
  return saved.ar !== draft.ar.trim() || saved.en !== draft.en.trim();
}

/** Whole numbers only: "12" is 12; "1.5", "" and "1e3" are not numbers the API takes. */
export const wholeNumberOf = (text: string): number =>
  /^\d{1,9}$/.test(text.trim()) ? Number(text) : Number.NaN;

/** The number typed for a tuning row, when it is whole and inside the row's range. */
export function numberFor(row: TuningRow, text: string): number | undefined {
  const value = wholeNumberOf(text);
  return value >= row.min && value <= row.max ? value : undefined;
}
