"use client";

import { formatEventTime, formatNumber, type Language } from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "#src/components/ConfirmDialog.tsx";
import { translatorFor } from "#src/lib/language.ts";
import { tagsOf, type TagLine } from "#src/lib/nfc-tags.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { textFor, type Bilingual } from "#src/lib/quests.ts";
import { describeProblem } from "#src/lib/sign-in-errors.ts";
import styles from "#src/components/layout.module.css";

type Props = Readonly<{
  language: Language;
  timeZone: string;
  /** `/v1/organizers/{id}/events/{id}`. */
  eventApi: string;
  questId: string;
  /** The event's other scan quests with NFC on, where a tag may be moved. */
  targets: readonly Readonly<{ id: string; title: Bilingual }>[];
  /** The quest's NFC method: off, the panel shows only while tags remain (CTO code review 1). */
  nfcOn: boolean;
  readOnly: boolean;
}>;

/** One tag: its name, who wrote it and when, its taps, copies and unchecked taps; Move and Revoke while active. */
function TagCard({
  tag,
  language,
  timeZone,
  targets,
  busy,
  readOnly,
  move,
  revoke,
}: Readonly<{
  tag: TagLine;
  language: Language;
  timeZone: string;
  targets: Props["targets"];
  busy: boolean;
  readOnly: boolean;
  move: (questId: string) => void;
  revoke: () => void;
}>) {
  const t = translatorFor(language);
  const [target, setTarget] = useState("");
  const count = (n: number) => formatNumber(n, language);
  const time = (iso: string) => formatEventTime(new Date(iso), timeZone, language);
  return (
    <li className={styles.card}>
      <strong>{tag.label === "" ? t("tags.unnamed") : tag.label}</strong>
      {tag.locked ? <span className={styles.badge}>{t("tags.locked")}</span> : null}
      {tag.status === "revoked" ? <span className={styles.badge}>{t("tags.revoked")}</span> : null}
      {tag.writtenBy === null ? null : (
        <span className={styles.muted}>{t("tags.writtenBy", { name: tag.writtenBy })}</span>
      )}
      <span className={styles.muted}>{time(tag.writtenAt)}</span>
      <span>{t("tags.taps", { count: count(tag.taps) })}</span>
      {tag.copies > 0 ? <strong>{t("tags.copies", { count: count(tag.copies) })}</strong> : null}
      {tag.unchecked > 0 ? (
        <span>{t("tags.unchecked", { count: count(tag.unchecked) })}</span>
      ) : null}
      {tag.lastTapAt === null ? null : (
        <span className={styles.muted}>{t("tags.lastTap", { at: time(tag.lastTapAt) })}</span>
      )}
      {readOnly || tag.status === "revoked" ? null : (
        <div className={styles.actions}>
          {targets.length === 0 ? null : (
            <>
              <label className={styles.field}>
                {t("tags.moveTo")}
                <select
                  className={styles.input}
                  value={target}
                  disabled={busy}
                  onChange={(event) => setTarget(event.target.value)}
                >
                  <option value="" />
                  {targets.map((quest) => (
                    <option key={quest.id} value={quest.id}>
                      {textFor(quest.title, language)}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className={styles.button}
                disabled={busy || target === ""}
                onClick={() => move(target)}
              >
                {t("tags.move")}
              </button>
            </>
          )}
          <button type="button" className={styles.button} disabled={busy} onClick={revoke}>
            {t("tags.revoke")}
          </button>
        </div>
      )}
    </li>
  );
}

/**
 * A quest's NFC tags (T-308, F-105) in its edit form: the list with each tag's taps and possible copies, Move to
 * another NFC quest, Revoke, and Revoke all after a confirmation. Tags are written from staff mode on a phone, never
 * here. A basic tag can be copied like a printed QR, which the panel says.
 */
export function NfcTagsPanel({
  language,
  timeZone,
  eventApi,
  questId,
  targets,
  nfcOn,
  readOnly,
}: Props) {
  const t = translatorFor(language);
  const [tags, setTags] = useState<readonly TagLine[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const load = useCallback(async () => {
    const result = await requestJson("GET", `${eventApi}/quests/${questId}/nfc-tags`);
    const read = result.ok ? tagsOf(result.body) : undefined;
    if (read === undefined) {
      setProblem(t("tags.failed"));
    } else {
      setTags(read);
    }
  }, [eventApi, questId, t]);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (path: string, payload?: unknown) => {
    setBusy(true);
    setProblem(null);
    const result = await requestJson("POST", `${eventApi}${path}`, payload ?? {}, {
      "idempotency-key": crypto.randomUUID(),
    });
    setBusy(false);
    setConfirming(false);
    if (!result.ok) {
      setProblem(
        result.body === undefined
          ? t("tags.failed")
          : describeProblem(result.body, language, t).text,
      );
    }
    await load();
  };

  const active = tags?.some((tag) => tag.status === "active") === true;
  if (!nfcOn && (tags === null || tags.length === 0)) {
    return null;
  }
  return (
    <section className={styles.panel} aria-labelledby={`tags-${questId}`}>
      <h3 id={`tags-${questId}`} className={styles.subtitle}>
        {t("tags.title")}
      </h3>
      <p className={styles.muted}>{t("tags.basicNote")}</p>
      <p className={styles.muted}>{t("tags.qrNote")}</p>
      {problem === null ? null : <p role="alert">{problem}</p>}
      {tags === null ? null : tags.length === 0 ? (
        <p className={styles.muted}>{t("tags.empty")}</p>
      ) : (
        <ul className={styles.list}>
          {tags.map((tag) => (
            <TagCard
              key={tag.id}
              tag={tag}
              language={language}
              timeZone={timeZone}
              targets={targets}
              busy={busy}
              readOnly={readOnly}
              move={(target) => void act(`/nfc-tags/${tag.id}/move`, { questId: target })}
              revoke={() => void act(`/nfc-tags/${tag.id}/revoke`)}
            />
          ))}
        </ul>
      )}
      {readOnly || !active ? null : confirming ? (
        <ConfirmDialog
          language={language}
          title={t("tags.revokeAll")}
          body={t("tags.revokeAllConfirm")}
          confirmLabel={t("tags.revokeAll")}
          noteLabel={null}
          busy={busy}
          cancel={() => setConfirming(false)}
          confirm={() => void act(`/quests/${questId}/nfc-tags/revoke-all`)}
        />
      ) : (
        <button
          type="button"
          className={styles.button}
          disabled={busy}
          onClick={() => setConfirming(true)}
        >
          {t("tags.revokeAll")}
        </button>
      )}
    </section>
  );
}
