"use client";

import {
  PLAYER_ACTION_REASONS,
  PLAYER_NOTE_MAX,
  checkUsername,
  formatNumber,
  isUsableActionNote,
  type Language,
  type PlayerActionKind,
  type PlayerTier,
  type RevealedContacts,
} from "@questify/shared";
import { useState, type ReactNode } from "react";
import { ConfirmedButton, Problem, keyed, useWrite } from "#src/components/ConsoleOversight.tsx";
import {
  banPath,
  codeLabel,
  contactPath,
  liftBanPath,
  readResetAnswer,
  readRevealed,
  renamePath,
  resetPath,
  tierKey,
  tierPath,
} from "#src/lib/console-players.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson, type PostResult } from "#src/lib/post-json.ts";
import { Notice } from "#src/ui/Feedback.tsx";
import { Checkbox, Field, FieldGroup, Input, Select, Textarea } from "#src/ui/Field.tsx";
import { FactList, Section, Stack } from "#src/ui/Section.tsx";

type Reason = Readonly<{ reasonCode: string; note: string }>;

/** A reason code from the action's list and the internal note; both are checked again by the API and the database. */
function ReasonFields({
  language,
  kind,
  reason,
  change,
}: Readonly<{
  language: Language;
  kind: PlayerActionKind;
  reason: Reason;
  change: (next: Reason) => void;
}>) {
  const t = translatorFor(language);
  return (
    <>
      <Field label={t("console.player.reason")}>
        <Select
          value={reason.reasonCode}
          onChange={(changed) => change({ ...reason, reasonCode: changed.target.value })}
        >
          <option value="">{t("console.player.reason.choose")}</option>
          {PLAYER_ACTION_REASONS[kind].map((code) => (
            <option key={code} value={code}>
              {codeLabel(t, "console.player.reason", code)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t("console.player.noteField")} help={t("console.player.noteHint")}>
        <Textarea
          dir="auto"
          maxLength={PLAYER_NOTE_MAX}
          value={reason.note}
          onChange={(changed) => change({ ...reason, note: changed.target.value })}
        />
      </Field>
    </>
  );
}

const EMPTY: Reason = { reasonCode: "", note: "" };
/** The actions that take nothing away: their button is not drawn as a danger. */
const GENTLE: ReadonlySet<PlayerActionKind> = new Set([
  "contact_reveal",
  "lift_ban",
  "restore_tiers",
]);
const ready = (reason: Reason): boolean =>
  reason.reasonCode !== "" && isUsableActionNote(reason.note);
const sent = (reason: Reason) => ({ reasonCode: reason.reasonCode, note: reason.note.trim() });

/** One action: what it does, its own fields, a reason, and a button that asks once (ADR-063). */
function ActionPanel({
  language,
  kind,
  title,
  intro,
  label,
  question,
  extraReady = true,
  children,
  send,
  onDone,
}: Readonly<{
  language: Language;
  kind: PlayerActionKind;
  title: string;
  intro: string;
  label: string;
  question: string;
  extraReady?: boolean;
  children?: ReactNode;
  send: (reason: Reason) => Promise<PostResult>;
  onDone: (result: PostResult) => void;
}>) {
  const [reason, setReason] = useState<Reason>(EMPTY);
  // The answer's body is what the panel needs, so the success is handled where the answer is, not in useWrite's callback.
  const { busy, problem, run } = useWrite(language, () => undefined);
  return (
    <Section title={title} level={3} description={intro}>
      <Stack>
        <Problem problem={problem} />
        {children}
        <ReasonFields language={language} kind={kind} reason={reason} change={setReason} />
        <ConfirmedButton
          language={language}
          label={label}
          question={question}
          variant={GENTLE.has(kind) ? "secondary" : "danger"}
          disabled={busy || !ready(reason) || !extraReady}
          act={() =>
            void run(async () => {
              const result = await send(sent(reason));
              if (result.ok) {
                onDone(result);
                setReason(EMPTY);
              }
              return result;
            }, "")
          }
        />
      </Stack>
    </Section>
  );
}

/** The full contacts after a reason, shown once in this page and kept nowhere (ADR-422). */
export function RevealPanel({
  language,
  playerId,
  onChanged,
}: Readonly<{ language: Language; playerId: string; onChanged: () => void }>) {
  const t = translatorFor(language);
  const [shown, setShown] = useState<RevealedContacts | null>(null);
  return (
    <>
      <ActionPanel
        language={language}
        kind="contact_reveal"
        title={t("console.player.reveal")}
        intro={t("console.player.reveal.intro")}
        label={t("console.player.reveal")}
        question={t("console.player.reveal.confirm")}
        send={(reason) => requestJson("POST", contactPath(playerId), reason)}
        onDone={(result) => {
          setShown(readRevealed(result.body) ?? null);
          onChanged();
        }}
      />
      {shown === null ? null : (
        <Notice tone="info" role="status" as="div">
          <FactList label={t("console.player.reveal.shown")}>
            <dt>{t("console.player.phone")}</dt>
            <dd>
              <bdi dir="ltr">{shown.phone ?? t("console.player.noContact")}</bdi>
            </dd>
            <dt>{t("console.player.email")}</dt>
            <dd>
              <bdi dir="ltr">{shown.email ?? t("console.player.noContact")}</bdi>
            </dd>
          </FactList>
        </Notice>
      )}
    </>
  );
}

/** A new username for a player, by the players' own rules; the old one is retired and the player told. */
export function RenamePanel({
  language,
  playerId,
  username,
  onChanged,
}: Readonly<{
  language: Language;
  playerId: string;
  username: string;
  onChanged: (done: string) => void;
}>) {
  const t = translatorFor(language);
  const [name, setName] = useState("");
  const checked = checkUsername(name);
  return (
    <ActionPanel
      language={language}
      kind="rename"
      title={t("console.player.rename")}
      intro={t("console.player.rename.intro")}
      label={t("console.player.rename")}
      question={t("console.player.rename.confirm", {
        old: `@${username}`,
        new: `@${checked.ok ? checked.username : name}`,
      })}
      extraReady={checked.ok && checked.username.toLowerCase() !== username.toLowerCase()}
      send={(reason) =>
        requestJson("POST", renamePath(playerId), { ...reason, username: name.trim() }, keyed())
      }
      onDone={() => {
        setName("");
        onChanged(t("console.player.rename.done"));
      }}
    >
      <Field label={t("console.player.rename.new")}>
        <Input
          dir="auto"
          autoComplete="off"
          maxLength={30}
          value={name}
          onChange={(changed) => setName(changed.target.value)}
        />
      </Field>
    </ActionPanel>
  );
}

/**
 * Bans the account or lifts its ban (FR-1416, ADR-429). The reason code of a ban is what the player is shown; the note
 * stays internal. Never automatic: this panel and the API's two doors are the only way a standing changes.
 */
export function BanPanel({
  language,
  playerId,
  username,
  banned,
  onChanged,
}: Readonly<{
  language: Language;
  playerId: string;
  username: string;
  banned: boolean;
  onChanged: (done: string) => void;
}>) {
  const t = translatorFor(language);
  const name = `@${username}`;
  return banned ? (
    <ActionPanel
      language={language}
      kind="lift_ban"
      title={t("console.player.lift")}
      intro={t("console.player.lift.intro")}
      label={t("console.player.lift")}
      question={t("console.player.lift.confirm", { name })}
      send={(reason) => requestJson("POST", liftBanPath(playerId), reason, keyed())}
      onDone={() => onChanged(t("console.player.lift.done"))}
    />
  ) : (
    <ActionPanel
      language={language}
      kind="ban"
      title={t("console.player.ban")}
      intro={t("console.player.ban.intro")}
      label={t("console.player.ban")}
      question={t("console.player.ban.confirm", { name })}
      send={(reason) => requestJson("POST", banPath(playerId), reason, keyed())}
      onDone={() => onChanged(t("console.player.ban.done"))}
    />
  );
}

/**
 * Revokes earned tiers of a banned player, or restores revoked ones (T-709c, ADR-439): the tiers ticked, a reason and a
 * note, one confirmation. What the player already got stays; a restored tier's item is given at their next sync.
 * Revoke shows only while the player is banned; Restore whenever a tier is revoked.
 */
export function TiersPanel({
  language,
  playerId,
  username,
  tiers,
  action,
  onChanged,
}: Readonly<{
  language: Language;
  playerId: string;
  username: string;
  tiers: readonly PlayerTier[];
  action: "revoke" | "restore";
  onChanged: (done: string) => void;
}>) {
  const t = translatorFor(language);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const shown = tiers.filter((tier) => tier.revoked === (action === "restore"));
  const chosen = shown.filter((tier) => picked.has(tierKey(tier)));
  return (
    <ActionPanel
      language={language}
      kind={action === "revoke" ? "revoke_tiers" : "restore_tiers"}
      title={t(`console.player.tiers.${action}`)}
      intro={t(`console.player.tiers.${action}.intro`)}
      label={t(`console.player.tiers.${action}`)}
      question={t(`console.player.tiers.${action}.confirm`, {
        count: formatNumber(chosen.length, language),
        name: `@${username}`,
      })}
      extraReady={chosen.length > 0}
      send={(reason) =>
        requestJson(
          "POST",
          tierPath(playerId, action),
          { ...reason, tiers: chosen.map((tier) => ({ achievementId: tier.id, tier: tier.tier })) },
          keyed(),
        )
      }
      onDone={() => {
        setPicked(new Set());
        onChanged(t(`console.player.tiers.${action}.done`));
      }}
    >
      <FieldGroup legend={t("console.player.tiers.pick")}>
        {shown.map((tier) => (
          <Checkbox
            key={tierKey(tier)}
            label={`${tier.name[language]} · ${t(`console.catalog.achievements.${tier.tier}`)}`}
            checked={picked.has(tierKey(tier))}
            onChange={(changed) => {
              const next = new Set(picked);
              if (changed.target.checked) {
                next.add(tierKey(tier));
              } else {
                next.delete(tierKey(tier));
              }
              setPicked(next);
            }}
          />
        ))}
      </FieldGroup>
    </ActionPanel>
  );
}

/** Signs the player out everywhere; the way back in is a fresh code to a contact already on the account (ADR-421). */
export function ResetPanel({
  language,
  playerId,
  username,
  onChanged,
}: Readonly<{
  language: Language;
  playerId: string;
  username: string;
  onChanged: (done: string) => void;
}>) {
  const t = translatorFor(language);
  return (
    <ActionPanel
      language={language}
      kind="reset_sign_in"
      title={t("console.player.reset")}
      intro={t("console.player.reset.intro")}
      label={t("console.player.reset")}
      question={t("console.player.reset.confirm", { name: `@${username}` })}
      send={(reason) => requestJson("POST", resetPath(playerId), reason, keyed())}
      onDone={(result) => {
        const count = readResetAnswer(result.body) ?? 0;
        onChanged(t("console.player.reset.done", { count: formatNumber(count, language) }));
      }}
    />
  );
}
