import type { ReactNode } from "react";
import styles from "#src/ui/shell.module.css";

/** A labelled group of navigation links. */
export function NavGroup({ label, children }: Readonly<{ label: ReactNode; children: ReactNode }>) {
  return (
    <div className={styles.group}>
      <p className={styles.groupLabel}>{label}</p>
      {children}
    </div>
  );
}

/** One navigation link; `current` marks the open page. */
export function NavItem({
  href,
  current,
  children,
}: Readonly<{ href: string; current: boolean; children: ReactNode }>) {
  return (
    <a
      className={styles.item}
      href={href}
      {...(current ? { "aria-current": "page" as const } : {})}
    >
      {children}
    </a>
  );
}
