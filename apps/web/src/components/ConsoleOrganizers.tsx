"use client";

import type { Language, MessageKey } from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { OrganizerFeaturesPanel } from "#src/components/ConsoleOrganizerFeatures.tsx";
import { SuspensionPanel } from "#src/components/ConsoleOversight.tsx";
import { OwnerEmailPanel } from "#src/components/ConsoleOwnerEmail.tsx";
import { nameIn } from "#src/lib/console.ts";
import {
  ORGANIZERS_API,
  clockOf,
  historyKeyOf,
  organizersPath,
  readOrganizerDetail,
  readOrganizerPage,
  type HistoryEntry,
  type OrganizerDetail,
  type OrganizerRow,
} from "#src/lib/console-organizers.ts";
import { translatorFor, type Translate } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem } from "#src/lib/sign-in-errors.ts";
import { Button } from "#src/ui/Button.tsx";
import { Badge, Muted, Notice } from "#src/ui/Feedback.tsx";
import { Field, Form, Input, Select } from "#src/ui/Field.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Row, Rows, Section, Stack, Toolbar } from "#src/ui/Section.tsx";
import { TextLink } from "#src/ui/Text.tsx";

const STATUSES = ["", "active", "paused"] as const;
const statusKey = (status: string): MessageKey =>
  status === "paused" ? "console.organizers.status.paused" : "console.organizers.status.active";

function OrganizerLine({ language, row }: Readonly<{ language: Language; row: OrganizerRow }>) {
  const t = translatorFor(language);
  return (
    <Row
      main={
        <Stack>
          <span>
            <TextLink href={`/${language}/console/organizers/${row.id}`} strong>
              <bdi>{row.name}</bdi>
            </TextLink>{" "}
            <Badge tone={row.status === "paused" ? "danger" : "neutral"}>
              {t(statusKey(row.status))}
            </Badge>
          </span>
          <Muted as="span">
            {t("console.organizers.counts", row.events)}
            {row.ownerEmail === null
              ? null
              : ` · ${t("console.organizers.owner", { email: row.ownerEmail })}`}
          </Muted>
        </Stack>
      }
    />
  );
}

/**
 * The console's organizers (T-701, wireframe 4.2): search by name, slug or the owner's full email, filter by status,
 * and open one. Every read is audited by the API with the organizer ids shown.
 */
export function ConsoleOrganizers({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const [query, setQuery] = useState({ q: "", status: "" });
  const [draft, setDraft] = useState({ q: "", status: "" });
  const [rows, setRows] = useState<OrganizerRow[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(
    async (cursor: string | null) => {
      const result = await requestJson("GET", organizersPath({ ...query, cursor }));
      const page = result.ok ? readOrganizerPage(result.body) : undefined;
      if (page === undefined) {
        setProblem(describeProblem(result.body, language, t).text);
        return;
      }
      setProblem(null);
      setRows((current) =>
        cursor === null ? page.organizers : [...(current ?? []), ...page.organizers],
      );
      setNext(page.nextCursor);
    },
    [query, language, t],
  );
  useEffect(() => {
    void load(null);
  }, [load]);

  return (
    <Stack as="section" aria-labelledby="console-organizers-title">
      <PageHeader
        title={t("console.organizers.title")}
        titleId="console-organizers-title"
        description={t("console.organizers.intro")}
      />
      <Form
        onSubmit={(submitted) => {
          submitted.preventDefault();
          setQuery(draft);
        }}
      >
        <Field label={t("console.organizers.search")}>
          <Input
            type="search"
            maxLength={254}
            value={draft.q}
            onChange={(changed) => setDraft({ ...draft, q: changed.target.value })}
          />
        </Field>
        <Field label={t("console.organizers.status")}>
          <Select
            value={draft.status}
            onChange={(changed) => setDraft({ ...draft, status: changed.target.value })}
          >
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {status === "" ? t("console.organizers.status.all") : t(statusKey(status))}
              </option>
            ))}
          </Select>
        </Field>
        <Toolbar>
          <Button type="submit" variant="primary">
            {t("console.organizers.find")}
          </Button>
        </Toolbar>
      </Form>
      {problem === null ? null : (
        <Notice tone="danger" role="alert">
          {problem}
        </Notice>
      )}
      {rows === null ? (
        <Muted>{t("common.loading")}</Muted>
      ) : rows.length === 0 ? (
        <Muted>{t("console.organizers.none")}</Muted>
      ) : (
        <Rows>
          {rows.map((row) => (
            <OrganizerLine key={row.id} language={language} row={row} />
          ))}
        </Rows>
      )}
      {next === null ? null : (
        <Button variant="quiet" onClick={() => void load(next)}>
          {t("console.organizers.more")}
        </Button>
      )}
    </Stack>
  );
}

