import { MESSAGES } from "@questify/shared";
import styles from "#src/components/layout.module.css";

/**
 * An unknown, draft or archived event's page (FR-103). A segment's not-found gets no params, so it cannot know the
 * page's language: it says it in both, each block in its own language and direction.
 */
export default function EventNotFound() {
  const text = MESSAGES["eventPage.notAvailable"];
  return (
    <main className={styles.page}>
      <article className={styles.panel}>
        <h1 className={styles.title}>
          <span lang="ar" dir="rtl">
            {text.ar}
          </span>
          <br />
          <span lang="en" dir="ltr">
            {text.en}
          </span>
        </h1>
      </article>
    </main>
  );
}
