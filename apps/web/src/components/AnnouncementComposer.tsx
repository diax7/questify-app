"use client";

import {
  checkAnnouncement,
  formatEventTime,
  formatNumber,
  type AnnouncementBody,
  type Language,
} from "@questify/shared";
import { useState } from "react";
import { AnnouncementFields, AnnouncementPreview } from "#src/components/AnnouncementParts.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import type { AnnouncementConfirmation, Audience } from "#src/components/AnnouncementsPanel.tsx";
import {
  announcementIssueKey,
  announcementPayload,
  blankAnnouncement,
} from "#src/lib/announcements.ts";
import type { Translate } from "#src/lib/language.ts";
import { Button } from "#src/ui/Button.tsx";
import { Notice, Muted } from "#src/ui/Feedback.tsx";
import { Field, FieldGroup, Form, Input, Select } from "#src/ui/Field.tsx";
import { Section } from "#src/ui/Section.tsx";

type Props = Readonly<{
  language: Language;
  path: string;
  zone: string;
  audience: Audience;
  disabled: boolean;
  confirm: (press: AnnouncementConfirmation) => void;
}>;

function draftProblem(draft: AnnouncementBody, language: Language, t: Translate): string | null {
  const checked = checkAnnouncement(draft);
  if (checked.ok) return null;
  const max = checked.field.startsWith("title") ? 60 : 500;
  return t("announcements.page.invalid", {
    field: t(`announcements.page.${checked.field}`),
    issue: t(announcementIssueKey(checked.issue), { max: formatNumber(max, language) }),
  });
}

function audienceLine(
  audience: Audience,
  later: boolean,
  language: Language,
  t: Translate,
): string {
  if (later) return t("announcements.page.audienceLater");
  if (audience.phase === "rehearsal")
    return t("announcements.page.audienceRehearsal", {
      count: formatNumber(audience.members, language),
    });
  if (audience.members === 0) return t("announcements.page.audienceNone");
  return t("announcements.page.audienceLive", { count: formatNumber(audience.members, language) });
}

function confirmationOf(
  props: Props,
  body: AnnouncementBody,
  t: Translate,
): AnnouncementConfirmation {
  const later = body.sendAt != null;
  const count = formatNumber(props.audience.members, props.language);
  let text = t(
    props.audience.phase === "rehearsal"
      ? "announcements.page.confirmRehearsalBody"
      : "announcements.page.confirmNowBody",
    { count },
  );
  if (body.sendAt != null)
    text = t("announcements.page.confirmLaterBody", {
      time: formatEventTime(new Date(body.sendAt), props.zone, props.language),
    });
  return {
    path: props.path,
    body,
    text,
    title: t(later ? "announcements.page.confirmLaterTitle" : "announcements.page.confirmNowTitle"),
    label: t(later ? "announcements.page.schedule" : "announcements.page.send"),
    success: t(later ? "announcements.page.scheduled" : "announcements.page.sent"),
  };
}

function AnnouncementWhen({
  language,
  zone,
  later,
  local,
  disabled,
  changeLater,
  changeLocal,
}: Readonly<{
  language: Language;
  zone: string;
  later: boolean;
  local: string;
  disabled: boolean;
  changeLater: (later: boolean) => void;
  changeLocal: (local: string) => void;
}>) {
  const t = useTranslator(language);
  return (
    <FieldGroup layout="columns">
      <Field label={t("announcements.page.when")}>
        <Select
          disabled={disabled}
          value={later ? "later" : "now"}
          onChange={(event) => changeLater(event.target.value === "later")}
        >
          <option value="now">{t("announcements.page.now")}</option>
          <option value="later">{t("announcements.page.later")}</option>
        </Select>
      </Field>
      {later ? (
        <Field label={`${t("announcements.page.sendAt")} (${zone})`}>
          <Input
            type="datetime-local"
            required
            value={local}
            disabled={disabled}
            onChange={(event) => changeLocal(event.target.value)}
          />
        </Field>
      ) : null}
    </FieldGroup>
  );
}

export function AnnouncementComposer(props: Props) {
  const { language, audience, zone, disabled } = props;
  const t = useTranslator(language);
  const [draft, setDraft] = useState(blankAnnouncement);
  const [later, setLater] = useState(false);
  const [local, setLocal] = useState("");
  const payload = announcementPayload(draft, later, local, zone);
  const problem = draftProblem(draft, language, t);
  return (
    <Section title={t("announcements.page.new")}>
      <Form
        onSubmit={(event) => {
          event.preventDefault();
          if (payload !== null) props.confirm(confirmationOf(props, payload, t));
        }}
      >
        <AnnouncementFields
          language={language}
          draft={draft}
          disabled={disabled}
          change={setDraft}
        />
        {problem === null ? null : <Notice tone="warning">{problem}</Notice>}
        <AnnouncementWhen
          language={language}
          zone={zone}
          later={later}
          local={local}
          disabled={disabled}
          changeLater={setLater}
          changeLocal={setLocal}
        />
        <Muted>{audienceLine(audience, later, language, t)}</Muted>
        <AnnouncementPreview language={language} draft={draft} />
        <Button
          type="submit"
          variant="primary"
          disabled={disabled || payload === null || (!later && audience.members === 0)}
        >
          {t(later ? "announcements.page.schedule" : "announcements.page.send")}
        </Button>
      </Form>
    </Section>
  );
}