/** An audit action in words when it has some, else its stored name (a code, so it reads left to right). */
function HistoryAction({ t, action }: Readonly<{ t: Translate; action: string }>) {
  const key = historyKeyOf(action);
  return key === undefined ? <bdi dir="ltr">{action}</bdi> : <>{t(key)}</>;
}

export function HistoryList({
  language,
  history,
}: Readonly<{ language: Language; history: readonly HistoryEntry[] }>) {
  const t = translatorFor(language);
  return (
    <Section title={t("console.organizer.history")} level={3}>
      {history.length === 0 ? (
        <Muted>{t("console.organizer.noHistory")}</Muted>
      ) : (
        <Rows>
          {history.map((entry) => (
            <Row
              key={entry.id}
              main={
                <span>
                  <HistoryAction t={t} action={entry.action} />{" "}
                  <Muted as="span">
                    {clockOf(entry.at, language)}
                    {entry.bySupport ? ` · ${t("console.organizer.bySupport")}` : ""}
                  </Muted>
                </span>
              }
            />
          ))}
        </Rows>
      )}
    </Section>
  );
}

function OrganizerBody({
  language,
  detail,
  reload,
}: Readonly<{ language: Language; detail: OrganizerDetail; reload: (done: string) => void }>) {
  const t = translatorFor(language);
  return (
    <>
      <SuspensionPanel
        language={language}
        kind="organizer"
        id={detail.organizer.id}
        name={detail.organizer.name}
        suspension={detail.organizer.suspension}
        onChanged={reload}
      />
      <OwnerEmailPanel
        language={language}
        organizerId={detail.organizer.id}
        change={detail.ownerEmailChange}
        others={detail.ownerOtherOrganizers}
        onChanged={reload}
      />
      <OrganizerFeaturesPanel language={language} organizerId={detail.organizer.id} />
      <Section title={t("console.organizer.team")} level={3}>
        <Rows>
          {detail.team.map((member) => (
            <Row
              key={member.email}
              main={
                <span>
                  <bdi dir="ltr">{member.email}</bdi>{" "}
                  <Badge>{t(`staff.role.${member.role}`)}</Badge>
                  {member.limited === null
                    ? null
                    : ` ${t("console.organizer.limited", { count: member.limited })}`}
                </span>
              }
            />
          ))}
        </Rows>
      </Section>
      <Section title={t("console.organizer.events")} level={3}>
        {detail.events.length === 0 ? (
          <Muted>{t("console.organizer.noEvents")}</Muted>
        ) : (
          <Rows>
            {detail.events.map((event) => (
              <Row
                key={event.id}
                main={
                  <span>
                    <TextLink href={`/${language}/console/events/${event.id}`}>
                      <bdi>{nameIn(event.name, language)}</bdi>
                    </TextLink>{" "}
                    <Badge>{t(`events.status.${event.statusNow}` as MessageKey)}</Badge>{" "}
                    {event.suspension === null ? null : (
                      <Badge tone="danger">{t("console.organizers.status.paused")}</Badge>
                    )}
                  </span>
                }
              />
            ))}
          </Rows>
        )}
      </Section>
      <HistoryList language={language} history={detail.history} />
    </>
  );
}

/** One organizer in the console (T-701): suspend or reactivate it, its team, its events and its recent history. */
export function ConsoleOrganizer({
  language,
  organizerId,
}: Readonly<{ language: Language; organizerId: string }>) {
  const t = translatorFor(language);
  const [detail, setDetail] = useState<OrganizerDetail | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(async () => {
    const result = await requestJson("GET", `${ORGANIZERS_API}/${organizerId}`);
    const read = result.ok ? readOrganizerDetail(result.body) : undefined;
    if (read === undefined) {
      setProblem(describeProblem(result.body, language, t).text);
      return;
    }
    setDetail(read);
  }, [organizerId, language, t]);
  useEffect(() => {
    void load();
  }, [load]);
  if (detail === null) {
    return problem === null ? (
      <Muted>{t("common.loading")}</Muted>
    ) : (
      <Notice tone="danger" role="alert">
        {problem}
      </Notice>
    );
  }
  return (
    <Stack as="section" aria-labelledby="console-organizer-title">
      <PageHeader
        title={<bdi>{detail.organizer.name}</bdi>}
        titleId="console-organizer-title"
        back={{ href: `/${language}/console/organizers`, label: t("console.organizer.back") }}
        meta={<bdi dir="ltr">{detail.organizer.slug}</bdi>}
      />
      {notice === null ? null : (
        <Notice tone="info" role="status">
          {notice}
        </Notice>
      )}
      <OrganizerBody
        language={language}
        detail={detail}
        reload={(done) => {
          setNotice(done);
          void load();
        }}
      />
    </Stack>
  );
}
