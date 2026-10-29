"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import styles from "#src/ui/surface.module.css";

/** Makes the dialog's siblings inert while it is mounted and returns focus to the element that opened it. */
function useModalAround<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement;
    const made: Element[] = [];
    for (const sibling of Array.from(dialog?.parentElement?.children ?? [])) {
      if (sibling !== dialog && !sibling.hasAttribute("inert")) {
        sibling.setAttribute("inert", "");
        made.push(sibling);
      }
    }
    return () => {
      for (const sibling of made) {
        sibling.removeAttribute("inert");
      }
      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus();
      }
    };
  }, []);
  return ref;
}

/**
 * A modal sheet over the page: a heading that takes focus when it opens, its content, then its buttons (Cancel first,
 * the action last). Escape cancels unless `busy`. Everything beside it is inert while it is open, and focus goes back
 * to the control that opened it when it closes.
 */
export function Dialog({
  title,
  titleId,
  describedById,
  role = "alertdialog",
  cancel,
  busy = false,
  actions,
  children,
}: Readonly<{
  title: ReactNode;
  titleId?: string;
  /** The id of the sentence that says what happens, read with the title. */
  describedById?: string;
  role?: "dialog" | "alertdialog";
  cancel: () => void;
  busy?: boolean;
  actions: ReactNode;
  children?: ReactNode;
}>) {
  const ownId = useId();
  const id = titleId ?? ownId;
  const scrim = useModalAround<HTMLDivElement>();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.scrollIntoView({ block: "nearest" });
    heading.current?.focus();
  }, []);
  return (
    <div ref={scrim} className={styles.scrim}>
      <div
        role={role}
        aria-modal="true"
        aria-labelledby={id}
        aria-describedby={describedById}
        className={styles.dialog}
        onKeyDown={(pressed) => {
          if (pressed.key === "Escape" && !busy) {
            cancel();
          }
        }}
      >
        <h2 id={id} ref={heading} tabIndex={-1} className={styles.sectionTitle}>
          {title}
        </h2>
        {children}
        <div className={`${styles.toolbar} ${styles.toolbarEnd}`}>{actions}</div>
      </div>
    </div>
  );
}
