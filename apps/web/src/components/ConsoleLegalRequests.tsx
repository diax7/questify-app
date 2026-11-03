"use client";

import {
  DATA_REQUEST_REASONS,
  dataExportFileName,
  formatNumber,
  isCaseReference,
  isDataRequestReason,
  type DataRequestReason,
  type Language,
  type LegalRequest,
  type MessageKey,
  type PendingHandoverItem,
} from "@questify/shared";
import { useEffect, useState } from "react";
import { ConfirmedButton, Problem, keyed, useWrite } from "#src/components/ConsoleOversight.tsx";
import { clockOf } from "#src/lib/console-organizers.ts";
import {
  dataExportPath,
  erasePath,
  pendingPath,
  readEraseAnswer,
  readPending,
} from "#src/lib/console-players.ts";
import { translatorFor, type Translate } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { Muted, Notice } from "#src/ui/Feedback.tsx";
import { Checkbox, Field, Input, Select } from "#src/ui/Field.tsx";
import { Row, Rows, Section, Stack } from "#src/ui/Section.tsx";

type Case = Readonly<{ reasonCode: string; reference: string }>;

const REASON_KEY = {
  legal_request: "console.player.legal.reason.legalRequest",
  player_request: "console.player.legal.reason.playerRequest",
} as const satisfies Record<DataRequestReason, MessageKey>;

const caseReady = (legal: Case): boolean =>
  isDataRequestReason(legal.reasonCode) && isCaseReference(legal.reference);

