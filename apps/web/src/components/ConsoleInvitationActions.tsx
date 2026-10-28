"use client";
import type {
  AdminInvitationDetail,
  InvitationApproveBody,
  InvitationChannel,
  Language,
} from "@questify/shared";
import { useState, type FormEvent } from "react";
import { NumberField } from "#src/components/NumberField.tsx";
import {
  NOTE_MAX,
  approvalBlock,
  approvalBodyOf,
  approvalDraftOf,
  type ApprovalDraft,
  type ApprovalProblem,
} from "#src/lib/console-invitations.ts";
import { riyadhTime } from "#src/lib/invitations.ts";
import { translatorFor } from "#src/lib/language.ts";
import styles from "#src/components/layout.module.css";

type FormProps = Readonly<{
  language: Language;
  detail: AdminInvitationDetail;
  busy: boolean;
  /** Approves with these terms; true when it was approved. */
  approve: (body: InvitationApproveBody) => Promise<boolean>;
}>;

/** The words under a field the form found wrong. */
const WRONG = {
  channels: "console.invCampaign.invalid.channels",
  cap: "console.invCampaign.invalid.cap",
  sendAt: "console.invCampaign.invalid.sendAt",
  note: "console.invCampaign.invalid.note",
} as const;

type ChannelProps = Readonly<{
  language: Language;
  available: readonly InvitationChannel[];
  draft: ApprovalDraft;
  busy: boolean;
  change: (patch: Partial<ApprovalDraft>) => void;
}>;

/** The two channels, each off when this server cannot send it, and the rule that a player gets one of them. */
function ChannelChoices({ language, available, draft, busy, change }: ChannelProps) {
  const t = translatorFor(language);
  return (
    <fieldset className={styles.choices}>
      <legend>{t("console.invCampaign.field.channels")}</legend>
      {(["push", "sms"] as const).map((channel) => (
        <label key={channel} className={styles.check}>
          <input
            type="checkbox"
            checked={draft[channel]}
            disabled={busy || !available.includes(channel)}
            onChange={(changed) => change({ [channel]: changed.target.checked })}
          />
          <span>{t(`console.invCampaign.channel.${channel}`)}</span>
        </label>
      ))}
      <p className={styles.muted}>{t("console.invCampaign.channel.hint")}</p>
    </fieldset>
  );
}

/**
 * Approve (FR-738): the channels (push, SMS or both; one message a player, ADR-356 (4)), the most messages that may
 * go out, the send time in Riyadh time, and a note the owner reads. It sends back the event names the page showed, so a rename in the meantime is caught by the API.
 */
export function ApproveForm({ language, detail, busy, approve }: FormProps) {
  const t = translatorFor(language);
  const [draft, setDraft] = useState(() =>
    approvalDraftOf(detail.campaign, new Date(), detail.availableChannels),
  );
  const [wrong, setWrong] = useState<ApprovalProblem | null>(null);
  const block = approvalBlock(detail);
  const change = (patch: Partial<typeof draft>) => {
    setDraft({ ...draft, ...patch });
    setWrong(null);
  };
  const send = async (submitted: FormEvent) => {
    submitted.preventDefault();
    const checked = approvalBodyOf(draft, detail);
    if ("problem" in checked) {
      setWrong(checked.problem);
    } else if (
      window.confirm(
        t("console.invCampaign.approveConfirm", {
          cap: checked.body.cap,
          time: riyadhTime(checked.body.sendAt, language),
        }),
      )
    ) {
      await approve(checked.body);
    }
  };
  return (
    <form
      className={styles.formCard}
      aria-labelledby="approve-title"
      onSubmit={(submitted) => void send(submitted)}
    >
      <h2 id="approve-title" className={styles.subtitle}>
        {t("console.invCampaign.approve.title")}
      </h2>
      {block === null ? null : (
        <p className={styles.warning} data-testid="block">
          {t(`console.invCampaign.block.${block}`)}
        </p>
      )}
      <ChannelChoices
        language={language}
        available={detail.availableChannels}
        draft={draft}
        busy={busy}
        change={change}
      />
      <NumberField
        label={t("console.invCampaign.field.cap")}
        value={draft.cap}
        invalid={wrong === "cap"}
        disabled={busy}
        change={(cap) => change({ cap })}
      />
      <label className={styles.field}>
        {t("console.invCampaign.field.sendAt")}
        <input
          className={styles.input}
          type="datetime-local"
          dir="ltr"
          required
          value={draft.sendAt}
          disabled={busy}
          aria-invalid={wrong === "sendAt"}
          onChange={(changed) => change({ sendAt: changed.target.value })}
        />
      </label>
      <p className={styles.muted}>{t("console.invCampaign.sendAt.hint")}</p>
      <label className={styles.field}>
        {t("console.invCampaign.field.note")}
        <textarea
          className={styles.input}
          dir="auto"
          rows={2}
          maxLength={NOTE_MAX}
          value={draft.note}
          disabled={busy}
          onChange={(changed) => change({ note: changed.target.value })}
        />
      </label>
      {wrong === null ? null : (
        <p role="alert" className={styles.alert}>
          {t(WRONG[wrong])}
        </p>
      )}
      <button type="submit" className={styles.button} disabled={busy || block !== null}>
        {t("console.invCampaign.approve.button")}
      </button>
    </form>
  );
}

type NoteProps = Readonly<{
  language: Language;
  detail: AdminInvitationDetail;
  busy: boolean;
  /** Refuses or cancels with the note; the page reads again after it. */
  close: (action: "refuse" | "cancel", note: string) => Promise<void>;
}>;

/** Refuse (a request still waiting) or Cancel (any that has not ended), each with the note the owner reads. */
export function CloseForm({ language, detail, busy, close }: NoteProps) {
  const t = translatorFor(language);
  const [note, setNote] = useState("");
  const { state } = detail.campaign;
  const ready = note.trim() !== "" && note.trim().length <= NOTE_MAX;
  return (
    <div className={styles.formCard}>
      <label className={styles.field}>
        {t("console.invCampaign.field.closeNote")}
        <textarea
          className={styles.input}
          dir="auto"
          rows={2}
          maxLength={NOTE_MAX}
          value={note}
          disabled={busy}
          onChange={(changed) => setNote(changed.target.value)}
        />
      </label>
      <div className={styles.actions}>
        {state === "requested" ? (
          <button
            type="button"
            className={styles.quiet}
            disabled={busy || !ready}
            onClick={() => {
              if (window.confirm(t("console.invCampaign.refuseConfirm"))) {
                void close("refuse", note.trim());
              }
            }}
          >
            {t("console.invCampaign.refuse")}
          </button>
        ) : null}
        <button
          type="button"
          className={styles.quiet}
          disabled={busy || !ready}
          onClick={() => {
            if (window.confirm(t("console.invCampaign.cancelConfirm"))) {
              void close("cancel", note.trim());
            }
          }}
        >
          {t("console.invCampaign.cancel")}
        </button>
      </div>
    </div>
  );
}
