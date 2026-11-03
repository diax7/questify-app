import {
  bannerBodySchema,
  eventMaintenanceBodySchema,
  maintenanceBodySchema,
  noticesViewSchema,
  type BannerBody,
  type EventMaintenanceBody,
  type MaintenanceBody,
  type NoticesView,
} from "@questify/shared";
import { SWITCHES_API, type MessageDraft } from "#src/lib/console-switches.ts";

/** The console's maintenance mode and banner (T-703b, FR-1771, FR-1772). */
export const NOTICES_API = `${SWITCHES_API}/notices`;
export const GLOBAL_MAINTENANCE_PATH = `${SWITCHES_API}/maintenance/global`;
export const EVENT_MAINTENANCE_PATH = `${SWITCHES_API}/maintenance/events`;
export const BANNER_PATH = `${SWITCHES_API}/banner`;

export const eventResumePath = (eventId: string): string =>
  `${EVENT_MAINTENANCE_PATH}/${encodeURIComponent(eventId)}`;

/** Answers undefined when the body is not the expected shape, so a changed API shows the error state. */
export function readNotices(body: unknown): NoticesView | undefined {
  const parsed = noticesViewSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

/** What was typed, checked: the body to send, or the names of the fields the check refused. */
export type Checked<T> =
  | Readonly<{ ok: true; body: T }>
  | Readonly<{ ok: false; fields: ReadonlySet<string> }>;

function refused(issues: readonly Readonly<{ path: readonly PropertyKey[] }>[]): Checked<never> {
  return { ok: false, fields: new Set(issues.map((issue) => issue.path.map(String).join("."))) };
}

const messageOf = (draft: MessageDraft): MessageDraft => ({
  ar: draft.ar.trim(),
  en: draft.en.trim(),
});

/** The message that pauses play everywhere: both languages, never blank. */
export function checkGlobalPause(draft: MessageDraft): Checked<MaintenanceBody> {
  const parsed = maintenanceBodySchema.safeParse({ message: messageOf(draft) });
  return parsed.success ? { ok: true, body: parsed.data } : refused(parsed.error.issues);
}

/** The join code and the message that pause one event. */
export function checkEventPause(
  joinCode: string,
  draft: MessageDraft,
): Checked<EventMaintenanceBody> {
  const parsed = eventMaintenanceBodySchema.safeParse({ joinCode, message: messageOf(draft) });
  return parsed.success ? { ok: true, body: parsed.data } : refused(parsed.error.issues);
}

const pad = (value: number): string => String(value).padStart(2, "0");

/** An instant as the value of a `datetime-local` box, in the browser's own time zone (Western digits). */
export function localInputOf(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The instant a `datetime-local` value means in the browser's time zone, or undefined when it is not a date and time. */
export function instantOf(local: string): string | undefined {
  const time = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local) ? Date.parse(local) : Number.NaN;
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

export type BannerDraft = Readonly<{ message: MessageDraft; startsAt: string; endsAt: string }>;

export const NO_MESSAGE: MessageDraft = { ar: "", en: "" };
export const NO_BANNER: BannerDraft = { message: NO_MESSAGE, startsAt: "", endsAt: "" };

/** The boxes of the banner form for the banner in force (empty boxes when there is none). */
export function bannerDraftOf(banner: NoticesView["banner"]): BannerDraft {
  return banner === null
    ? NO_BANNER
    : {
        message: banner.message,
        startsAt: localInputOf(banner.startsAt),
        endsAt: localInputOf(banner.endsAt),
      };
}

const NONE: ReadonlySet<string> = new Set();

/** The fields to mark: the refused ones, but only once the person has typed something. */
export function markedFields(touched: boolean, checked: Checked<unknown>): ReadonlySet<string> {
  return touched && !checked.ok ? checked.fields : NONE;
}

/** The banner typed: a message in both languages and a window that ends after it starts. */
export function checkBanner(draft: BannerDraft): Checked<BannerBody> {
  const startsAt = instantOf(draft.startsAt);
  const endsAt = instantOf(draft.endsAt);
  const parsed = bannerBodySchema.safeParse({
    message: messageOf(draft.message),
    startsAt,
    endsAt,
  });
  return parsed.success ? { ok: true, body: parsed.data } : refused(parsed.error.issues);
}
