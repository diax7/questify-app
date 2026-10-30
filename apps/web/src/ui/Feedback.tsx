import type { ReactNode } from "react";
import styles from "#src/ui/surface.module.css";

type Tone = "neutral" | "info" | "success" | "warning" | "danger";

const BADGE: Record<Tone, string> = {
  neutral: styles.badge,
  info: `${styles.badge} ${styles.badgeInfo}`,
  success: `${styles.badge} ${styles.badgeSuccess}`,
  warning: `${styles.badge} ${styles.badgeWarning}`,
  danger: `${styles.badge} ${styles.badgeDanger}`,
};

/** A short state word: Draft, Live, Owner. */
export function Badge({
  tone = "neutral",
  children,
  ...rest
}: Readonly<{ tone?: Tone; children: ReactNode }>) {
  return (
    <span className={BADGE[tone]} {...rest}>
      {children}
    </span>
  );
}

const NOTICE: Record<Exclude<Tone, "neutral">, string> = {
  info: `${styles.notice} ${styles.noticeInfo}`,
  success: `${styles.notice} ${styles.noticeSuccess}`,
  warning: `${styles.notice} ${styles.noticeWarning}`,
  danger: `${styles.notice} ${styles.noticeDanger}`,
};

/**
 * A message in the flow of the page. A refusal is `danger` with `role="alert"`; a saved change is `success` with
 * `role="status"`; the role is the caller's, since only the caller knows whether it is news.
 */
export function Notice({
  tone = "info",
  role,
  id,
  as: Tag = "p",
  labelledBy,
  children,
  ...rest
}: Readonly<{
  tone?: Exclude<Tone, "neutral">;
  role?: "alert" | "status" | "note";
  id?: string;
  /** `div` for a notice with a list or a heading inside. */
  as?: "p" | "div";
  labelledBy?: string;
  children: ReactNode;
}>) {
  return (
    <Tag className={NOTICE[tone]} role={role} id={id} aria-labelledby={labelledBy} {...rest}>
      {children}
    </Tag>
  );
}

/**
 * A bar showing how far something has come, from the start of the reading direction. With `reading` it is a named
 * progress bar for a screen reader; without, it only draws a share (a preview) and is hidden from one.
 */
export function Meter({
  share,
  reading,
}: Readonly<{
  /** 0 to 1. */
  share: number;
  reading?: Readonly<{ label: string; now: number; max: number; text: string }>;
}>) {
  const props =
    reading === undefined
      ? { "aria-hidden": true as const }
      : {
          role: "progressbar" as const,
          "aria-label": reading.label,
          "aria-valuemin": 0,
          "aria-valuemax": reading.max,
          "aria-valuenow": reading.now,
          "aria-valuetext": reading.text,
        };
  return (
    <div className={styles.meter} {...props}>
      <div className={styles.meterFill} style={{ inlineSize: `${Math.round(share * 100)}%` }} />
    </div>
  );
}

/** What a list shows while it has nothing yet, with the action that fills it. */
export function EmptyState({
  children,
  action,
}: Readonly<{ children: ReactNode; action?: ReactNode }>) {
  return (
    <div className={styles.empty}>
      <p>{children}</p>
      {action}
    </div>
  );
}

/** Secondary text: a hint, a date, a count. */
export function Muted({
  as: Tag = "p",
  id,
  role,
  dir,
  children,
  ...rest
}: Readonly<{
  as?: "p" | "span";
  id?: string;
  role?: "status";
  dir?: "ltr" | "rtl" | "auto";
  children: ReactNode;
}>) {
  return (
    <Tag className={styles.muted} id={id} role={role} dir={dir} {...rest}>
      {children}
    </Tag>
  );
}

/** Text only a screen reader reads. */
export function ScreenReaderOnly({ children }: Readonly<{ children: ReactNode }>) {
  return <span className={styles.srOnly}>{children}</span>;
}
