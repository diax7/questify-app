import type { ShopState, ShopWindow } from "@questify/shared";
import type { EventStatus } from "#src/events/store";

/** Why a change to the days after the end is refused (ADR-336): the shop has closed, or the window would shrink. */
export type WindowRefusal = "closed" | "shorter";

/**
 * The window rule (ADR-336, FR-1018). Before the end any value; after the end, while the shop is open, only a longer
 * window; once closed, no change at all. Sending the stored value is no change. `state` is `shop_state` and
 * `statusNow` is `event_status_now`, both read in SQL in the caller's transaction, so "now" is the database's and
 * never the API's clock. An archived event's shop is always closed. The database's guard enforces the same rule on
 * its own clock and wins at the boundary (`windowRefusalOf`).
 */
export function windowRefusal(
  change: Readonly<{ state: ShopState; statusNow: EventStatus; current: number; wanted: number }>,
): WindowRefusal | null {
  if (change.wanted === change.current) {
    return null;
  }
  if (change.state === "closed") {
    return "closed";
  }
  return change.statusNow === "ended" && change.wanted < change.current ? "shorter" : null;
}

/**
 * The guard's refusal (`event_shop_window_guard`, SQLSTATE SW409) as the 409's reason, from its DETAIL; undefined for
 * any other error and for a DETAIL the guard never raises, so those are thrown as they are.
 */
export function windowRefusalOf(error: unknown): WindowRefusal | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const { code, detail } = error as { code?: unknown; detail?: unknown };
  if (code !== "SW409") {
    return undefined;
  }
  return detail === "closed" || detail === "shorter" ? detail : undefined;
}

/** What `event_shop` answers that Home's window reads. */
export type EventShopRow = Readonly<{
  state: ShopState;
  closes_at: Date | null;
  /** The ends of the desk's windows; null while the desk has no hours (open the whole time). */
  desk_closes: readonly Date[] | null;
}>;

/**
 * Home's shop window (ADR-338): the state and the close as the shop shows them to this player, and, only while the
 * shop is open, the end of the desk's last window when it comes before the close (items and experiences stop there;
 * digital rewards stay). That end may already be past while the shop is open: the app then says items have stopped.
 */
export function homeWindowOf(row: EventShopRow): ShopWindow {
  const closes = row.closes_at;
  const deskEnd = (row.desk_closes ?? []).reduce<Date | null>(
    (last, end) => (last === null || end > last ? end : last),
    null,
  );
  const before = row.state === "open" && deskEnd !== null && closes !== null && deskEnd < closes;
  return {
    state: row.state,
    closesAt: closes === null ? null : closes.toISOString(),
    deskEndsAt: before ? deskEnd.toISOString() : null,
  };
}
