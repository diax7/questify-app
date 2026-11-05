import {
  HEALTH_COUNT_CAP,
  adminAccountsSchema,
  adminSessionsSchema,
  formatNumber,
  healthViewSchema,
  platformNumbersSchema,
  type AdminAccount,
  type AdminSession,
  type HealthFact,
  type HealthState,
  type HealthView,
  type Language,
  type PlatformNumbers,
} from "@questify/shared";
import { clockOf } from "#src/lib/console-organizers.ts";
import type { Translate } from "#src/lib/language.ts";
import type { IconName } from "#src/ui/Icon.tsx";

/** The console's platform pages (T-709): health, numbers, and the admin accounts with their sessions. */
export const HEALTH_API = "/v1/admin/health";
export const NUMBERS_API = "/v1/admin/numbers";
export const ADMINS_API = "/v1/admin/admins";

/** The API path of one admin's sessions. The id always comes from a list the schema checked, so it is a UUID. */
export const adminSessionsPath = (staffUserId: string): string =>
  `${ADMINS_API}/${staffUserId}/sessions`;

/** The API path that ends one session. */
export const endSessionPath = (sessionId: string): string => `/v1/admin/sessions/${sessionId}/end`;

/** The API path that ends every session of one staff account (T-810c, FR-141). */
export const endStaffSessionsPath = (staffUserId: string): string =>
  `/v1/admin/staff/${staffUserId}/end-sessions`;

/** Each reader answers undefined when the body is not the expected shape, so a changed API shows the error state. */
export function readHealthView(body: unknown): HealthView | undefined {
  const parsed = healthViewSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

export function readPlatformNumbers(body: unknown): PlatformNumbers | undefined {
  const parsed = platformNumbersSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

export function readAdminAccounts(body: unknown): AdminAccount[] | undefined {
  const parsed = adminAccountsSchema.safeParse(body);
  return parsed.success ? parsed.data.admins : undefined;
}

export function readAdminSessions(body: unknown): AdminSession[] | undefined {
  const parsed = adminSessionsSchema.safeParse(body);
  return parsed.success ? parsed.data.sessions : undefined;
}

/** The icon of a state: a tick, a triangle, a barred circle. The word beside it says the same, so colour is never alone. */
export const STATE_ICON: Readonly<Record<HealthState, IconName>> = {
  ok: "check",
  warning: "alert",
  down: "blocked",
};

/** A count read through a cap shows `10,000+` once it reached the cap; the cap itself is one more than that. */
export function cappedCount(value: number, language: Language, cap = HEALTH_COUNT_CAP): string {
  return value >= cap ? `${formatNumber(cap - 1, language)}+` : formatNumber(value, language);
}

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;

/** A wait in its largest whole unit: 45 s, 12 min, 3 h, 2 d. */
export function ageText(t: Translate, seconds: number, language: Language): string {
  if (seconds >= DAY) {
    return t("console.health.unit.days", { n: formatNumber(Math.floor(seconds / DAY), language) });
  }
  if (seconds >= HOUR) {
    return t("console.health.unit.hours", {
      n: formatNumber(Math.floor(seconds / HOUR), language),
    });
  }
  if (seconds >= MINUTE) {
    return t("console.health.unit.minutes", {
      n: formatNumber(Math.floor(seconds / MINUTE), language),
    });
  }
  return t("console.health.unit.seconds", { n: formatNumber(seconds, language) });
}

function numberText(
  t: Translate,
  kind: HealthFact["kind"],
  value: number,
  language: Language,
): string {
  switch (kind) {
    case "seconds":
      return ageText(t, value, language);
    case "percent":
      return `${formatNumber(value, language)}%`;
    case "millis":
      return t("console.health.unit.milliseconds", { n: formatNumber(value, language) });
    default:
      return cappedCount(value, language);
  }
}

/** One fact's value in words and Western digits. A missing wait reads "None"; a setup flag reads Set up or Not set up. */
export function factValue(t: Translate, fact: HealthFact, language: Language): string {
  const { kind, value } = fact;
  if (kind === "setup") {
    return value === 1 ? t("console.health.setUp") : t("console.health.notSetUp");
  }
  if (kind === "text") {
    return String(value);
  }
  if (value === null) {
    return t("console.health.none");
  }
  if (typeof value === "string") {
    return kind === "time" ? clockOf(value, language) : value;
  }
  return numberText(t, kind, value, language);
}
