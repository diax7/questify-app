import { ScreenReaderOnly } from "#src/ui/Feedback.tsx";
import styles from "#src/ui/skeleton.module.css";

/**
 * What a page shows while its data is on the way (T-599c): the shape of a page, a title and two panels, pulsing in the
 * page's colours. It goes inside a shell that stays, so only the content area changes. `label` is what a screen reader
 * hears ("Loading…").
 */
export function PageSkeleton({ label }: Readonly<{ label: string }>) {
  return (
    <div role="status" className={styles.page}>
      <ScreenReaderOnly>{label}</ScreenReaderOnly>
      <div className={styles.title} aria-hidden="true" />
      <div className={styles.panel} aria-hidden="true" />
      <div className={styles.panel} aria-hidden="true" />
    </div>
  );
}