/** Saves the file in the admin's browser; the page keeps no copy once the link is let go. */
function saveFile(body: unknown): void {
  const blob = new Blob([JSON.stringify(body, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = dataExportFileName(new Date());
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function CaseFields({
  t,
  legal,
  change,
}: Readonly<{ t: Translate; legal: Case; change: (next: Case) => void }>) {
  return (
    <>
      <Field label={t("console.player.legal.reason")}>
        <Select
          value={legal.reasonCode}
          onChange={(changed) => change({ ...legal, reasonCode: changed.target.value })}
        >
          <option value="">{t("console.player.reason.choose")}</option>
          {DATA_REQUEST_REASONS.map((code) => (
            <option key={code} value={code}>
              {t(REASON_KEY[code])}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label={t("console.player.legal.reference")}
        help={t("console.player.legal.reference.hint")}
      >
        <Input
          dir="ltr"
          autoComplete="off"
          maxLength={64}
          value={legal.reference}
          onChange={(changed) => change({ ...legal, reference: changed.target.value.trim() })}
        />
      </Field>
    </>
  );
}

function EraseFields({
  t,
  language,
  username,
  pending,
  typed,
  setTyped,
  forfeit,
  setForfeit,
}: Readonly<{
  t: Translate;
  language: Language;
  username: string;
  pending: readonly PendingHandoverItem[];
  typed: string;
  setTyped: (next: string) => void;
  forfeit: boolean;
  setForfeit: (next: boolean) => void;
}>) {
  return (
    <>
      {pending.length === 0 ? null : (
        <Notice tone="warning" role="status" as="div">
          <Stack>
            <span>
              {t("console.player.legal.erase.pending", {
                count: formatNumber(pending.length, language),
              })}
            </span>
            <Checkbox
              label={t("console.player.legal.erase.forfeit")}
              checked={forfeit}
              onChange={(changed) => setForfeit(changed.target.checked)}
            />
          </Stack>
        </Notice>
      )}
      <Field label={t("console.player.legal.erase.typed", { name: `@${username}` })}>
        <Input
          dir="auto"
          autoComplete="off"
          maxLength={30}
          value={typed}
          onChange={(changed) => setTyped(changed.target.value)}
        />
      </Field>
    </>
  );
}

/**
 * A legal data request on one player (T-708, FR-1778, ADR-483): a reason and an opaque case number, then download the
 * player's data or delete the account for good (the username typed, a forfeit when prizes wait). Each is audited by the
 * API with the admin and the case; the downloaded file is handed over outside the system (Q-441).
 */
export function LegalRequestPanel({
  language,
  playerId,
  username,
  onChanged,
}: Readonly<{
  language: Language;
  playerId: string;
  username: string;
  onChanged: (done: string | null) => void;
}>) {
  const t = translatorFor(language);
  const [legal, setLegal] = useState<Case>({ reasonCode: "", reference: "" });
  const [typed, setTyped] = useState("");
  const [forfeit, setForfeit] = useState(false);
  const [pending, setPending] = useState<readonly PendingHandoverItem[]>([]);
  const [saved, setSaved] = useState(false);
  const { busy, problem, run } = useWrite(language, () => undefined);
  useEffect(() => {
    void requestJson("GET", pendingPath(playerId)).then((result) => {
      setPending(result.ok ? (readPending(result.body) ?? []) : []);
    });
  }, [playerId]);
  const ready = caseReady(legal) && !busy;
  const eraseReady = ready && typed === username && (pending.length === 0 || forfeit);
  return (
    <Section
      title={t("console.player.legal")}
      level={3}
      description={t("console.player.legal.intro")}
    >
      <Stack>
        <Problem problem={problem} />
        <CaseFields t={t} legal={legal} change={setLegal} />
        <ConfirmedButton
          language={language}
          label={t("console.player.legal.export")}
          question={t("console.player.legal.export")}
          variant="secondary"
          disabled={!ready}
          act={() =>
            void run(async () => {
              const result = await requestJson("POST", dataExportPath(playerId), legal);
              if (result.ok) {
                saveFile(result.body);
                setSaved(true);
                onChanged(null);
              }
              return result;
            }, "")
          }
        />
        {saved ? (
          <Notice tone="info" role="status">
            {t("console.player.legal.export.done")}
          </Notice>
        ) : null}
        <Muted>{t("console.player.legal.erase.intro")}</Muted>
        <EraseFields
          t={t}
          language={language}
          username={username}
          pending={pending}
          typed={typed}
          setTyped={setTyped}
          forfeit={forfeit}
          setForfeit={setForfeit}
        />
        <ConfirmedButton
          language={language}
          label={t("console.player.legal.erase")}
          question={t("console.player.legal.erase.confirm", { name: `@${username}` })}
          variant="danger"
          disabled={!eraseReady}
          act={() =>
            void run(async () => {
              const body = { ...legal, username: typed, forfeit };
              const result = await requestJson("POST", erasePath(playerId), body, keyed());
              if (result.ok && readEraseAnswer(result.body) !== undefined) {
                onChanged(null);
              }
              return result;
            }, "")
          }
        />
      </Stack>
    </Section>
  );
}

function historyLine(t: Translate, entry: LegalRequest): string {
  const parts = [
    t(
      entry.action === "player.delete"
        ? "console.player.legal.history.delete"
        : "console.player.legal.history.export",
    ),
  ];
  if (isDataRequestReason(entry.reasonCode)) {
    parts.push(t(REASON_KEY[entry.reasonCode]));
  }
  if (entry.source === "player") parts.push(t("console.player.legal.history.player"));
  if (entry.source === "reapply") parts.push(t("console.player.legal.history.reapply"));
  return parts.join(" · ");
}

/** Every export and erasure of the player, newest first; shown on an account and on its tombstone. */
export function LegalHistory({
  language,
  entries,
}: Readonly<{ language: Language; entries: readonly LegalRequest[] }>) {
  const t = translatorFor(language);
  if (entries.length === 0) {
    return null;
  }
  return (
    <Section title={t("console.player.legal.history")} level={3}>
      <Rows>
        {entries.map((entry) => (
          <Row
            key={`${entry.at}-${entry.action}`}
            main={
              <div>
                <span>{historyLine(t, entry)}</span>
                <br />
                <Muted as="span">
                  {clockOf(entry.at, language)}
                  {entry.reference === null ? null : (
                    <>
                      {" · "}
                      {t("console.player.legal.history.case")}{" "}
                      <bdi dir="ltr">{entry.reference}</bdi>
                    </>
                  )}
                  {entry.by === null ? null : (
                    <>
                      {" · "}
                      {t("console.player.legal.history.by")} <bdi dir="ltr">{entry.by}</bdi>
                    </>
                  )}
                </Muted>
              </div>
            }
          />
        ))}
      </Rows>
    </Section>
  );
}
