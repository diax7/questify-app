import type { AnchorHTMLAttributes, ReactNode } from "react";
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

/** Text an organizer typed, shown as written: its line breaks kept, long words broken, never read as markup. */
export function Prose({
  dir,
  lang,
  children,
  ...rest
}: Readonly<{ dir?: "ltr" | "rtl" | "auto"; lang?: string; children: ReactNode }>) {
  return (
    <p className={styles.prose} dir={dir} lang={lang} {...rest}>
      {children}
    </p>
  );
}

/** A short code shown large and spaced out so it can be read aloud or typed: an event's join code. */
export function CodeText({
  dir,
  children,
}: Readonly<{ dir?: "ltr" | "rtl"; children: ReactNode }>) {
  return (
    <p className={styles.code} dir={dir}>
      {children}
    </p>
  );
}
