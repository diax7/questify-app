import type { Language } from "#src/i18n/digits";

/**
 * Times in an event's own time zone (FR-1728, FR-1714). Every time the dashboard or the app shows for an event is in
 * the event's zone, labelled, and a date-time typed into the dashboard is read in that zone too, never the browser's.
 * Pure functions on `Intl`, so the app, the web and the API share one reading.
 */

type Parts = Readonly<{ year: number; month: number; day: number; hour: number; minute: number }>;

const HALF_DAY = 12 * 3_600_000;
const LOCAL_INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

const formatterFor = (timeZone: string): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

/** IANA names only: `UTC`, or `Area/Location` with each part capitalised (no `+03:00`, no `EST`, no `asia/riyadh`). */
const IANA_SHAPE = /^(UTC|[A-Z][A-Za-z]*(\/[A-Z][A-Za-z0-9_+-]*)+)$/;

/**
 * True when the name is an IANA time zone the runtime knows, written as IANA writes it. Offsets, abbreviations and case
 * variants are refused, so what is stored is a real zone name the database also knows. Older aliases are accepted
 * (`Asia/Kolkata`, which the runtime calls `Asia/Calcutta`), since both name the same clock.
 */
export function isTimeZone(name: string): boolean {
  if (!IANA_SHAPE.test(name)) {
    return false;
  }
  if (formatters.has(name)) {
    return true;
  }
  try {
    const formatter = formatterFor(name);
    const resolved = formatter.resolvedOptions().timeZone;
    // Same letters, other case: a mistyped spelling of a known zone, not a name of its own.
    if (resolved !== name && resolved.toLowerCase() === name.toLowerCase()) {
      return false;
    }
    // Only names that passed are kept, so the cache is bounded by the zone list, whatever callers send.
    formatters.set(name, formatter);
    return true;
  } catch {
    return false;
  }
}

/** The cached formatter for a canonical zone (callers check `isTimeZone` first, or pass a stored zone). */
function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  if (!isTimeZone(timeZone)) {
    throw new RangeError(`"${timeZone}" is not a canonical IANA time zone.`);
  }
  return formatters.get(timeZone) as Intl.DateTimeFormat;
}

/** The wall-clock reading of an instant in a zone. */
export function localParts(instant: Date, timeZone: string): Parts {
  const read: Record<string, number> = {};
  for (const part of partsFormatter(timeZone).formatToParts(instant)) {
    if (part.type !== "literal") {
      read[part.type] = Number(part.value);
    }
  }
  return {
    year: read["year"] ?? 0,
    month: read["month"] ?? 0,
    day: read["day"] ?? 0,
    hour: read["hour"] ?? 0,
    minute: read["minute"] ?? 0,
  };
}

const asUtc = (parts: Parts): number =>
  Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);

/** How far the zone's clock is ahead of UTC at an instant, in milliseconds. */
function offsetAt(instant: number, timeZone: string): number {
  const parts = localParts(new Date(instant), timeZone);
  return asUtc(parts) - Math.floor(instant / 60_000) * 60_000;
}

/**
 * The instant a wall-clock time (`YYYY-MM-DDTHH:mm`) names in a zone. A time skipped by a clock change moves forward
 * by the size of the gap; a time that happens twice is the earlier one.
 *
 * @throws RangeError for text that is not a local date-time or a zone this runtime does not know.
 */
export function toInstant(local: string, timeZone: string): Date {
  const match = LOCAL_INPUT.exec(local);
  const wall =
    match === null
      ? Number.NaN
      : Date.UTC(
          Number(match[1]),
          Number(match[2]) - 1,
          Number(match[3]),
          Number(match[4]),
          Number(match[5]),
        );
  // Date.UTC rolls an impossible date over (30 February becomes 2 March); reading it back catches that.
  if (
    match === null ||
    new Date(wall).toISOString().slice(0, 16) !== local ||
    !isTimeZone(timeZone)
  ) {
    throw new RangeError(
      `"${local}" in "${timeZone}" is not a local date-time in a known time zone.`,
    );
  }
  // The zone's offset just before and just after any clock change near this time; whichever reading maps back to the
  // typed time is right, the earlier when both do. Neither does inside a skipped hour: the offset from before moves it
  // forward by the size of the gap.
  const before = wall - offsetAt(wall - HALF_DAY, timeZone);
  const after = wall - offsetAt(wall + HALF_DAY, timeZone);
  const matching = [before, after].filter(
    (candidate) => asUtc(localParts(new Date(candidate), timeZone)) === wall,
  );
  return new Date(matching.length > 0 ? Math.min(...matching) : before);
}

