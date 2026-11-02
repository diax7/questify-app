"use client";

import {
  formatNumber,
  type Language,
  type ReadinessCounts as Counts,
  type ReadinessItem,
  type ReadinessStatus,
} from "@questify/shared";
import styles from "#src/components/readiness.module.css";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { STATUS_ICON, itemLine, itemTitle, readinessHref } from "#src/lib/readiness.ts";
import { Badge, ScreenReaderOnly } from "#src/ui/Feedback.tsx";
import { Icon } from "#src/ui/Icon.tsx";
import { Row, Rows } from "#src/ui/Section.tsx";
import { TextLink } from "#src/ui/Text.tsx";

const STATUSES: readonly ReadinessStatus[] = ["blocking", "warning", "done"];
const TONE = { done: "success", warning: "warning", blocking: "danger" } as const;

/** The mark of a status: its icon in the status colour. The word beside it says the same, so colour is never alone. */
export function StatusMark({ status }: Readonly<{ status: ReadinessStatus }>) {
  return (
    <span className={`${styles.mark} ${styles[status]}`}>
      <Icon name={STATUS_ICON[status]} />
    </span>
  );
}

/**
 * How many items are needed, to check and ready, as a row of three marks with their numbers. A line, not boxes: the page
 * keeps no box inside another, and the console's event cards hold the same row.
 */
export function ReadinessCounts({
  language,
  counts,
}: Readonly<{ language: Language; counts: Counts }>) {
  const t = useTranslator(language);
  return (
    <ul className={styles.counts} data-testid="readiness-counts">
      {STATUSES.map((status) => (
        <li key={status} className={styles.count} data-testid={`readiness-count-${status}`}>
          <StatusMark status={status} />
          <span>
            {t(`readiness.count.${status}`)}: {formatNumber(counts[status], language)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * One item: its mark, its title and what it reads now. The status word is read aloud only, unless `showStatus` puts it
 * beside the title (the console's cards have no other place that says it).
 */
export function ReadinessText({
  language,
  item,
  showStatus = false,
}: Readonly<{ language: Language; item: ReadinessItem; showStatus?: boolean }>) {
  const t = useTranslator(language);
  const status = t(`readiness.status.${item.status}`);
  return (
    <div
      className={styles.item}
      data-testid="readiness-item"
      data-key={item.key}
      data-status={item.status}
    >
      <StatusMark status={item.status} />
      <div className={styles.text}>
        {showStatus ? (
          <span className={styles.head}>
            <strong>{itemTitle(t, item)}</strong>
            <Badge tone={TONE[item.status]}>{status}</Badge>
          </span>
        ) : (
          <>
            <ScreenReaderOnly>{status}</ScreenReaderOnly>
            <strong>{itemTitle(t, item)}</strong>
          </>
        )}
        <span>{itemLine(t, item, language)}</span>
      </div>
    </div>
  );
}

/** The owner's list: every item with its status word and a link to the page that fixes it (Open once it is done). */
export function ReadinessItems({
  language,
  items,
  eventBase,
}: Readonly<{ language: Language; items: readonly ReadinessItem[]; eventBase: string }>) {
  const t = useTranslator(language);
  return (
    <Rows>
      {items.map((item) => {
        const done = item.status === "done";
        return (
          <Row key={item.key} main={<ReadinessText language={language} item={item} />}>
            <Badge tone={TONE[item.status]} aria-hidden="true">
              {t(`readiness.status.${item.status}`)}
            </Badge>
            <TextLink
              href={readinessHref(eventBase, item.key)}
              aria-label={t(done ? "readiness.openItem" : "readiness.fixItem", {
                item: itemTitle(t, item),
              })}
            >
              {t(done ? "readiness.open" : "readiness.fix")}
            </TextLink>
          </Row>
        );
      })}
    </Rows>
  );
}
