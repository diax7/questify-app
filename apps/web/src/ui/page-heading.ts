"use client";

import { usePathname } from "next/navigation";
import { useEffect, type RefObject } from "react";

const SEPARATOR = " · ";

/** Whether this document has already shown a page; a layout swap remounts the shell but not the document. */
let pageShown = false;

/** Takes focus to the heading unless the person is already working inside the page, or `keep` holds it. */
function focusHeading(heading: HTMLElement, main: HTMLElement, keep: HTMLElement | null): void {
  const active = document.activeElement;
  const insidePage = active !== null && active !== document.body && main.contains(active);
  if (!insidePage && active !== keep) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
}

/** Puts the page's heading in the title; the heading once it exists, else nothing. */
function nameTab(main: HTMLElement, siteTitle: string): HTMLElement | null {
  const heading = main.querySelector<HTMLElement>("h1");
  const name = heading?.textContent.trim() ?? "";
  if (heading === null || name === "") {
    return null;
  }
  const title = `${name}${SEPARATOR}${siteTitle}`;
  if (document.title !== title) {
    document.title = title;
  }
  return heading;
}

/**
 * Names each page for the tab and for a screen reader, and after a page change moves focus to the page's heading.
 * The shell stays while its pages change, so the browser's own page load no longer does either: the title is the page's
 * heading in front of `siteTitle`, kept in step as the heading arrives or changes, and the heading takes focus once per
 * change unless the person already moved into the page, or `keep` (the phone's Menu button, where the sheet puts focus
 * when it closes) holds it.
 */
export function usePageHeading(
  mainId: string,
  siteTitle: string,
  keep: RefObject<HTMLElement | null>,
): void {
  const pathname = usePathname();
  useEffect(() => {
    const main = document.getElementById(mainId);
    if (main === null) {
      return undefined;
    }
    let moveFocus = pageShown;
    pageShown = true;
    const sync = () => {
      const heading = nameTab(main, siteTitle);
      if (heading !== null && moveFocus) {
        moveFocus = false;
        focusHeading(heading, main, keep.current);
      }
    };
    sync();
    const watcher = new MutationObserver(sync);
    watcher.observe(main, { childList: true, subtree: true, characterData: true });
    const titleElement = document.querySelector("title");
    if (titleElement !== null) {
      watcher.observe(titleElement, { childList: true });
    }
    return () => watcher.disconnect();
  }, [pathname, mainId, siteTitle, keep]);
}
