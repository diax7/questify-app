"use client";
import type { Language, SouvenirRule } from "@questify/shared";
import { SouvenirPreview } from "#src/components/SouvenirPreview.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import styles from "#src/components/layout.module.css";

function Action({
  label,
  busy,
  act,
  primary = false,
}: {
  label: string;
  busy: boolean;
  act: () => void;
  primary?: boolean;
}) {
  return (
    <button className={primary ? styles.button : styles.quiet} disabled={busy} onClick={act}>
      {label}
    </button>
  );
}
type Props = {
  rule: SouvenirRule;
  language: Language;
  busy: boolean;
  archived: boolean;
  base: string;
  edit: () => void;
  activate: () => void;
  stop: () => void;
  remove: () => void;
};
export function SouvenirCard({
  rule,
  language,
  busy,
  archived,
  base,
  edit,
  activate,
  stop,
  remove,
}: Props) {
  const t = useTranslator(language);
  return (
    <article className={styles.card}>
      <SouvenirPreview item={rule.item} language={language} />
      <h2 className={styles.subtitle}>{rule.item.name[language]}</h2>
      <p>
        {t(`souvenir.${rule.status}`)} · {t(`souvenir.${rule.audience}`)}
        {rule.audience === "rank" ? ` (${rule.rankFrom}–${rule.rankTo})` : ""}
      </p>
      <p>{t("souvenir.targets", { count: rule.targetCount })}</p>
      <p>{t("souvenir.granted", { count: rule.granted })}</p>
      {rule.waitingForResults ? (
        <p>
          {t("souvenir.waiting")}{" "}
          <a className={styles.textLink} href={`${base}/prizes`}>
            {t("souvenir.results")}
          </a>
        </p>
      ) : null}
      {archived ? null : (
        <div className={styles.actions}>
          {rule.status === "draft" ? (
            <>
              <Action busy={busy} label={t("souvenir.edit")} act={edit} />
              <Action busy={busy} label={t("souvenir.activate")} act={activate} primary />
              <Action busy={busy} label={t("souvenir.remove")} act={remove} />
            </>
          ) : null}
          {rule.status === "active" ? (
            <Action busy={busy} label={t("souvenir.stop")} act={stop} />
          ) : null}
        </div>
      )}
    </article>
  );
}
