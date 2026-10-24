"use client";

import { formatNumber, type Language } from "@questify/shared";
import { useRef } from "react";
import { JOIN_OPTION_MAX, JOIN_OPTION_MIN, type OptionDraft } from "#src/lib/joining.ts";
import { useTranslator } from "#src/components/TermsScope.tsx";
import styles from "#src/components/layout.module.css";

type Props = Readonly<{
  language: Language;
  /** The field's label, so each option's inputs name the field they belong to. */
  fieldName: string;
  options: readonly OptionDraft[] | null;
  busy: boolean;
  change: (options: OptionDraft[] | null) => void;
}>;

/**
 * A custom field's answer as a choice from a list (ADR-171), which "Who sees what" can target: 2 to 20 options, each
 * named in Arabic, English or both. A saved option that players chose or a rule names cannot be removed (the API
 * answers `join_field_in_use`); a new one can always be added.
 */
export function JoinOptionsEditor({ language, fieldName, options, busy, change }: Props) {
  const t = useTranslator(language);
  const counter = useRef(0);
  const fresh = (): OptionDraft => {
    counter.current += 1;
    return { key: `option-${counter.current}`, id: undefined, ar: "", en: "" };
  };
  const list = options ?? [];
  const set = (index: number, patch: Partial<OptionDraft>) =>
    change(list.map((option, at) => (at === index ? { ...option, ...patch } : option)));

  return (
    <fieldset className={styles.form}>
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={options !== null}
          disabled={busy}
          onChange={(ticked) => change(ticked.target.checked ? [fresh(), fresh()] : null)}
        />
        <span>{t("joinFields.choice")}</span>
      </label>
      {options === null ? null : (
        <>
          <p className={styles.muted}>
            {t("joinFields.choiceHint", {
              min: formatNumber(JOIN_OPTION_MIN, language),
              max: formatNumber(JOIN_OPTION_MAX, language),
            })}
          </p>
          <ol className={styles.list}>
            {list.map((option, index) => (
              <li key={option.key} className={styles.row}>
                {(["ar", "en"] as const).map((side) => (
                  <label key={side} className={styles.field}>
                    <span>
                      {t(side === "ar" ? "joinFields.optionAr" : "joinFields.optionEn", {
                        number: formatNumber(index + 1, language),
                      })}
                    </span>
                    <input
                      className={styles.input}
                      dir={side === "ar" ? "rtl" : "ltr"}
                      maxLength={60}
                      value={option[side]}
                      disabled={busy}
                      aria-description={fieldName}
                      onChange={(typed) => set(index, { [side]: typed.target.value })}
                    />
                  </label>
                ))}
                <button
                  type="button"
                  className={styles.quiet}
                  disabled={busy || list.length <= JOIN_OPTION_MIN}
                  onClick={() => change(list.filter((_, at) => at !== index))}
                >
                  {t("joinFields.removeOption")}
                </button>
              </li>
            ))}
          </ol>
          {list.length < JOIN_OPTION_MAX ? (
            <button
              type="button"
              className={styles.quiet}
              disabled={busy}
              onClick={() => change([...list, fresh()])}
            >
              {t("joinFields.addOption")}
            </button>
          ) : null}
        </>
      )}
    </fieldset>
  );
}
