import type { ReactNode } from "react";
import { AppLink } from "#src/ui/AppLink.tsx";
import { Icon, type IconName } from "#src/ui/Icon.tsx";
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

/** One navigation link with its icon; `current` marks the open page. */
export function NavItem({
  href,
  icon,
  current,
  children,
}: Readonly<{ href: string; icon: IconName; current: boolean; children: ReactNode }>) {
  return (
    <AppLink
      className={styles.item}
      href={href}
      {...(current ? { "aria-current": "page" as const } : {})}
    >
      <Icon name={icon} />
      {children}
    </AppLink>
  );
}
