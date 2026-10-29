"use client";

import { useState, type ReactNode } from "react";
import styles from "#src/ui/shell.module.css";

type Props = Readonly<{
  brand: ReactNode;
  /** Always in the top bar: the language switch. */
  topEnd: ReactNode;
  /** The signed-in person's links (home, account, sign out): in the top bar on a desktop, in the menu on a phone. */
  account: ReactNode;
  nav: ReactNode;
  labels: Readonly<{ menu: string; navigation: string; skip: string }>;
  narrow: boolean;
  children: ReactNode;
}>;

/**
 * The parts of the shell that move: on a phone the navigation and the account links open from the Menu button as a
 * sheet under the top bar (Escape closes it); on a desktop they are always shown.
 */
export function ShellFrame({ brand, topEnd, account, nav, labels, narrow, children }: Props) {
  const [open, setOpen] = useState(false);
  const hasMenu = nav !== null || account !== null;
  return (
    <div className={styles.shell}>
      <a className={styles.skip} href="#main">
        {labels.skip}
      </a>
      <header className={styles.top}>
        {hasMenu ? (
          <button
            type="button"
            className={styles.menuButton}
            aria-expanded={open}
            aria-controls="shell-navigation"
            onClick={() => setOpen((now) => !now)}
          >
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
            close={() => setOpen(false)}
            nav={nav}
            account={account}
          />
        ) : null}
        <main id="main" className={styles.main}>
          <div className={narrow ? `${styles.content} ${styles.narrow}` : styles.content}>
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

/** The navigation column: the page's navigation, and on a phone the account links under it. */
function ShellNav({
  label,
  open,
  close,
  nav,
  account,
}: Readonly<{
  label: string;
  open: boolean;
  close: () => void;
  nav: ReactNode;
  account: ReactNode;
}>) {
  const look = [open ? styles.sideOpen : styles.side, nav === null ? styles.accountOnly : ""];
  return (
    <nav
      id="shell-navigation"
      aria-label={label}
      className={look.join(" ")}
      onKeyDown={(pressed) => {
        if (pressed.key === "Escape") {
          close();
        }
      }}
    >
      {nav}
      {account === null ? null : <div className={styles.phoneOnly}>{account}</div>}
    </nav>
  );
}
