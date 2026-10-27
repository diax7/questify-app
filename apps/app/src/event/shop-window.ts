import { shopWindowSchema, type ShopWindow } from "@questify/shared";

const DAY = 24 * 60 * 60 * 1000;

/** Home's `shopWindow` as sent, or null: an older API sends none, and one this app cannot read is left out. */
export function readShopWindow(value: unknown): ShopWindow | null {
  const parsed = shopWindowSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** What the desk's hours mean for items and experiences while the shop is open: they stop at `endsAt`. */
export type DeskLine = Readonly<{ kind: "until"; endsAt: string }> | Readonly<{ kind: "stopped" }>;

/** What Home says about the shop after the event ended (ADR-338): open until a date, or closed. */
export type ShopLine =
  | Readonly<{ kind: "open"; closesAt: string; desk: DeskLine | null }>
  | Readonly<{ kind: "closed"; closesAt: string | null }>;

/**
 * The shop line Home shows. Nothing before the end (the shop is simply open then) and nothing while it is not open;
 * with the desk's last window already past, the line says items and experiences stopped, never "can be reserved until"
 * a date that has gone.
 */
export function shopLine(window: ShopWindow | null, ended: boolean, now: number): ShopLine | null {
  if (window === null) {
    return null;
  }
  if (window.state === "closed") {
    return { kind: "closed", closesAt: window.closesAt };
  }
  if (window.state !== "open" || !ended || window.closesAt === null) {
    return null;
  }
  if (window.deskEndsAt === null) {
    return { kind: "open", closesAt: window.closesAt, desk: null };
  }
  const deskOpen = Date.parse(window.deskEndsAt) > now;
  return {
    kind: "open",
    closesAt: window.closesAt,
    desk: deskOpen ? { kind: "until", endsAt: window.deskEndsAt } : { kind: "stopped" },
  };
}

/** The balance reads "Closed" once the shop has closed (ADR-337): the number can no longer be redeemed. */
export const shopClosed = (window: ShopWindow | null): boolean => window?.state === "closed";

/** How long to wait before asking again when the phone's clock has passed a boundary the server has not (see below). */
const RETRY_MS = 15_000;

/** A boundary the phone passed by at most this much is a phone running ahead of the server; an older one is just past. */
const PHONE_AHEAD_MS = 120_000;

/** The delay to read Home again for one boundary `left` milliseconds away on the phone's clock; null to ignore it. */
function delayFor(left: number): number | null {
  if (left > 0) {
    return Math.min(left + 1000, DAY);
  }
  return left > -PHONE_AHEAD_MS ? RETRY_MS : null;
}

/**
 * When Home reads itself again so the close and the desk's end show on the server's word: a second after the next of
 * them still ahead, at most a day away (a timer cannot wait longer than about 24 days). While the shop is open, a
 * boundary the phone's clock passed by under 2 minutes means the phone runs ahead and the server still says open:
 * ask again in 15 seconds, so Home never keeps the open shop on screen until the next focus. An older boundary (a desk
 * that ended days ago while the shop stays open) is ignored, or Home would ask every 15 seconds for days. Null when
 * there is nothing to wait for.
 */
export function nextShopBoundary(window: ShopWindow | null, now: number): number | null {
  if (window === null || window.state !== "open") {
    return null;
  }
  const delays = [window.closesAt, window.deskEndsAt]
    .flatMap((instant) => (instant === null ? [] : [delayFor(Date.parse(instant) - now)]))
    .filter((delay): delay is number => delay !== null);
  return delays.length === 0 ? null : Math.min(...delays);
}
