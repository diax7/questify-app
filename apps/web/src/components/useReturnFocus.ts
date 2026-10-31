"use client";

import { useRef } from "react";

/**
 * Remembers the control that opened a dialog or form, and gives it the focus back when that closes, so a keyboard or
 * screen-reader user carries on where they were. An opener that is gone (a deleted card's own button) hands the focus to
 * the element `fallbackId` names, never to nowhere.
 */
export function useReturnFocus(fallbackId: string) {
  const opener = useRef<HTMLElement | null>(null);
  return {
    remember: () => {
      opener.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    },
    restore: () => {
      const target = opener.current;
      opener.current = null;
      // After the closing render.
      setTimeout(() => {
        const fallback = document.getElementById(fallbackId);
        (target?.isConnected === true ? target : fallback)?.focus();
      }, 0);
    },
  };
}
