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
 * the shown view with `aria-pressed`, since the panels stay ordinary page content. With `tablist` the row is a real
 * tab list (`role="tablist"`, `role="tab"` and `aria-selected`) for tabs that filter one list.
 */
export function Tabs({
  label,
  items,
  tablist = false,
}: Readonly<{ label: string; items: readonly TabItem[]; tablist?: boolean }>) {
  const Container = tablist ? "div" : "nav";
  return (
    <Container className={styles.tabs} aria-label={label} {...(tablist ? { role: "tablist" } : {})}>
      {items.map((item) =>
        item.href === undefined ? (
          <button
            key={item.key}
            type="button"
            className={styles.tab}
            onClick={item.select}
            {...(tablist
              ? { role: "tab", "aria-selected": item.current }
              : { "aria-pressed": item.current })}
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
    </Container>
  );
}
