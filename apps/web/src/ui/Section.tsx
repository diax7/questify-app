import { useId, type ReactNode, type Ref } from "react";
import { nameInfo } from "#src/ui/name-info.ts";
import { sectionLook, type SectionLook } from "#src/ui/section-look.ts";
import styles from "#src/ui/surface.module.css";

function sectionClass(tone: "danger" | undefined): string {
  return tone === "danger" ? `${styles.section} ${styles.sectionDanger}` : styles.section;
}

/**
 * One titled part of a page, as a landmark named by its heading. `actions` sit beside the title; `tone="danger"`
 * marks the part that deletes or ends things. `look` sets the title's size apart from its heading `level`. `as="article"`
 * is for a card repeated per record: named by its heading but not a landmark, so same-named cards stay legal.
 */
export function Section({
  as: Tag = "section",
  title,
  titleId,
  level = 2,
  look,
  description,
  info,
  actions,
  tone,
  children,
}: Readonly<{
  as?: "section" | "article";
  title: ReactNode;
  titleId?: string;
  level?: 2 | 3;
  /** The title's look, `section` or `sub`; defaults from the level, so a card under a part's `h2` can keep the small one. */
  look?: SectionLook;
  description?: ReactNode;
  /** An `InfoTip` beside the title, for a part that truly needs explaining (ADR-370). */
  info?: ReactNode;
  actions?: ReactNode;
  tone?: "danger";
  children?: ReactNode;
}>) {
  const ownId = useId();
  const id = titleId ?? ownId;
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <Tag className={sectionClass(tone)} aria-labelledby={id}>
      <div className={styles.sectionHeader}>
        <div className={styles.sectionText}>
          <div className={styles.titleRow}>
            <Heading
              id={id}
              className={
                sectionLook(level, look) === "section" ? styles.sectionTitle : styles.subTitle
              }
            >
              {title}
            </Heading>
            {nameInfo(info, title)}
          </div>
          {description === undefined ? null : <p className={styles.muted}>{description}</p>}
        </div>
        {actions === undefined ? null : <div className={styles.toolbar}>{actions}</div>}
      </div>
      {children}
    </Tag>
  );
}

/** A heading inside a section, for a group of its content; `as` keeps the outline's level where it must. */
export function SubHeading({
  as: Tag = "h3",
  id,
  ref,
  tabIndex,
  children,
}: Readonly<{
  as?: "h2" | "h3" | "h4";
  id?: string;
  /** For a heading that takes focus after a change (with `tabIndex={-1}`). */
  ref?: Ref<HTMLHeadingElement>;
  tabIndex?: number;
  children: ReactNode;
}>) {
  return (
    <Tag id={id} ref={ref} tabIndex={tabIndex} className={styles.subTitle}>
      {children}
    </Tag>
  );
}

/** A plain box: one item in a list, or a small group inside a section. */
export function Card({
  as: Tag = "div",
  children,
  ...rest
}: Readonly<{
  as?: "div" | "li" | "article" | "section";
  children: ReactNode;
  "aria-labelledby"?: string;
  "aria-label"?: string;
  /** For a card holding text in the other language than the page's (a preview of an Arabic message). */
  dir?: "ltr" | "rtl";
  lang?: string;
}>) {
  return (
    <Tag className={styles.card} {...rest}>
      {children}
    </Tag>
  );
}

/** Content in a column with the page's standard gap; `as="section"` with a name makes it a page region. */
export function Stack({
  as: Tag = "div",
  children,
  ...aria
}: Readonly<{
  as?: "div" | "section";
  children: ReactNode;
  "aria-labelledby"?: string;
  "aria-label"?: string;
}>) {
  return (
    <Tag className={styles.stack} {...aria}>
      {children}
    </Tag>
  );
}

/** Short notes in a bulleted list: the evidence of a case, the lines of a summary. Muted, so the heading leads. */
export function BulletList({ children }: Readonly<{ children: ReactNode }>) {
  return <ul className={styles.bullets}>{children}</ul>;
}

/** Name and value pairs (what a player answered, a ticket's facts): `dt` and `dd` children in two columns. */
export function FactList({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <dl className={styles.facts} aria-label={label}>
      {children}
    </dl>
  );
}

/** A list of cards with a small gap. */
export function CardList({ children }: Readonly<{ children: ReactNode }>) {
  return <ul className={styles.list}>{children}</ul>;
}

/** Rows divided by lines: settings, members, items. Children are `Row`s. */
export function Rows({
  as: Tag = "ul",
  children,
}: Readonly<{ as?: "ul" | "div"; children: ReactNode }>) {
  return <Tag className={styles.rows}>{children}</Tag>;
}

/** One row: what it is on the start side, its controls on the end side, wrapping under it on a phone. */
export function Row({
  as: Tag = "li",
  main,
  children,
  ...aria
}: Readonly<{
  as?: "li" | "div" | "section";
  main: ReactNode;
  children?: ReactNode;
  "aria-labelledby"?: string;
}>) {
  return (
    <Tag className={styles.row} {...aria}>
      <div className={styles.rowMain}>{main}</div>
      {children === undefined || children === null ? null : (
        <div className={styles.toolbar}>{children}</div>
      )}
    </Tag>
  );
}

/** A row of buttons or links. `align="end"` for a form's submit, `between` for a back and a next. */
export function Toolbar({
  align = "start",
  label,
  children,
}: Readonly<{ align?: "start" | "end" | "between"; label?: string; children: ReactNode }>) {
  const alignment = { start: "", end: styles.toolbarEnd, between: styles.toolbarBetween }[align];
  return (
    <div
      className={`${styles.toolbar} ${alignment}`}
      {...(label === undefined ? {} : { role: "group", "aria-label": label })}
    >
      {children}
    </div>
  );
}
