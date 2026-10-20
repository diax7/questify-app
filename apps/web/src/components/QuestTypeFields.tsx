"use client";

import type { Language, QuestType } from "@questify/shared";
import type { ReactNode } from "react";
import { translatorFor } from "#src/lib/language.ts";
import styles from "#src/components/layout.module.css";

type Config = Readonly<Record<string, unknown>>;

type TypeFieldProps = Readonly<{
  language: Language;
  config: Config;
  disabled: boolean;
  change: (config: Config) => void;
}>;

const str = (value: unknown): string => (typeof value === "string" ? value : "");

function ScanQrFields({ language }: TypeFieldProps) {
  return <p className={styles.muted}>{translatorFor(language)("quests.scanQrNote")}</p>;
}

/** The code players type, and where the team shows it. Members see the code; players never do. */
function EnterCodeFields({ language, config, disabled, change }: TypeFieldProps) {
  const t = translatorFor(language);
  const hint = (config["hint"] ?? {}) as Readonly<{ ar?: string; en?: string }>;
  const setHint = (key: "ar" | "en", value: string) => {
    const next = { ...hint, [key]: value === "" ? undefined : value };
    const empty = next.ar === undefined && next.en === undefined;
    const rest = Object.fromEntries(Object.entries(config).filter(([name]) => name !== "hint"));
    change(empty ? rest : { ...rest, hint: next });
  };
  return (
    <>
      <label className={styles.field}>
        {t("quests.field.code")}
        <input
          className={styles.input}
          dir="ltr"
          required
          pattern="[A-Za-z0-9]{4,32}"
          autoCapitalize="characters"
          value={str(config["code"])}
          disabled={disabled}
          onChange={(event) => change({ ...config, code: event.target.value.toUpperCase() })}
        />
      </label>
      <p className={styles.muted}>{t("quests.field.codeHint")}</p>
      {(["ar", "en"] as const).map((key) => (
        <label key={key} className={styles.field}>
          {t(key === "ar" ? "quests.field.hintAr" : "quests.field.hintEn")}
          <input
            className={styles.input}
            dir={key === "ar" ? "rtl" : "ltr"}
            maxLength={200}
            value={str(hint[key])}
            disabled={disabled}
            onChange={(event) => setHint(key, event.target.value)}
          />
        </label>
      ))}
    </>
  );
}

/**
 * The form fields each quest type adds (FR-1505). Typed by the registry's keys, so a type added to the registry
 * without its fields here fails the type check.
 */
export const QUEST_TYPE_FIELDS: Readonly<Record<QuestType, (props: TypeFieldProps) => ReactNode>> =
  {
    scan_qr: ScanQrFields,
    enter_code: EnterCodeFields,
  };
