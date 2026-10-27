import {
  invalidStreakSchema,
  streakConflictSchema,
  streakSettingsBodySchema,
  streakSettingsSchema,
  STREAK_BONUS_MAX,
  type MessageKey,
  type StreakField,
  type StreakSettings,
  type StreakSettingsBody,
} from "@questify/shared";

/** The seven ISO weekdays (1 is Monday) with the words that name them. */
export const WEEKDAYS = [
  { day: 1, label: "events.streak.monday" },
  { day: 2, label: "events.streak.tuesday" },
  { day: 3, label: "events.streak.wednesday" },
  { day: 4, label: "events.streak.thursday" },
  { day: 5, label: "events.streak.friday" },
  { day: 6, label: "events.streak.saturday" },
  { day: 7, label: "events.streak.sunday" },
] as const satisfies ReadonlyArray<Readonly<{ day: number; label: MessageKey }>>;

/** What the form holds: the bonus as typed, so an empty box means "no bonus". */
export type StreakDraft = Readonly<{
  enabled: boolean;
  bonus: string;
  closedWeekdays: readonly number[];
  closedDays: readonly string[];
}>;

/** The settings in a `GET` or `PUT` answer (`{streak}`), or undefined when it is not that shape. */
export function settingsOf(body: unknown): StreakSettings | undefined {
  const streak =
    typeof body === "object" && body !== null ? (body as { streak?: unknown }).streak : undefined;
  const parsed = streakSettingsSchema.safeParse(streak);
  return parsed.success ? parsed.data : undefined;
}

export const draftOf = (settings: StreakSettings): StreakDraft => ({
  enabled: settings.enabled,
  bonus: settings.bonusPoints === null ? "" : String(settings.bonusPoints),
  closedWeekdays: settings.closedWeekdays,
  closedDays: settings.closedDays,
});

export type BodyCheck =
  | Readonly<{ ok: true; body: StreakSettingsBody }>
  | Readonly<{ ok: false; field: StreakField }>;

/** The bonus as a whole number, or null for an empty box; undefined for anything else or out of range. */
function bonusOf(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === "") {
    return null;
  }
  const value = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  return Number.isInteger(value) && value >= 1 && value <= STREAK_BONUS_MAX ? value : undefined;
}

/** The request body for a draft, or the field to fix; the same schema the API checks with. */
export function bodyOf(draft: StreakDraft): BodyCheck {
  const bonusPoints = bonusOf(draft.bonus);
  if (bonusPoints === undefined) {
    return { ok: false, field: "bonusPoints" };
  }
  const parsed = streakSettingsBodySchema.safeParse({
    enabled: draft.enabled,
    bonusPoints,
    closedWeekdays: draft.closedWeekdays.toSorted((a, b) => a - b),
    closedDays: draft.closedDays,
  });
  if (parsed.success) {
    return { ok: true, body: parsed.data };
  }
  const field = String(parsed.error.issues[0]?.path[0] ?? "");
  return {
    ok: false,
    field: field === "closedWeekdays" || field === "closedDays" ? field : "enabled",
  };
}

export function toggleWeekday(draft: StreakDraft, day: number): StreakDraft {
  const closed = draft.closedWeekdays.includes(day)
    ? draft.closedWeekdays.filter((item) => item !== day)
    : [...draft.closedWeekdays, day].toSorted((a, b) => a - b);
  return { ...draft, closedWeekdays: closed };
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The day after an ISO date, as an ISO date (the date picker's first choosable day). */
export function dayAfter(day: string): string {
  const next = new Date(`${day}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/**
 * Adds a closed date: only an upcoming day (after the event's today, since days that have started can't change) that
 * is not in the list yet. Undefined when it may not be added.
 */
export function addClosedDay(
  draft: StreakDraft,
  day: string,
  today: string,
): StreakDraft | undefined {
  if (!ISO_DAY.test(day) || day <= today || draft.closedDays.includes(day)) {
    return undefined;
  }
  return { ...draft, closedDays: [...draft.closedDays, day].toSorted() };
}

export const removeClosedDay = (draft: StreakDraft, day: string): StreakDraft => ({
  ...draft,
  closedDays: draft.closedDays.filter((item) => item !== day),
});

/** A closed date that has started: listed, but fixed. */
export const hasStarted = (day: string, today: string): boolean => day <= today;

/** A refusal in words: the message to show, and the day it names when it names one. */
export type Refusal = Readonly<{ key: MessageKey; day?: string }>;

const CONFLICT_KEYS = {
  single_day: "events.streak.refuse.singleDay",
  day_started: "events.streak.refuse.dayStarted",
  results_final: "events.streak.refuse.resultsFinal",
  archived: "events.streak.refuse.archived",
} as const satisfies Record<string, MessageKey>;

const INVALID_KEYS = {
  bonusPoints: "events.streak.invalid.bonusPoints",
  closedWeekdays: "events.streak.invalid.closedWeekdays",
  closedDays: "events.streak.invalid.closedDays",
  enabled: "events.streak.invalid.enabled",
} as const satisfies Record<StreakField, MessageKey>;

/** What a 409 `streak_conflict` or 422 `invalid_streak` says, or undefined for any other answer. */
export function refusalOf(body: unknown): Refusal | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const { code, details } = body as { code?: unknown; details?: unknown };
  if (code === "streak_conflict") {
    const conflict = streakConflictSchema.safeParse(details);
    return conflict.success
      ? {
          key: CONFLICT_KEYS[conflict.data.reason],
          ...(conflict.data.day === undefined ? {} : { day: conflict.data.day }),
        }
      : undefined;
  }
  if (code === "invalid_streak") {
    const invalid = invalidStreakSchema.safeParse(details);
    return invalid.success ? { key: INVALID_KEYS[invalid.data.field] } : undefined;
  }
  return undefined;
}

export type Preview =
  | Readonly<{ key: "events.streak.preview.off" | "events.streak.preview.plain" }>
  | Readonly<{ key: "events.streak.preview.bonus"; points: number }>;

/** What players will see with this draft: nothing, the streak alone, or the streak with its bonus. */
export function previewOf(draft: StreakDraft): Preview {
  if (!draft.enabled) {
    return { key: "events.streak.preview.off" };
  }
  const points = bonusOf(draft.bonus);
  return typeof points === "number"
    ? { key: "events.streak.preview.bonus", points }
    : { key: "events.streak.preview.plain" };
}

/** An ISO date kept as a left-to-right run inside Arabic text. */
export const isolatedDay = (day: string): string => `⁦${day}⁩`;
