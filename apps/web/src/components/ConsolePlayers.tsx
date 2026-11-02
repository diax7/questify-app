"use client";

import {
  PLAYER_SEARCH_BY,
  type Language,
  type PlayerSearchBy,
  type PlayerSearchRow,
} from "@questify/shared";
import { useState } from "react";
import { clockOf } from "#src/lib/console-organizers.ts";
import { PLAYERS_SEARCH_API, readSearch } from "#src/lib/console-players.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem } from "#src/lib/sign-in-errors.ts";
import { Button } from "#src/ui/Button.tsx";
import { Badge, Muted, Notice } from "#src/ui/Feedback.tsx";
import { Field, Form, Input, Select } from "#src/ui/Field.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Row, Rows, Stack, Toolbar } from "#src/ui/Section.tsx";
import { TextLink } from "#src/ui/Text.tsx";
import { infoTip } from "#src/ui/info.tsx";

const STATUS_TONE = { active: "neutral", banned: "danger", deleted: "neutral" } as const;

/** Masked contacts, left to right inside an Arabic line. */
export function MaskedContacts({
  phone,
  email,
}: Readonly<{ phone: string | null; email: string | null }>) {
  const shown = [phone, email].filter((value): value is string => value !== null);
  return shown.length === 0 ? null : (
    <span>
      {shown.map((value, index) => (
        <span key={value}>
          {index > 0 ? " · " : null}
          <bdi dir="ltr">{value}</bdi>
        </span>
      ))}
    </span>
  );
}

function PlayerLine({ language, row }: Readonly<{ language: Language; row: PlayerSearchRow }>) {
  const t = translatorFor(language);
  return (
    <Row
      main={
        <Stack>
          <span>
            <TextLink href={`/${language}/console/players/${row.id}`} strong>
              <bdi dir="auto">@{row.username}</bdi>
            </TextLink>{" "}
            <Badge tone={STATUS_TONE[row.status]}>
              {t(`console.players.status.${row.status}`)}
            </Badge>
          </span>
          <Muted as="span">
            <MaskedContacts phone={row.contacts.phone} email={row.contacts.email} />
            {" · "}
            {t("console.players.joined", { date: clockOf(row.createdAt, language) })}
          </Muted>
        </Stack>
      }
    />
  );
}

/**
 * The console's player search (T-704, FR-1774): a username prefix, or a mobile number or email typed in full. The text
 * goes in the request body, never the address; the API audits every search with the ids shown and never the text.
 * Contacts are masked here; the record shows them in full only after a reason.
 */
export function ConsolePlayers({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const [by, setBy] = useState<PlayerSearchBy>("username");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<PlayerSearchRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const find = async () => {
    setBusy(true);
    const result = await requestJson("POST", PLAYERS_SEARCH_API, { by, q: q.trim() });
    setBusy(false);
    const found = result.ok ? readSearch(result.body) : undefined;
    setProblem(found === undefined ? describeProblem(result.body, language, t).text : null);
    setRows(found ?? null);
  };

  return (
    <Stack as="section" aria-labelledby="console-players-title">
      <PageHeader
        title={t("console.players.title")}
        titleId="console-players-title"
        info={infoTip(t, "console.players.intro")}
      />
      <Form
        onSubmit={(submitted) => {
          submitted.preventDefault();
          void find();
        }}
      >
        <Field label={t("console.players.by")}>
          <Select value={by} onChange={(changed) => setBy(changed.target.value as PlayerSearchBy)}>
            {PLAYER_SEARCH_BY.map((choice) => (
              <option key={choice} value={choice}>
                {t(`console.players.by.${choice}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("console.players.query")} help={t("console.players.queryHint")}>
          <Input
            type="search"
            dir="auto"
            autoComplete="off"
            maxLength={254}
            value={q}
            onChange={(changed) => setQ(changed.target.value)}
          />
        </Field>
        <Toolbar>
          <Button type="submit" variant="primary" disabled={busy || q.trim() === ""}>
            {t("console.players.find")}
          </Button>
        </Toolbar>
      </Form>
      {problem === null ? null : (
        <Notice tone="danger" role="alert">
          {problem}
        </Notice>
      )}
      {rows !== null && rows.length === 0 ? <Muted>{t("console.players.none")}</Muted> : null}
      {rows !== null && rows.length > 0 ? (
        <Rows>
          {rows.map((row) => (
            <PlayerLine key={row.id} language={language} row={row} />
          ))}
        </Rows>
      ) : null}
    </Stack>
  );
}