const two = (value: number): string => String(value).padStart(2, "0");

/** An instant as the zone's wall clock, in the form a date-time field takes (`YYYY-MM-DDTHH:mm`). */
export function toLocalInput(instant: Date, timeZone: string): string {
  const p = localParts(instant, timeZone);
  return `${p.year}-${two(p.month)}-${two(p.day)}T${two(p.hour)}:${two(p.minute)}`;
}

/**
 * The event day an instant belongs to (FR-1714): the zone's calendar date, except that a time before the day-start
 * hour still belongs to the day before (a 1:00 am scan with a 4:00 am start counts for the previous evening).
 *
 * @returns the event day as `YYYY-MM-DD`.
 */
export function eventDayOf(instant: Date, timeZone: string, dayStartHour: number): string {
  const p = localParts(instant, timeZone);
  const date = new Date(Date.UTC(p.year, p.month - 1, p.day));
  if (p.hour < dayStartHour) {
    date.setUTCDate(date.getUTCDate() - 1);
  }
  return date.toISOString().slice(0, 10);
}

/** Names people know for the zones of the first markets; any other zone shows its own city name. */
const ZONE_NAMES: Readonly<Record<string, Readonly<Record<Language, string>>>> = {
  "Asia/Riyadh": { ar: "الرياض", en: "Riyadh" },
  "Asia/Dubai": { ar: "دبي", en: "Dubai" },
  "Asia/Kuwait": { ar: "الكويت", en: "Kuwait" },
  "Asia/Qatar": { ar: "الدوحة", en: "Doha" },
  "Asia/Bahrain": { ar: "البحرين", en: "Bahrain" },
  "Asia/Muscat": { ar: "مسقط", en: "Muscat" },
  "Africa/Cairo": { ar: "القاهرة", en: "Cairo" },
  "Asia/Amman": { ar: "عمّان", en: "Amman" },
};

/** The label shown after an event time, such as "Riyadh time" or "بتوقيت الرياض". */
export function zoneLabel(timeZone: string, language: Language): string {
  const city =
    ZONE_NAMES[timeZone]?.[language] ??
    timeZone.split("/").at(-1)?.replaceAll("_", " ") ??
    timeZone;
  return language === "ar" ? `بتوقيت ${city}` : `${city} time`;
}

const LOCALES: Readonly<Record<Language, string>> = {
  // Gregorian dates and Western digits in Arabic too (ADR-018); ar-SA would otherwise default to the Hijri calendar.
  ar: "ar-u-ca-gregory-nu-latn",
  en: "en-GB",
};

/** An event time for people: weekday, date and 24-hour time in the event's zone, with the zone named (FR-1728). */
export function formatEventTime(instant: Date, timeZone: string, language: Language): string {
  const text = new Intl.DateTimeFormat(LOCALES[language], {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(instant);
  return `${text} (${zoneLabel(timeZone, language)})`;
}

/**
 * A calendar date that is already local to its event (`2026-10-26`, as the passport sends it) for people: day, short
 * month and year, Gregorian, Western digits. No zone shift applies, so the day never moves.
 */
export function formatLocalDate(date: string, language: Language): string {
  return new Intl.DateTimeFormat(LOCALES[language], {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(`${date}T00:00:00Z`));
}

/**
 * A time window for people, in the event's zone (the prize desk's hours, ADR-150): "Thu 23 Oct, 16:00–22:00", or both
 * dates when it runs past midnight; 24-hour, Western digits, Gregorian, the zone named once.
 */
export function formatTimeWindow(
  opens: Date,
  closes: Date,
  timeZone: string,
  language: Language,
): string {
  const day = new Intl.DateTimeFormat(LOCALES[language], {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  const clock = new Intl.DateTimeFormat(LOCALES[language], {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const separator = language === "ar" ? "، " : ", ";
  const at = (instant: Date) => `${day.format(instant)}${separator}${clock.format(instant)}`;
  const text =
    day.format(opens) === day.format(closes)
      ? `${at(opens)}–${clock.format(closes)}`
      : `${at(opens)} – ${at(closes)}`;
  return `${text} (${zoneLabel(timeZone, language)})`;
}
