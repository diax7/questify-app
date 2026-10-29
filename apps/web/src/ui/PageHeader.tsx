import type { ReactNode, Ref } from "react";
import styles from "#src/ui/surface.module.css";

type HeaderProps = Readonly<{
  title: ReactNode;
  titleId?: string;
  titleRef?: Ref<HTMLHeadingElement>;
  focusable?: boolean;
  back?: Readonly<{ href: string; label: string }>;
  description?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}>;

/**
 * The top of a page: an optional way back, the one `h1`, a line of facts (status, codes) and the page's main actions.
 * `titleRef` or `focusable` lets a page move focus to the heading after a change (it then takes `tabIndex={-1}`).
 */
export function PageHeader({ actions, ...text }: HeaderProps) {
  return (
    <header className={styles.header}>
      <HeaderText {...text} />
      {actions === undefined ? null : <div className={styles.toolbar}>{actions}</div>}
    </header>
  );
}

function HeaderText({
  title,
  titleId,
  titleRef,
  focusable = false,
  back,
  description,
  meta,
}: Omit<HeaderProps, "actions">) {
  return (
    <div className={styles.headerText}>
      {back === undefined ? null : (
        <a className={styles.back} href={back.href}>
          {back.label}
        </a>
      )}
      <h1
        id={titleId}
        className={styles.title}
        ref={titleRef}
        {...(titleRef === undefined && !focusable ? {} : { tabIndex: -1 })}
      >
        {title}
      </h1>
      {description === undefined ? null : <p className={styles.description}>{description}</p>}
      {meta === undefined ? null : <div className={styles.meta}>{meta}</div>}
    </div>
  );
}
