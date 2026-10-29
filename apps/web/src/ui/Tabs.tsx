import type { ReactNode } from "react";
import styles from "#src/ui/surface.module.css";

export type TabItem = Readonly<{
  key: string;
  label: ReactNode;
  current: boolean;
  /** A tab that opens a page; otherwise `select` switches the view in place. */
  href?: string;
  select?: () => void;
}>;

/**
 * A row of tabs that scrolls sideways on a phone. Link tabs mark the open page with `aria-current`; button tabs mark
 * the shown view with `aria-pressed`, since the panels stay ordinary page content.
 */
export function Tabs({ label, items }: Readonly<{ label: string; items: readonly TabItem[] }>) {
  return (
    <nav className={styles.tabs} aria-label={label}>
      {items.map((item) =>
        item.href === undefined ? (
          <button
            key={item.key}
            type="button"
            className={styles.tab}
            aria-pressed={item.current}
            onClick={item.select}
          >
            {item.label}
          </button>
        ) : (
          <a
            key={item.key}
            className={styles.tab}
            href={item.href}
            {...(item.current ? { "aria-current": "page" as const } : {})}
          >
            {item.label}
          </a>
        ),
      )}
    </nav>
  );
}
