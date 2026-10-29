import type { ReactNode } from "react";
import styles from "#src/ui/surface.module.css";

/**
 * A data table that scrolls sideways inside its own box on a phone, so the page itself never does. The box is
 * focusable and named, so a keyboard can scroll it. Children are the table's `thead` and `tbody`.
 */
export function Table({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <div className={styles.tableBox} role="region" aria-label={label} tabIndex={0}>
      <table className={styles.table}>{children}</table>
    </div>
  );
}
