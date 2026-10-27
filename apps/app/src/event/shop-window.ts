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

/**
 * When Home reads itself again so the close and the desk's end show on the server's word: a second after the next
 * of them still ahead, at most a day away (a timer cannot wait longer than about 24 days); null when none is ahead.
 */
export function nextShopBoundary(window: ShopWindow | null, now: number): number | null {
  if (window === null || window.state !== "open") {
    return null;
  }
  const ahead = [window.closesAt, window.deskEndsAt]
    .flatMap((instant) => (instant === null ? [] : [Date.parse(instant) - now]))
    .filter((left) => left > 0);
  return ahead.length === 0 ? null : Math.min(Math.min(...ahead) + 1000, DAY);
}
