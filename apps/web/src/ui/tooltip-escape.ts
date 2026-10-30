"use client";

import { useEffect } from "react";

const DISMISSED = "data-tooltip-dismissed";
const SHOWING = "[data-tooltip]:is(:hover, :focus-visible)";

/**
 * Lets Escape hide the tooltip of an icon control while it is shown (WCAG 1.4.13). The control keeps `data-tooltip-dismissed`
 * until the pointer leaves it or focus moves off it, so the tooltip comes back on the next visit.
 */
export function useTooltipEscape(): void {
  useEffect(() => {
    const dismiss = (pressed: KeyboardEvent) => {
      if (pressed.key !== "Escape") {
        return;
      }
      for (const control of document.querySelectorAll<HTMLElement>(SHOWING)) {
        control.setAttribute(DISMISSED, "");
        const restore = () => {
          control.removeAttribute(DISMISSED);
          control.removeEventListener("pointerleave", restore);
          control.removeEventListener("blur", restore);
        };
        control.addEventListener("pointerleave", restore);
        control.addEventListener("blur", restore);
      }
    };
    document.addEventListener("keydown", dismiss);
    return () => document.removeEventListener("keydown", dismiss);
  }, []);
}
