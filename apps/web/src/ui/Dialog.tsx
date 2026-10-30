"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import styles from "#src/ui/surface.module.css";

/**
 * A modal sheet over the page: a heading that takes focus when it opens, its content, then its buttons (Cancel first,
 * the action last). It is a native modal `<dialog>`, so the browser makes the rest of the page (top bar, navigation,
 * skip link) unreachable by keyboard, pointer and screen reader while it is open. Escape cancels unless `busy`, and
 * focus goes back to the control that opened it when it closes.
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
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement;
    if (element !== null && !element.open) {
      element.showModal();
    }
    heading.current?.focus();
    return () => {
      element?.close();
      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus();
      }
    };
  }, []);
  // Escape (and a phone's Back button) asks the browser to close the dialog; the page decides instead, so a busy
  // dialog stays open and a cancelled one is unmounted by its owner.
  const askToCancel = () => {
    if (!busy) {
      cancel();
    }
  };
  return (
    <dialog
      ref={dialog}
      role={role}
      aria-labelledby={id}
      aria-describedby={describedById}
      className={styles.dialog}
      onKeyDown={(pressed) => {
        if (pressed.key === "Escape") {
          pressed.preventDefault();
          askToCancel();
        }
      }}
      onCancel={(asked) => {
        asked.preventDefault();
        askToCancel();
      }}
    >
      <h2 id={id} ref={heading} tabIndex={-1} className={styles.sectionTitle}>
        {title}
      </h2>
      {children}
      <div className={`${styles.toolbar} ${styles.toolbarEnd}`}>{actions}</div>
    </dialog>
  );
}
