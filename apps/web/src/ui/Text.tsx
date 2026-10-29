import type { AnchorHTMLAttributes } from "react";
import styles from "#src/ui/surface.module.css";

/** A link in running text or a list; `strong` for the name that opens an item (an event in the list). */
export function TextLink({
  strong = false,
  className,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & Readonly<{ strong?: boolean }>) {
  return (
    <a
      {...props}
      className={[styles.link, strong ? styles.linkStrong : "", className]
        .filter(Boolean)
        .join(" ")}
    />
  );
}
