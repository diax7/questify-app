"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Icon } from "#src/ui/Icon.tsx";
import { usePageHeading } from "#src/ui/page-heading.ts";
import { useTooltipEscape } from "#src/ui/tooltip-escape.ts";
import styles from "#src/ui/shell.module.css";

type Props = Readonly<{
  brand: ReactNode;
  /** Always in the top bar: the language switch. */
  topEnd: ReactNode;
  /** The signed-in person's links (home, account, sign out): in the top bar on a desktop, in the menu on a phone. */
  account: ReactNode;
  nav: ReactNode;
  labels: Readonly<{ menu: string; navigation: string; skip: string; site: string }>;
  narrow: boolean;
  children: ReactNode;
}>;

/**
 * The parts of the shell that move: on a phone the navigation and the account links open from the Menu button as a
 * sheet under the top bar, with the page beneath it inert. The sheet closes on Escape, on a tap of any link in it (the
 * page's own link included, which changes nothing in the address) and when the page changes by any other way; however it
 * closes, focus goes back to the Menu button. On a desktop they are always shown.
 */
export function ShellFrame({ brand, topEnd, account, nav, labels, narrow, children }: Props) {
  const [open, setOpen] = useState(false);
  // The shell stays while its pages change, so a page change closes the phone's menu sheet (a full load used to).
  const pathname = usePathname();
  const [sheetFor, setSheetFor] = useState(pathname);
  if (sheetFor !== pathname) {
    setSheetFor(pathname);
    setOpen(false);
  }
  const menuButton = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) {
      menuButton.current?.focus();
    }
    wasOpen.current = open;
  }, [open]);
  usePageHeading("main", labels.site, menuButton);
  useTooltipEscape();
  useEffect(() => {
    if (!open) {
      return;
    }
    const closeOnEscape = (pressed: KeyboardEvent) => {
      if (pressed.key === "Escape") {
        setOpen(false);
      }
    };
    // A phone turned sideways or a window widened shows the column instead; the page must not stay inert then.
    const wide = window.matchMedia("(min-width: 64rem)");
    const closeWhenWide = () => {
      if (wide.matches) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", closeOnEscape);
    wide.addEventListener("change", closeWhenWide);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      wide.removeEventListener("change", closeWhenWide);
    };
  }, [open]);
  const hasMenu = nav !== null || account !== null;
  return (
    <div className={styles.shell}>
      <a className={styles.skip} href="#main">
        {labels.skip}
      </a>
      <header className={styles.top}>
        {hasMenu ? (
          <button
            ref={menuButton}
            type="button"
            className={styles.menuButton}
            aria-expanded={open}
            aria-controls="shell-navigation"
            onClick={() => setOpen((now) => !now)}
          >
            <Icon name="menu" />
            {labels.menu}
          </button>
        ) : null}
        {brand}
        <div className={styles.topEnd}>
          {topEnd}
          {account === null ? null : <div className={styles.desktopOnly}>{account}</div>}
        </div>
      </header>
      <div className={styles.body}>
        {hasMenu ? (
          <ShellNav
            label={labels.navigation}
            open={open}
            nav={nav}
            account={account}
            close={() => setOpen(false)}
          />
        ) : null}
        <main id="main" className={styles.main} inert={open}>
          <div className={narrow ? `${styles.content} ${styles.narrow}` : styles.content}>
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

/**
 * The navigation column: the page's navigation, and on a phone the account links under it. A tap on any link in it
 * calls `close`, since a link to the open page leaves the address as it is and so would leave the sheet open. The
 * column scrolls on its own when its links outgrow the screen; the open page's link is brought into view when the page
 * changes and when the phone's sheet opens, so a long list never hides where the person is.
 */
function ShellNav({
  label,
  open,
  nav,
  account,
  close,
}: Readonly<{
  label: string;
  open: boolean;
  nav: ReactNode;
  account: ReactNode;
  close: () => void;
}>) {
  const look = [open ? styles.sideOpen : styles.side, nav === null ? styles.accountOnly : ""];
  const column = useRef<HTMLElement>(null);
  const pathname = usePathname();
  useEffect(() => {
    column.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest" });
  }, [open, pathname]);
  const closeOnLink = (tapped: MouseEvent<HTMLElement>) => {
    if (tapped.target instanceof Element && tapped.target.closest("a") !== null) {
      close();
    }
  };
  return (
    <nav
      ref={column}
      id="shell-navigation"
      aria-label={label}
      className={look.join(" ")}
      onClick={closeOnLink}
    >
      {nav}
      {account === null ? null : <div className={styles.phoneOnly}>{account}</div>}
    </nav>
  );
}
