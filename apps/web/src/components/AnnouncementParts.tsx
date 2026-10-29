"use client";

import {
  ANNOUNCEMENT_FIELDS,
  ANNOUNCEMENT_TITLE_MAX,
  ANNOUNCEMENT_BODY_MAX,
  checkAnnouncement,
  formatEventTime,
  formatNumber,
  type AnnouncementBody,
  type AnnouncementView,
  type Language,
} from "@questify/shared";
import { useTranslator } from "#src/components/TermsScope.tsx";
import styles from "#src/components/layout.module.css";

export function AnnouncementFields({
  language,
  draft,
  disabled,
  change,
}: Readonly<{
  language: Language;
  draft: AnnouncementBody;
  disabled: boolean;
  change: (draft: AnnouncementBody) => void;
}>) {
  const t = useTranslator(language);
  return (
    <>
      {ANNOUNCEMENT_FIELDS.map((field) => {
        const title = field.startsWith("title");
        const max = title ? ANNOUNCEMENT_TITLE_MAX : ANNOUNCEMENT_BODY_MAX;
        const props = {
          id: field,
          value: draft[field],
          disabled,
          dir: field.endsWith("Ar") ? ("rtl" as const) : ("ltr" as const),
          lang: field.endsWith("Ar") ? "ar" : "en",
          required: true,
          onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            change({ ...draft, [field]: event.target.value }),
        };
        return (
          <label className={styles.field} key={field} htmlFor={field}>
            {t(`announcements.page.${field}`)}
            {title ? <input {...props} /> : <textarea {...props} rows={4} />}
            <span>
              {t("announcements.page.counter", {
                count: formatNumber(Array.from(draft[field]).length, language),
                max,
              })}
            </span>
          </label>
        );
      })}
    </>
  );
}

export function AnnouncementPreview({
  language,
  draft,
}: Readonly<{ language: Language; draft: AnnouncementBody }>) {
  const t = useTranslator(language);
  const checked = checkAnnouncement(draft);
  return (
    <section aria-label={t("announcements.page.preview")}>
      <h2>{t("announcements.page.preview")}</h2>
      <p>{t("announcements.page.previewNote", { max: 140 })}</p>
      {checked.ok
        ? (["ar", "en"] as const).map((lang) => (
            <div
              className={styles.formCard}
              dir={lang === "ar" ? "rtl" : "ltr"}
              lang={lang}
              key={lang}
            >
              <h3>
                {t(lang === "ar" ? "announcements.page.previewAr" : "announcements.page.previewEn")}
              </h3>
              <strong>{lang === "ar" ? checked.draft.titleAr : checked.draft.titleEn}</strong>
              <p>{lang === "ar" ? checked.draft.pushBodyAr : checked.draft.pushBodyEn}</p>
            </div>
          ))
        : null}
    </section>
  );
}

function AnnouncementDelivery({
  row,
  language,
}: Readonly<{ row: AnnouncementView; language: Language }>) {
  const t = useTranslator(language);
  if (row.delivering) return <p>{t("announcements.page.delivering")}</p>;
  if (row.delivered === null) return null;
  return (
    <p>{t("announcements.page.delivered", { count: formatNumber(row.delivered, language) })}</p>
  );
}

function AnnouncementCard({
  row,
  language,
  zone,
  busy,
  cancel,
}: Readonly<{
  row: AnnouncementView;
  language: Language;
  zone: string;
  busy: boolean;
  cancel: () => void;
}>) {
  const t = useTranslator(language);
  const reasonKeys = {
    event_closed: "announcements.page.skip.eventClosed",
    not_live: "announcements.page.skip.notLive",
    late: "announcements.page.skip.late",
  } as const;
  const at = formatEventTime(new Date(row.sentAt ?? row.sendAt), zone, language);
  return (
    <li className={styles.formCard}>
      <h3 dir="auto">{language === "ar" ? row.titleAr : row.titleEn}</h3>
      <p dir="auto">{language === "ar" ? row.bodyAr : row.bodyEn}</p>
      <p>
        {t(`announcements.page.status.${row.status}`)}{" "}
        {row.rehearsal ? t("announcements.page.rehearsal") : ""}
      </p>
      <p>
        {t(row.sentAt === null ? "announcements.page.scheduledFor" : "announcements.page.sentAt", {
          time: at,
        })}
      </p>
      <AnnouncementDelivery row={row} language={language} />
      {row.skipReason === null ? null : <p>{t(reasonKeys[row.skipReason])}</p>}
      {row.status === "scheduled" ? (
        <button className={styles.quiet} type="button" disabled={busy} onClick={cancel}>
          {t("announcements.page.cancel")}
        </button>
      ) : null}
    </li>
  );
}

export function AnnouncementPagination({
  language,
  previous,
  next,
  busy,
  page,
}: Readonly<{
  language: Language;
  previous: boolean;
  next: boolean;
  busy: boolean;
  page: (next: boolean) => void;
}>) {
  const t = useTranslator(language);
  return (
    <nav aria-label={t("announcements.page.pagination")}>
      <button type="button" disabled={!previous || busy} onClick={() => page(false)}>
        {t("announcements.page.previous")}
      </button>
      <button type="button" disabled={!next || busy} onClick={() => page(true)}>
        {t("announcements.page.next")}
      </button>
    </nav>
  );
}

export function AnnouncementList({
  pending = false,
  language,
  rows,
  zone,
  busy,
  cancel,
}: Readonly<{
  pending?: boolean;
  language: Language;
  rows: readonly AnnouncementView[];
  zone: string;
  busy: boolean;
  cancel: (row: AnnouncementView) => void;
}>) {
  const t = useTranslator(language);
  return (
    <section>
      <h2>{t(pending ? "announcements.page.pending" : "announcements.page.history")}</h2>
      {rows.length === 0 ? (
        <p>{t(pending ? "announcements.page.pendingEmpty" : "announcements.page.empty")}</p>
      ) : (
        <ul>
          {rows.map((row) => (
            <AnnouncementCard
              key={row.id}
              row={row}
              language={language}
              zone={zone}
              busy={busy}
              cancel={() => cancel(row)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
