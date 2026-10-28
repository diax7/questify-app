import { NOTIFICATION_UNREAD_CAP } from "@questify/shared";
import { useSyncExternalStore } from "react";

/**
 * The bell's unread count, shared by every screen that shows it (Questify Home, Event Home, Profile). It starts from
 * `GET /v1/me` (`notifications.unread`) and follows every answer of the center, so reading a row clears the dot
 * everywhere at once. The server counts up to 100.
 */
let unread = 0;
const listeners = new Set<() => void>();

/** Sets the count (a whole number from 0 to 100; anything else is 0); listeners run only when it changed. */
export function setUnread(count: number): void {
  const whole = Number.isFinite(count) ? Math.trunc(count) : 0;
  const next = Math.min(NOTIFICATION_UNREAD_CAP, Math.max(0, whole));
  if (next === unread) return;
  unread = next;
  for (const listener of listeners) listener();
}

export const getUnread = (): number => unread;

/** Sets the count from a read that may have failed: a failed read (null) leaves the count as it is. */
export function setUnreadIfRead(count: number | null): void {
  if (count !== null) setUnread(count);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The unread count now, re-rendering the caller when it changes. */
export function useUnread(): number {
  return useSyncExternalStore(subscribe, getUnread, getUnread);
}
