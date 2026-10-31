import {
  MESSAGES,
  NO_OVERRIDES,
  SETUP_STEPS,
  interpolate,
  isUsableOverride,
  setupReadSchema,
  wordParams,
  type EventTerms,
  type Language,
  type MessageKey,
  type Overrides,
  type SetupProgress,
  type SetupStep,
} from "@questify/shared";
import type { Translate } from "#src/lib/language.ts";

/** The dashboard page a step also has, as its address after the event's own (the page's "Explain this" opens the step). */
export const STEP_PAGES: Readonly<Record<string, SetupStep>> = {
  joining: "join",
  quests: "quests",
  rewards: "rewards",
  sponsors: "sponsors",
  "big-screen": "screens",
  announcements: "messages",
};

/** The step an event page explains, or undefined when the page has none. */
export const stepOfPage = (slug: string): SetupStep | undefined => STEP_PAGES[slug];

/** The name of a step in the wizard's words (editable in the translation store). */
export const stepNameKey = (step: SetupStep): MessageKey => `wizard.${step}.name`;

/** The question a step asks (editable in the translation store). */
export const stepTitleKey = (step: SetupStep): MessageKey => `wizard.${step}.title`;

/** The address of an event's guided setup, opened at a step; `only` shows that step alone (FR-1756, "Explain this"). */
export function setupPath(
  base: Readonly<{ language: Language; organizerId: string; eventId: string }>,
  open?: Readonly<{ step: SetupStep; only?: boolean; from?: string }>,
): string {
  const path = `/${base.language}/organizers/${base.organizerId}/events/${base.eventId}/setup`;
  if (open === undefined) {
    return path;
  }
  const only = open.only === true ? "&only=1" : "";
  return `${path}?step=${open.step}${only}${open.from === undefined ? "" : `&from=${open.from}`}`;
}

/** The step a `?step=` value names, or undefined for a name that is not a step. */
export function stepOfQuery(value: string | null): SetupStep | undefined {
  return SETUP_STEPS.find((step) => step === value);
}

/** Checks the API's answer to `GET …/setup`, so a changed API shows the error state instead of a broken wizard. */
export function readSetup(body: unknown): SetupProgress | undefined {
  const read = setupReadSchema.safeParse(body);
  if (!read.success) {
    return undefined;
  }
  const { currentStep, steps, finished } = read.data.setup;
  return { currentStep, steps, finished };
}

/** Keeps the texts of the translation store's answer that are plain text per key; anything else is dropped. */
export function readOverrides(body: unknown): Overrides {
  if (typeof body !== "object" || body === null) {
    return NO_OVERRIDES;
  }
  const result: Record<Language, Record<string, string>> = { ar: {}, en: {} };
  for (const language of ["ar", "en"] as const) {
    const texts = (body as Record<string, unknown>)[language];
    if (typeof texts !== "object" || texts === null) {
      continue;
    }
    for (const [key, text] of Object.entries(texts)) {
      if (typeof text === "string") {
        result[language][key] = text;
      }
    }
  }
  return result;
}

/**
 * The wizard's translator: the text an admin changed in the translation store when there is a usable one for the key
 * (not blank, the shipped placeholders), else the shipped text, with the event's words filled in (FR-1757, FR-1768).
 */
export function withOverrides(
  base: Translate,
  language: Language,
  terms: EventTerms,
  overrides: Overrides,
): Translate {
  const words = wordParams(terms, language);
  return (key, params) => {
    const stored = overrides[language][key];
    if (stored !== undefined && isUsableOverride(MESSAGES, key, language, stored)) {
      return interpolate(stored, { ...words, ...params }, language);
    }
    return base(key, params);
  };
}

/** The single-step view of step number `target` (1 to 10) from another single-step view, keeping the page Done returns to. */
export function alonePath(
  base: Readonly<{ language: Language; organizerId: string; eventId: string }>,
  target: number,
  from: string | undefined,
): string {
  const step = SETUP_STEPS[target - 1] ?? "basics";
  return setupPath(base, from === undefined ? { step, only: true } : { step, only: true, from });
}
