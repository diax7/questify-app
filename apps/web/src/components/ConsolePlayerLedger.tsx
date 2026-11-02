"use client";

import {
  MARKETING_CHANNELS,
  formatNumber,
  type Language,
  type LedgerLine,
  type PlayerRecord,
} from "@questify/shared";
import { Fragment, useCallback, useEffect, useState } from "react";
import { nameIn } from "#src/lib/console.ts";
import { clockOf } from "#src/lib/console-organizers.ts";
import {
  codeLabel,
  consentPath,
  ledgerPath,
  readConsent,
  readLedger,
} from "#src/lib/console-players.ts";
import { useConsoleRead } from "#src/lib/use-console-read.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { Button } from "#src/ui/Button.tsx";
import { Badge, Muted, Notice } from "#src/ui/Feedback.tsx";
import { Field, Select } from "#src/ui/Field.tsx";
import { FactList, Row, Rows, Section, Stack } from "#src/ui/Section.tsx";

function LedgerRow({
  language,
  line,
  eventName,
}: Readonly<{ language: Language; line: LedgerLine; eventName: string }>) {
  const t = translatorFor(language);
  const what = line.quest ?? line.reward;
  return (
    <Row
      main={
        <Stack>
          <span data-testid="ledger-line">
            <bdi dir="ltr">
              {line.score > 0 ? "+" : ""}
              {formatNumber(line.score, language)}
            </bdi>{" "}
            {codeLabel(t, "console.player.kind", line.kind)}
            {what === null ? null : (
              <>
                {" · "}
                <bdi>{nameIn(what, language)}</bdi>
              </>
            )}
            {line.rehearsal ? (
              <>
                {" "}
                <Badge tone="info">{t("console.player.ledger.rehearsal")}</Badge>
              </>
            ) : null}
          </span>
          <Muted as="span">
            <bdi>{eventName}</bdi>
            {" · "}
            {codeLabel(t, "console.player.actor", line.actor)}
            {" · "}
            {clockOf(line.at, language)}
          </Muted>
        </Stack>
      }
    />
  );
}

/** The player's marketing consent per channel (T-407's audited read): agreed or not, and since when. */
export function PlayerConsent({
  language,
  playerId,
}: Readonly<{ language: Language; playerId: string }>) {
  const t = translatorFor(language);
  const { state } = useConsoleRead(consentPath(playerId), readConsent);
  return (
    <Section title={t("console.player.consent")}>
      {state.kind === "loading" ? <Muted role="status">{t("common.loading")}</Muted> : null}
      {state.kind === "failed" ? (
        <Notice tone="danger" role="alert">
          {t("console.player.loadFailed")}
        </Notice>
      ) : null}
      {state.kind === "ready" ? (
        <FactList label={t("console.player.consent")}>
          {MARKETING_CHANNELS.map((channel) => {
            const stands = state.value.channels[channel];
            return (
              <Fragment key={channel}>
                <dt>{t(`marketing.channel.${channel}`)}</dt>
                <dd>
                  {stands.optedIn && stands.changedAt !== null
                    ? t("console.player.consent.on", { date: clockOf(stands.changedAt, language) })
                    : t("console.player.consent.off")}
                </dd>
              </Fragment>
            );
          })}
        </FactList>
      ) : null}
    </Section>
  );
}

/**
 * The player's points record (FR-1774), newest first, 50 a page, for all events or one: the kind, the change, the quest
 * or reward, who made it as a kind only, and when. Every page is audited by the API.
 */
export function PlayerLedger({
  language,
  playerId,
  events,
}: Readonly<{ language: Language; playerId: string; events: PlayerRecord["events"] }>) {
  const t = translatorFor(language);
  const [eventId, setEventId] = useState("");
  const [lines, setLines] = useState<LedgerLine[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(
    async (before: number | null) => {
      const result = await requestJson(
        "GET",
        ledgerPath(playerId, { eventId: eventId === "" ? null : eventId, before }),
      );
      const page = result.ok ? readLedger(result.body) : undefined;
      setFailed(page === undefined);
      if (page !== undefined) {
        setLines((current) =>
          before === null ? page.entries : [...(current ?? []), ...page.entries],
        );
        setNext(page.nextCursor);
      }
    },
    [playerId, eventId],
  );
  useEffect(() => {
    void load(null);
  }, [load]);
  const nameOf = (id: string): string =>
    nameIn(events.find((one) => one.eventId === id)?.event ?? { ar: null, en: null }, language);
  return (
    <Section title={t("console.player.ledger")}>
      <Stack>
        <Field label={t("console.player.ledger.event")}>
          <Select value={eventId} onChange={(changed) => setEventId(changed.target.value)}>
            <option value="">{t("console.player.ledger.all")}</option>
            {events.map((one) => (
              <option key={one.eventId} value={one.eventId}>
                {nameIn(one.event, language)}
              </option>
            ))}
          </Select>
        </Field>
        {failed ? (
          <Notice tone="danger" role="alert">
            {t("console.player.loadFailed")}
          </Notice>
        ) : null}
        {lines !== null && lines.length === 0 ? (
          <Muted>{t("console.player.ledger.none")}</Muted>
        ) : null}
        {lines !== null && lines.length > 0 ? (
          <Rows>
            {lines.map((line) => (
              <LedgerRow
                key={line.id}
                language={language}
                line={line}
                eventName={nameOf(line.eventId)}
              />
            ))}
          </Rows>
        ) : null}
        {next === null ? null : (
          <Button variant="quiet" onClick={() => void load(next)}>
            {t("console.player.ledger.more")}
          </Button>
        )}
      </Stack>
    </Section>
  );
}
