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
import { Button } from "#src/ui/Button.tsx";
import { Badge, EmptyState, Muted } from "#src/ui/Feedback.tsx";
import { Field, FieldGroup, Input, Textarea } from "#src/ui/Field.tsx";
import { Card, CardList, Section, SubHeading, Toolbar } from "#src/ui/Section.tsx";

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
    <FieldGroup layout="columns">
      {ANNOUNCEMENT_FIELDS.map((field) => {
        const title = field.startsWith("title");
        const max = title ? ANNOUNCEMENT_TITLE_MAX : ANNOUNCEMENT_BODY_MAX;
        const props = {
          value: draft[field],
          disabled,
          dir: field.endsWith("Ar") ? ("rtl" as const) : ("ltr" as const),
          lang: field.endsWith("Ar") ? "ar" : "en",
          required: true,
          onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            change({ ...draft, [field]: event.target.value }),
        };
        return (
          <Field
            key={field}
            id={field}
            label={t(`announcements.page.${field}`)}
            help={t("announcements.page.counter", {
              count: formatNumber(Array.from(draft[field]).length, language),
              max,
            })}
          >
            {title ? <Input {...props} /> : <Textarea {...props} rows={4} />}
          </Field>
        );
      })}
    </FieldGroup>
  );
}

export function AnnouncementPreview({
  language,
  draft,
}: Readonly<{ language: Language; draft: AnnouncementBody }>) {
  const t = useTranslator(language);
  const checked = checkAnnouncement(draft);
  return (
    <Card as="section" aria-label={t("announcements.page.preview")}>
      <SubHeading as="h2">{t("announcements.page.preview")}</SubHeading>
      {checked.ok
        ? (["ar", "en"] as const).map((lang) => (
            <Card dir={lang === "ar" ? "rtl" : "ltr"} lang={lang} key={lang}>
              <SubHeading>
                {t(lang === "ar" ? "announcements.page.previewAr" : "announcements.page.previewEn")}
              </SubHeading>
              <strong>{lang === "ar" ? checked.draft.titleAr : checked.draft.titleEn}</strong>
              <p>{lang === "ar" ? checked.draft.pushBodyAr : checked.draft.pushBodyEn}</p>
            </Card>
          ))
        : null}
    </Card>
  );
}

function AnnouncementDelivery({
  row,
  language,
}: Readonly<{ row: AnnouncementView; language: Language }>) {
  const t = useTranslator(language);
  if (row.delivering) return <Muted>{t("announcements.page.delivering")}</Muted>;
  if (row.delivered === null) return null;
  return (
    <Muted>
      {t("announcements.page.delivered", { count: formatNumber(row.delivered, language) })}
    </Muted>
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
    <Card as="li">
      <SubHeading>
        <span dir="auto">{language === "ar" ? row.titleAr : row.titleEn}</span>
      </SubHeading>
      <p dir="auto">{language === "ar" ? row.bodyAr : row.bodyEn}</p>
      <Toolbar>
        <Badge>{t(`announcements.page.status.${row.status}`)}</Badge>
        {row.rehearsal ? <Badge tone="info">{t("announcements.page.rehearsal")}</Badge> : null}
        <Muted as="span">
          {t(
            row.sentAt === null ? "announcements.page.scheduledFor" : "announcements.page.sentAt",
            { time: at },
          )}
        </Muted>
      </Toolbar>
      <AnnouncementDelivery row={row} language={language} />
      {row.skipReason === null ? null : <Muted>{t(reasonKeys[row.skipReason])}</Muted>}
      {row.status === "scheduled" ? (
        <Toolbar>
          <Button variant="quiet" disabled={busy} onClick={cancel}>
            {t("announcements.page.cancel")}
          </Button>
        </Toolbar>
      ) : null}
    </Card>
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
      <Toolbar>
        <Button size="sm" disabled={!previous || busy} onClick={() => page(false)}>
          {t("announcements.page.previous")}
        </Button>
        <Button size="sm" disabled={!next || busy} onClick={() => page(true)}>
          {t("announcements.page.next")}
        </Button>
      </Toolbar>
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
    <Section title={t(pending ? "announcements.page.pending" : "announcements.page.history")}>
      {rows.length === 0 ? (
        <EmptyState>
          {t(pending ? "announcements.page.pendingEmpty" : "announcements.page.empty")}
        </EmptyState>
      ) : (
        <CardList>
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
        </CardList>
      )}
    </Section>
  );
}
