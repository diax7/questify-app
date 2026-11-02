"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

const PLAIN_LEFT_CLICK = (event: MouseEvent): boolean =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

/**
 * While `dirty`, the browser asks before the tab closes or reloads, and a click on a link that leaves this page is held
 * back and handed to `ask`, which gets the way to carry on once the person has chosen (FR-1757: asked to save or discard
 * when leaving with an edit that is not saved).
 */
export function useLeaveGuard(dirty: boolean, ask: (leave: () => void) => void): void {
  const router = useRouter();
  useEffect(() => {
    if (!dirty) {
      return;
    }
    const beforeUnload = (event: BeforeUnloadEvent): void => event.preventDefault();
    const onClick = (event: MouseEvent): void => {
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(link instanceof HTMLAnchorElement) || link.target === "_blank") {
        return;
      }
      const url = new URL(link.href);
      const here = window.location;
      // Another site is left through the browser's own prompt (`beforeunload`); only this app's pages are held back here.
      const leaves = url.origin === here.origin && url.pathname !== here.pathname;
      if (event.defaultPrevented || !PLAIN_LEFT_CLICK(event) || !leaves) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      ask(() => router.push(`${url.pathname}${url.search}${url.hash}`));
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty, ask, router]);
}
