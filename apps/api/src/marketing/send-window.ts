import type { MarketingChannel } from "@questify/shared";

/**
 * When a promotion may reach a player (FR-1738, ADR-318). Promotional SMS is never sent 22:00 to 09:00 Saudi time, and
 * in Ramadan never 01:00 to 12:00 (CST). Push and email have no window (ADR-065); `CHANNELS_WITH_WINDOW` is the one
 * place to change that (Q-287).
 */

/** Saudi Arabia has no daylight saving: Riyadh is UTC+3 all year. */
const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** The latest the next allowed time can be: a Ramadan window ends at noon, so two days is far more than enough. */
const SEARCH_HOURS = 48;

const CHANNELS_WITH_WINDOW: ReadonlySet<MarketingChannel> = new Set(["sms"]);

const islamicMonth = new Intl.DateTimeFormat("en-u-ca-islamic-umalqura", {
  month: "numeric",
  timeZone: "UTC",
});
const RAMADAN = 9;

// Without the Umm al-Qura calendar (a Node built without full ICU data) the month would silently be the Gregorian one and
// September would read as Ramadan, so a server that cannot tell does not start.
if (islamicMonth.resolvedOptions().calendar !== "islamic-umalqura") {
  throw new Error(
    "This Node has no Umm al-Qura calendar (islamic-umalqura): the Ramadan send window cannot be computed. Use Node 22 with full ICU data.",
  );
}

type Local = Readonly<{ hour: number; noon: number }>;

/** The Riyadh hour of a moment, and that civil day's noon as a UTC instant (for calendar lookups). */
function localOf(at: Date): Local {
  const shifted = at.getTime() + RIYADH_OFFSET_MS;
  const day = Math.floor(shifted / DAY_MS);
  return { hour: Math.floor((shifted - day * DAY_MS) / HOUR_MS), noon: day * DAY_MS + DAY_MS / 2 };
}

const inRamadan = (noon: number): boolean =>
  Number(islamicMonth.format(new Date(noon))) === RAMADAN;

/**
 * Whether a day is in Ramadan by the Umm al-Qura calendar. The sighting can differ from the calendar by a day, so a
 * day beside a day outside Ramadan is `edge` and takes both windows.
 */
function ramadanOn(noon: number): "yes" | "no" | "edge" {
  const around = [noon - DAY_MS, noon, noon + DAY_MS].map(inRamadan);
  if (around.every(Boolean)) return "yes";
  return around.some(Boolean) ? "edge" : "no";
}

/** Whether a promotional SMS may be sent at this moment. */
export function isPromoSmsAllowed(at: Date): boolean {
  const { hour, noon } = localOf(at);
  const quiet = hour >= 22 || hour < 9;
  const ramadanQuiet = hour >= 1 && hour < 12;
  switch (ramadanOn(noon)) {
    case "no":
      return !quiet;
    case "yes":
      return !ramadanQuiet;
    case "edge":
      return !quiet && !ramadanQuiet;
  }
}

/**
 * The moment a promotion on a channel may go out, not before `at`: `at` itself when it is allowed, else the first full
 * hour when it is (a window ends on the hour).
 */
export function promoSendTime(channel: MarketingChannel, at: Date): Date {
  if (!CHANNELS_WITH_WINDOW.has(channel) || isPromoSmsAllowed(at)) return at;
  const firstHour = Math.ceil((at.getTime() + 1) / HOUR_MS) * HOUR_MS;
  for (let step = 0; step < SEARCH_HOURS; step += 1) {
    const candidate = new Date(firstHour + step * HOUR_MS);
    if (isPromoSmsAllowed(candidate)) return candidate;
  }
  throw new Error(
    "No allowed promotional SMS time within 48 hours: the send window is misconfigured.",
  );
}
